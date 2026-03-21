# Presence integration quickstart

This is the canonical service integration path for Presence.

Use this model everywhere:

- link once via deeplink or QR
- stay linked
- when the service needs human proof, call `createLinkedProofRequest()`
- user opens Presence and taps proof
- app submits PASS to the service backend
- backend verifies and allows or denies the action

If local app state and backend state disagree, the backend wins.

---

## What you need

You need three moving parts:

1. **Presence mobile app**
   - reads on-device health signals
   - evaluates PASS / FAIL locally
   - produces proof material

2. **`presence-sdk` on your backend**
   - creates link sessions
   - creates linked proof requests for already-linked accounts
   - verifies link completions and linked-account proofs
   - persists bindings, devices, snapshots, and audit events
   - computes linked-account readiness

3. **Your service backend / product UI**
   - presents QR or deeplink linking UX
   - opens Presence when proof is needed
   - gates access on backend readiness

---

## Endpoint surface

This is the minimal backend surface a developer should implement:

```text
POST /presence/link-sessions
GET  /presence/link-sessions/:sessionId
POST /presence/link-sessions/:sessionId/complete
POST /presence/linked-accounts/:accountId/nonce
POST /presence/linked-accounts/:accountId/verify
GET  /presence/linked-accounts/:accountId/status
POST /presence/linked-accounts/:accountId/unlink
POST /presence/devices/:deviceIss/revoke
GET  /presence/audit-events
```

Recommended meaning:

- `POST /presence/link-sessions` creates the one-time initial link session.
- `GET /presence/link-sessions/:sessionId` lets product UI poll or inspect session state.
- `POST /presence/link-sessions/:sessionId/complete` verifies the first proof and persists the binding.
- `POST /presence/linked-accounts/:accountId/nonce` is the canonical "service needs PASS now" endpoint.
- `POST /presence/linked-accounts/:accountId/verify` verifies a PASS proof for an already-linked account.
- `GET /presence/linked-accounts/:accountId/status` returns authoritative readiness for gating.
- `POST /presence/linked-accounts/:accountId/unlink` removes the binding.
- `POST /presence/devices/:deviceIss/revoke` revokes a device across bindings.
- `GET /presence/audit-events` exposes lifecycle history for ops/debugging.

---

## 1. Link once

Your backend creates a one-time session and returns normalized completion metadata:

```ts
const { session } = await presence.createLinkSession({
  accountId: "user_123",
});

return createCompletionSessionResponse({
  session,
  contract: endpointContract,
});
```

Your product UI renders `session.completion.qrUrl` or `session.completion.deeplinkUrl`.

The app then:

1. Opens the session from the deeplink or QR payload.
2. Evaluates PASS locally.
3. Produces proof bound to the session nonce.
4. Posts the proof to `POST /presence/link-sessions/:sessionId/complete`.

Your backend completes the link with:

```ts
const result = await presence.completeLinkSession({
  sessionId: req.params.sessionId,
  body: req.body,
});
```

On success, the SDK persists:

- the consumed link session
- the linked device
- the service binding
- the latest verified PASS snapshot
- an audit event

At that point the account is linked, but you should still gate access on readiness, not on "binding exists".

---

## 2. Request PASS for an already-linked account

When the service needs human proof for an already-linked account, call `createLinkedProofRequest()`:

```ts
const request = await presence.createLinkedProofRequest({
  accountId: req.params.accountId,
});

if (request.ok) {
  return createLinkedProofRequestResponse({
    binding: request.binding,
    nonce: request.nonce,
    contract: endpointContract,
  });
}

switch (request.state) {
  case "missing_binding":
    return {
      status: 404,
      body: {
        ok: false,
        code: "ERR_BINDING_NOT_FOUND",
        state: request.state,
        message: request.reason,
      },
    };
  case "unlinked":
  case "revoked":
  case "recovery_pending":
    return {
      status: 409,
      body: {
        ok: false,
        code: "ERR_LINKED_PROOF_UNAVAILABLE",
        state: request.state,
        bindingId: request.binding?.bindingId,
        message: request.reason,
      },
    };
}
```

`createLinkedProofRequest()` returns this union:

```ts
type CreateLinkedProofRequestResult =
  | {
      ok: true;
      state: "linked";
      binding: ServiceBinding;
      nonce: {
        value: string;
        issuedAt: number;
        expiresAt: number;
      };
    }
  | {
      ok: false;
      state: "missing_binding" | "unlinked" | "revoked" | "recovery_pending";
      binding: ServiceBinding | null;
      reason: string;
    };
```

The canonical `POST /presence/linked-accounts/:accountId/nonce` success shape is the helper output from `createLinkedProofRequestResponse()`:

```json
{
  "ok": true,
  "proofRequest": {
    "flow": "reauth",
    "serviceId": "discord-bot",
    "accountId": "user_123",
    "bindingId": "pbind_123",
    "nonce": "base64url_nonce",
    "issuedAt": 1710000000,
    "expiresAt": 1710000300,
    "endpoints": {
      "verify": { "method": "POST", "path": "/presence/linked-accounts/user_123/verify" },
      "status": { "method": "GET", "path": "/presence/linked-accounts/user_123/status" },
      "unlink": { "method": "POST", "path": "/presence/linked-accounts/user_123/unlink" }
    }
  }
}
```

That is the canonical "service-driven PASS request" contract. Use it instead of inventing a second renewal-specific flow.

---

## 3. What the app does during a linked PASS request

After your backend returns the linked proof request:

1. Product UI opens Presence from a deeplink, QR, or explicit "Open Presence" action.
2. If the request carries `nonce_url` or `verify_url`, the app validates them against `https://{service_domain}/.well-known/presence.json`.
3. The app evaluates PASS locally on device.
4. If the local check is FAIL, the app does not push a separate upstream `not_ready` event. It keeps that failure local and prompts the user to try again later.
5. If the local check is PASS, the app creates proof and posts it to the verify endpoint.
6. The app sends the nonce separately, typically in `x-presence-nonce`.

This keeps the public product model simple:

- the service decides when proof is needed
- the app measures PASS locally and submits proof
- the backend remains authoritative

---

## 4. Verify PASS and gate the action

Your verify handler should call `verifyLinkedAccount()`:

```ts
const result = await presence.verifyLinkedAccount(req.body, {
  accountId: req.params.accountId,
  nonce: req.nonce,
});

if (result.verified) {
  return {
    ok: true,
    state: "linked",
    binding: result.binding,
    snapshot: result.snapshot,
  };
}

if (result.error === "ERR_BINDING_RECOVERY_REQUIRED") {
  return createRecoveryResponse(result);
}

return {
  ok: false,
  code: result.error,
  message: result.detail,
};
```

After a successful verify:

- the backend updates the authoritative snapshot
- the current action may proceed
- later checks should still use `getLinkedAccountReadiness()`

Recommended access rule:

- only `ready: true` means allow by default

---

## 5. States to handle

You need to handle two different state surfaces.

`createLinkedProofRequest()` states:

- `linked`: proof can be requested right now
- `missing_binding`: account is not linked; prompt initial link
- `unlinked`: prior binding was intentionally removed; require relink
- `revoked`: linked device is revoked; block and drive recovery or support flow
- `recovery_pending`: mismatch or reauth/relink is already required; block until recovery completes

`getLinkedAccountReadiness()` states:

- `ready`: backend has a currently acceptable verified PASS snapshot
- `stale`: binding exists but the last accepted snapshot is missing, too old, or only within grace
- `not_ready`: backend has no currently acceptable PASS snapshot
- `missing_binding`: account has never been linked or linkage was lost
- `unlinked`: binding was intentionally removed
- `revoked`: device was revoked
- `recovery_pending`: mismatch or recovery flow is in progress

Important distinction:

- linked does not mean ready
- app-local PASS does not mean server-ready

The service should store at minimum:

- the linked account binding
- the linked device identity
- the latest verified PASS snapshot
- an audit trail

---

## iOS lifecycle reality

Foreground and foreground-resume flows can be made highly reliable.
Background execution is best-effort.
Force-quit survival should not be treated as guaranteed.

So Presence on iOS should be designed around:

- strong foreground correctness
- strong resume recovery
- best-effort background catch-up
- explicit server proof gating

---

## Canonical references

Use these files together:

- `presence-sdk/examples/backend-completion-reference.ts`
- `presence-sdk/examples/local-reference-server.js`
- `presence-sdk/README.md`
- `presence-mobile/README.md`
- `docs/presence-public-architecture.md`
