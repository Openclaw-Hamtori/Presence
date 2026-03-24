# Presence integration quickstart

This is the canonical service integration path for Presence.

### Canonical product flow

The current primary product path is:

`link once -> service requests PASS -> user opens Presence -> pending request hydrates -> user taps orb -> fresh proof -> server verify`

In practice this maps to:

1. User links once via QR/deeplink (`POST /presence/link-sessions` -> completion).
2. The account becomes linked and persists on the backend.
3. Later, when your service needs a human check, it creates a pending proof request (`POST /presence/linked-accounts/:accountId/pending-proof-requests`) and stores it server-side.
4. User opens Presence (icon/notification/app link), which hydrates pending work.
5. User taps the orb.
6. Presence generates fresh proof bound to request nonce.
7. Server verifies it and updates authoritative readiness (`POST /presence/pending-proof-requests/:requestId/respond`).

### Important TTL caveat

Pending proof requests are durable server-side request records, but the proof challenge nonce is still short-lived.
In the reference stack, that usually means roughly **5 minutes** unless you deliberately change nonce policy.

Practical implication:
- a pending request should be treated as **"respond soon or reissue"**, not as an indefinitely valid proof ticket
- if the user opens Presence after the nonce aged out, your service should mint a fresh request rather than assume the old one can still complete

This is also the path we use as the recommended integration standard.

Push/APNs is not part of the canonical path. It is optional and experimental
(best-effort wake only). Product correctness must work without it.

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


## Endpoint surface

This is the minimal backend surface a developer should implement:

```text
POST /presence/link-sessions
GET  /presence/link-sessions/:sessionId
POST /presence/link-sessions/:sessionId/complete
POST /presence/linked-accounts/:accountId/nonce
POST /presence/linked-accounts/:accountId/pending-proof-requests
GET  /presence/linked-accounts/:accountId/pending-proof-requests
POST /presence/linked-accounts/:accountId/verify
GET  /presence/pending-proof-requests/:requestId
POST /presence/pending-proof-requests/:requestId/respond
GET  /presence/linked-accounts/:accountId/status
POST /presence/linked-accounts/:accountId/unlink
POST /presence/devices/:deviceIss/revoke
GET  /presence/devices/:deviceIss/bindings
GET  /presence/audit-events
```

Recommended meaning:

- `POST /presence/link-sessions` creates the one-time initial link session.
- `GET /presence/link-sessions/:sessionId` lets product UI poll or inspect session state.
- `POST /presence/link-sessions/:sessionId/complete` verifies the first proof and persists the binding.
- `POST /presence/linked-accounts/:accountId/nonce` is the canonical "service needs PASS now" endpoint.
- `POST /presence/linked-accounts/:accountId/pending-proof-requests` creates a durable server-side pending request for a linked account.
- `GET /presence/linked-accounts/:accountId/pending-proof-requests` lists active pending requests for a linked account.
- `POST /presence/linked-accounts/:accountId/verify` verifies a PASS proof for an already-linked account.
- `GET /presence/pending-proof-requests/:requestId` inspects one pending request by id.
- `POST /presence/pending-proof-requests/:requestId/respond` verifies a PASS proof against the stored pending-request nonce.
- `GET /presence/linked-accounts/:accountId/status` returns authoritative readiness for gating.
- `POST /presence/linked-accounts/:accountId/unlink` removes the binding.
- `POST /presence/devices/:deviceIss/revoke` revokes a device across bindings.
- `GET /presence/devices/:deviceIss/bindings` exposes authoritative bindings for device-centric hydration/admin views.
- `GET /presence/audit-events` exposes lifecycle history for ops/debugging.

## Server env + routing reality (happy path)

If you use `presence-happy-path/app/server.cjs` or the same pattern, these settings are the source of most route confusion:

- `ROUTE_BASE_PATH`
- `PUBLIC_BASE_URL`
- `PRESENCE_SERVICE_DOMAIN`
- `PRESENCE_SERVICE_API_KEY` (optional)
- `PRESENCE_CLEANUP_INTERVAL_SECONDS`

### `ROUTE_BASE_PATH`

The reference server strips this prefix from inbound request paths before matching routes.

Example:
- `ROUTE_BASE_PATH=/api` and request to `/api/presence/link-sessions`
- internal `requestPath` becomes `/presence/link-sessions`
- route handlers still register `/presence/*` paths

This is for when your service is mounted under a proxy path (API gateway, Cloudflare, etc.) and lets you keep backend contracts stable.

### `PUBLIC_BASE_URL`

Used when generating links returned to mobile/UI via `rewriteLinkSessionForPublicBase()` and in helper endpoint absolutization logic.

- Should be the public HTTPS/HTTP origin users and mobile actually reach (`https://presence.example.com`), not just the process bind host/port.
- It is prefixed onto relative session/completion/proof-request paths.
- If this is wrong, mobile may get unreachable callbacks even though server routes are valid.

### `PRESENCE_SERVICE_DOMAIN` and `/.well-known/presence.json`

This value drives trust metadata for deeplink validation:

- `/.well-known/presence.json` is served as `https://{PRESENCE_SERVICE_DOMAIN}/.well-known/presence.json` only when `PRESENCE_SERVICE_DOMAIN` is set.
- `rewriteLinkSessionForPublicBase()` adds `service_domain` to link/deeplink metadata when provided, and infers it from an HTTPS `PUBLIC_BASE_URL` if omitted.
- For a secure mobile trust path, set `PRESENCE_SERVICE_DOMAIN` explicitly to your public HTTPS host. If you keep it blank and use non-HTTPS `PUBLIC_BASE_URL`, link sessions are rejected at runtime with a clear `ERR_MOBILE_TRUST_CONFIG` error.
- `allowed_url_prefixes` from well-known must cover the absolute URLs you emit (e.g., `https://presence.example.com/presence`).
- The app checks hydrated sync URLs against well-known before it uses `nonce_url` / `verify_url` / `pending_url`.
- Verify a freshly minted completion by checking the returned `qrUrl` contains `service_domain=<your-public-host>`, and that the hydrated completion metadata contains absolute `nonce_url`/`verify_url` under that host.

For the server-local path map:

- Server-internal routes remain `/presence/*`.
- Public links and trust checks should remain aligned to `PUBLIC_BASE_URL` + `/presence`.
- Don’t mix `ROUTE_BASE_PATH` into `allowed_url_prefixes`; keep trust prefixes on the public API base that mobile receives.

## Flow semantics (initial_link / reauth / relink / recovery)

The current production intent is:

- `initial_link`: first bind of this service/account to a device
- `reauth`: same linked device proving again for a linked account
- `relink`: replacing or re-establishing a binding after device/account mismatch or explicit replacement flow
- `recovery`: user/operator recovery path after unlink, revoke, or mismatch handling

Important runtime rule:
- explicit non-reauth flow is authoritative
- if a link/session payload explicitly says `initial_link`, Presence should not silently reuse existing linked-binding state and drift into linked verify behavior
- in the hardened production path, explicit `initial_link` also suppresses `bindingHint` in prove/completion routing so first-link semantics stay clean

Legacy note:
- older payloads that omit `flow` entirely may still require compatibility handling
- when debugging modern mobile behavior, prefer explicit `flow` values and treat them as the canonical contract

## Identity model (serviceId / serviceDomain / public URL)

Presence identifiers are easy to mix up; keep these roles separate:

- **`serviceId`**: backend identity used for linkage records and proofs. Think of it as a contract key (`presence-demo`, `health-coach`).
- **`serviceDomain`**: public trust host for mobile validation (the host in `https://{serviceDomain}/.well-known/presence.json`).
- **`PUBLIC_BASE_URL`**: public origin used for endpoint URLs inside completion payloads (`PUBLIC_BASE_URL` + `/presence/...`).
- **display name**: human-facing service label (not standardized yet in protocol); if unavailable, UI should avoid showing raw UUID-like IDs and prefer friendlier host-derived text.

`serviceId` can stay stable while `serviceDomain` and display label move independently as deployments or branding changes.

## Service auth (reference posture)

The reference server defaults to a **demo posture** for local/dev workflows. In this default, service-owned routes are intentionally easier to use, but less secure.

To run a hardened mode, set both:
- `PRESENCE_SERVICE_API_KEY=<random-long-secret>`
- `PRESENCE_REFERENCE_AUTH_MODE=strict`

In strict mode, the reference server protects service-owned operations with either:
- `Authorization: Bearer <key>`
- `x-presence-service-api-key: <key>`

Protected routes (server-only operations):
- all `/presence/*` handlers except callback endpoints listed below
- `POST /presence/link-sessions`
- `GET /presence/link-sessions/:sessionId`
- `POST /presence/linked-accounts/:accountId/nonce`
- `POST /presence/linked-accounts/:accountId/pending-proof-requests`
- `GET /presence/linked-accounts/:accountId/pending-proof-requests`
- `GET /presence/linked-accounts/:accountId/status`
- `POST /presence/linked-accounts/:accountId/unlink`
- `POST /presence/devices/:deviceIss/revoke`
- `GET /presence/devices/:deviceIss/bindings`
- `GET /presence/audit-events`
- `GET /presence/pending-proof-requests/:requestId`

The public callback/deep-link endpoints remain open by design to support the user device flow:
- `POST /presence/link-sessions/:sessionId/complete`
- `POST /presence/linked-accounts/:accountId/verify`
- `POST /presence/pending-proof-requests/:requestId/respond`

`PRESENCE_REFERENCE_AUTH_MODE` can also be left unset/`demo` for local/dev use.

## Expired nonce/request cleanup sweep (reference servers)

Small deployments often forget to run periodic cleanup, so the reference servers now self-sweep:

- set `PRESENCE_CLEANUP_INTERVAL_SECONDS` (seconds) to enable periodic cleanup of expired local-reference state.
- default: `300` (5 minutes)
- set `0` to disable automatic sweeping (manual cleanup remains available)

The sweep calls `presence.cleanupPersistedNonces()` on a timer and currently clears:
- in-memory tracked nonces
- SQLite-backed pending-link/pending-proof state (via sqlite-backed `PersistedNonceStore`)
- no-op for pure in-memory/file stores where persisted state isn't centrally indexable

`/health` on both `presence-happy-path/app/server.cjs` and `presence-sdk/examples/local-reference-server.js` reports:
- `cleanup.enabled`
- `cleanup.intervalSeconds`
- `cleanup.runAtStartup`

This keeps cleanup behavior predictable without external cron jobs for the local/reference deployment path.

---

## Request validation and malformed-request contract

Reference server handlers now enforce a stricter parse contract for JSON entry points in this release round:

- `ERR_INVALID_JSON` for malformed JSON documents,
- `ERR_INVALID_BODY` when a request body is valid JSON but not an object,
- `ERR_EMPTY_BODY` when a required JSON body is missing,
- `ERR_INVALID_PATH_PARAM` when a URL path parameter cannot be safely decoded.

For deployment readiness, treat these as low-risk hardening checks and keep response shape stable (`{ ok:false, code, message }`) so clients can reliably route invalid input cases.

Add this to your production checklists:

- smoke malformed payload samples against service-owned endpoints,
- monitor parse-failure rates in logs and alert on spikes,
- ensure callback endpoints (`.../complete`, `/verify`, `/respond`) remain publicly reachable but are still protected against body abuse.

---

## 1. Link once

Your backend creates a one-time session and returns normalized completion metadata:

```ts
const { session } = await presence.createLinkSession({
  accountId: "user_123",
});

return createCompletionSessionResponse({
  session: rewriteLinkSessionForPublicBase(session, {
    publicBaseUrl: "https://presence.example.com",
    serviceDomain: "presence.example.com",
  }),
  contract: endpointContract,
});
```

Your product UI renders `session.completion.qrUrl` or `session.completion.deeplinkUrl`.
Use `rewriteLinkSessionForPublicBase()` before returning session completion metadata to mobile or web UI; the default helper emits backend-relative API paths that mobile will reject.

The app then:

1. Opens the session from the deeplink or QR payload.
2. Calls `GET /presence/link-sessions/:sessionId` to hydrate full completion metadata and finalize nonce issuance timing.
3. Evaluates PASS locally and binds proof generation to the hydrated `nonce` in the session metadata.
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
The stable wire label remains `flow: "reauth"` for this linked proof request shape; treat it as "service requested PASS now" in product/UI copy.

### `/.well-known/presence.json` contract

If you emit `service_domain` plus public `nonce_url`, `verify_url`, or `pending_url` metadata to mobile, publish:

```text
GET https://{service_domain}/.well-known/presence.json
```

Minimum contract:

```json
{
  "version": "1",
  "service_id": "discord-bot",
  "allowed_url_prefixes": [
    "https://presence.example.com/presence"
  ]
}
```

Backend rules:

- `service_id` must exactly match the `service_id` associated with the session metadata you hand to the hydrated session payload.
- `allowed_url_prefixes` must cover every public absolute `nonce_url`, `verify_url`, `pending_url`, and pending-request respond/status URL handed to mobile.
- `nonce_url`, `verify_url`, and `status_url` must already be public absolute URLs before you expose them to mobile; backend-relative paths are rejected at the mobile boundary.
- if you expose pending proof request URLs, prefer a broad prefix like `https://presence.example.com/presence` so both linked-account and pending-request routes stay trusted under one well-known entry.
- Mobile enforces the prefix check for `nonce_url` and `verify_url`; `status_url` still needs to be absolute and publicly reachable.
- Use short-lived cache headers during rollout/debugging so stale trust metadata does not get pinned on device.

### Recovery-required linked proof requests

When `createLinkedProofRequest()` returns `ok: false` with `state: "recovery_pending" | "revoked" | "unlinked"`:

- Do not mint or accept a replacement linked-proof nonce from a side path; the existing linked binding is blocked.
- Return `409` with the normalized unavailable shape and stop the protected action.
- For `recovery_pending`, resume the relink/recovery UX instead of prompting for another ordinary PASS request. Reuse an existing relink session if you already saved one from an earlier `ERR_BINDING_RECOVERY_REQUIRED`; otherwise mint a fresh relink session tied to `request.binding.bindingId` before reopening Presence.
- For `revoked`, treat the device as no longer trusted and drive relink or support review, not a normal reauth retry.
- For `unlinked`, require a new initial link before the next protected action.

### Pending proof requests

If you want "open Presence and tap the orb" without issuing a fresh deeplink each time, add the pending proof request surface:

```text
POST /presence/linked-accounts/:accountId/pending-proof-requests
GET  /presence/linked-accounts/:accountId/pending-proof-requests
GET  /presence/pending-proof-requests/:requestId
POST /presence/pending-proof-requests/:requestId/respond
```

Recommended backend mapping:

- call `presence.createPendingProofRequest()` and return `createPendingProofRequestResponse()` from `POST /presence/linked-accounts/:accountId/pending-proof-requests`
- call `presence.listPendingProofRequests()` and return `createPendingProofRequestListResponse()` from `GET /presence/linked-accounts/:accountId/pending-proof-requests`
- call `presence.getPendingProofRequest()` and return `createPendingProofRequestResponse()` from `GET /presence/pending-proof-requests/:requestId`
- call `presence.respondToPendingProofRequest()` from `POST /presence/pending-proof-requests/:requestId/respond`

These routes keep the server authoritative:

- the backend stores the pending request and its nonce
- the app hydrates pending work from the backend rather than inventing local truth
- the respond route verifies against the stored nonce and marks the request `verified`, `recovery_required`, `expired`, or `cancelled`

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

## Cross-package field aliases

When comparing mobile/test-app local state with backend/sdk records, these names refer to the same logical fields:

- mobile/test-app `activeLinkSession.status: "consumed"` matches sdk `LinkSession.status: "consumed"`; legacy mobile state may still contain `"linked"` and should be treated as the same completed-session meaning.
- mobile/test-app `PresenceSnapshot.source: "measurement" | "proof"` maps to sdk `PresenceSnapshot.source: "local_measurement" | "verified_proof"`.
- mobile/test-app `linkedDevice.linkedAt` maps to sdk `LinkedDevice.firstLinkedAt`.
- mobile/test-app `activeLinkSession.lastNonce` maps to sdk `LinkSession.issuedNonce`.
- mobile/test-app `activeLinkSession.createdAt` maps to sdk `LinkSession.requestedAt`.
- mobile/test-app `ServiceBinding.linkedDeviceIss` maps to sdk `ServiceBinding.deviceIss`.
- mobile/test-app `ServiceBinding.linkedAt` maps to sdk `ServiceBinding.lastLinkedAt`; hydration may fall back to sdk `createdAt` when older records do not carry `lastLinkedAt`.
- `accountId` can be absent in mobile pre-completion link context, but backend/sdk persisted `LinkSession` and `ServiceBinding` records require it.

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

- `docs/README.md`
- `docs/presence-server-routing-guide.md`
- `presence-sdk/examples/backend-completion-reference.ts`
- `presence-sdk/examples/local-reference-server.js`
- `presence-happy-path/app/server.cjs`
- `presence-sdk/README.md`
- `presence-mobile/README.md`
- `docs/presence-public-architecture.md`
- `docs/presence-pending-proof-request-architecture.md`
