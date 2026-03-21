# presence-sdk

Presence SDK — service integration layer for Presence Signal Spec v0.4.

Wraps `presence-verifier` with:
- challenge nonce creation + issuance
- transport parsing for HTTP/JSON requests
- service policy wiring
- persistent linkage lifecycle for linked Presence accounts
- unlink / revoke / relink / recovery primitives
- readiness decisions for linked accounts
- audit trail and persistence adapters for server-side authoritative truth
- reference pluggable stores, including a filesystem-backed example

Based on:
- Presence Signal Spec v0.4
- Presence Verifier Spec v0.4
- Presence Android Platform Appendix v0.1

---

## Phase 4 status

This package now models Presence more like a **real linked auth product flow**.

What exists now:
- one-time initial **link session** creation
- explicit **linked proof request** creation for already-linked accounts
- persistent **service binding** records per service/account
- persistent **linked device** records keyed by `iss`
- **unlink**, **device revoke**, and **relink/recovery** primitives
- **binding mismatch** handling with recovery guidance
- **audit event** trail for linkage lifecycle changes
- `FileSystemLinkageStore` as a DB-like reference adapter beyond in-memory
- `RedisLinkageStore` as a multi-instance reference persistence adapter
- standardized backend **completion endpoint** helpers and response shapes
- practical **QR/deeplink completion metadata** for product handoff architecture

Still intentionally out of scope:
- full scanner/native QR stack
- production RDBMS migrations
- hosted notification delivery

---

## Installation

```bash
npm install
```

---

## What this package is for

`presence-sdk` is the **service/backend integration layer** for Presence.

Use it when you need to:
- create account link sessions
- verify PASS proofs for already-linked accounts
- persist binding/device state
- compute server-side readiness for access decisions
- expose a practical backend API surface for mobile + service integration

Do **not** think of it as a stand-alone verifier or a mobile client package.
Its role is to sit between:
- the Presence app that produces proofs
- the verifier that validates them
- the service backend that stores authoritative truth

If you are trying to understand the full product split, also read:
- `../docs/presence-integration-quickstart.md`
- `../docs/presence-public-architecture.md`
- `../presence-mobile/README.md`
- `../presence-verifier/README.md`

---

## Quick start

```ts
import {
  PresenceClient,
  FileSystemLinkageStore,
  fileLinkageStorePath,
  createCompletionSessionResponse,
  createLinkedProofRequestResponse,
} from "presence-sdk";

const endpointContract = {
  createSessionPath: "/presence/link-sessions",
  completeSessionPath: "/presence/link-sessions/:sessionId/complete",
  sessionStatusPath: "/presence/link-sessions/:sessionId",
  linkedNoncePath: "/presence/linked-accounts/:accountId/nonce",
  verifyLinkedAccountPath: "/presence/linked-accounts/:accountId/verify",
  linkedStatusPath: "/presence/linked-accounts/:accountId/status",
  unlinkAccountPath: "/presence/linked-accounts/:accountId/unlink",
};

const presence = new PresenceClient({
  serviceId: "discord-bot",
  linkageStore: new FileSystemLinkageStore(
    fileLinkageStorePath("./var/presence")
  ),
  iosAppId: "TEAMID.com.example.polapp",
  androidPackageName: "com.example.polapp",
  bindingPolicy: {
    allowReplacementOnMismatch: true,
    allowRelinkAfterUnlink: true,
  },
  policy: {
    max_attestation_age: 600,
    max_state_age: 86400,
  },
});

export async function createLinkSessionHandler(req) {
  const { session } = await presence.createLinkSession({
    accountId: req.body.accountId,
  });

  return createCompletionSessionResponse({
    session,
    contract: endpointContract,
  });
}

export async function createLinkedProofRequestHandler(req, res) {
  const proofRequest = await presence.createLinkedProofRequest({
    accountId: req.params.accountId,
  });

  if (proofRequest.ok) {
    return res.json(
      createLinkedProofRequestResponse({
        binding: proofRequest.binding,
        nonce: proofRequest.nonce,
        contract: endpointContract,
      })
    );
  }

  switch (proofRequest.state) {
    case "missing_binding":
      return res.status(404).json({
        ok: false,
        code: "ERR_BINDING_NOT_FOUND",
        state: proofRequest.state,
        message: proofRequest.reason,
      });
    case "unlinked":
    case "revoked":
    case "recovery_pending":
      return res.status(409).json({
        ok: false,
        code: "ERR_LINKED_PROOF_UNAVAILABLE",
        state: proofRequest.state,
        bindingId: proofRequest.binding?.bindingId,
        message: proofRequest.reason,
      });
    default:
      return res.status(409).json({
        ok: false,
        code: "ERR_LINKED_PROOF_UNAVAILABLE",
        state: proofRequest.state,
        bindingId: proofRequest.binding?.bindingId,
        message: proofRequest.reason,
      });
  }
}
```

Use `../docs/presence-integration-quickstart.md` as the canonical endpoint and state reference for the full link-once, stay-linked, request-PASS flow. The runnable handler layout lives in `examples/backend-completion-reference.ts`.

---

## Public integration model

Presence works as a split system:

- **Presence app** measures health signals and produces proof material
- **presence-verifier** verifies proof correctness
- **presence-sdk** manages linkage, readiness, audit, and persistence on the backend
- **your service backend** uses the SDK's outputs as authoritative account state

That means the final service decision should not be based on app-local UI alone.
The recommended authority is the backend state maintained through `presence-sdk`.

---

## Persistent linkage model

### Core entities

- **LinkSession** — one-time bootstrap challenge used to attach a device to a service account
- **LinkedDevice** — durable device identity keyed by `iss`
- **ServiceBinding** — persistent relationship between `{serviceId, accountId}` and a linked device
- **PresenceSnapshot** — most recent verified PASS snapshot captured during verification
- **LinkageAuditEvent** — append-only event trail for lifecycle and recovery actions

### Lifecycle

1. Service creates a **link session** and issues a nonce.
2. Product UI renders a **QR code** or **deeplink** derived from `session.completion`.
3. Mobile app proves Presence once for that session.
4. SDK verifies the proof and persists:
   - consumed link session
   - linked device record
   - service binding
   - latest presence snapshot
   - audit event
5. Later proofs are evaluated against the existing binding until unlinked or revoked.
6. If a proof arrives from the wrong `iss`, the SDK can move the binding into recovery and optionally mint a relink session.

---

## API additions

### `createLinkSession(options)`

Creates a one-time session + nonce for initial account linking or relink bootstrap.

### `completeLinkSession({ sessionId, body })`

Verifies the mobile payload using the session nonce and persists linked entities on success.

### `verifyLinkedAccount(body, { serviceId?, accountId, nonce })`

Verifies a PASS proof against an already-linked account.

Possible outcomes:
- success with updated snapshot
- standard verifier failure
- `ERR_BINDING_RECOVERY_REQUIRED` with `recoveryAction`

### `createLinkedProofRequest({ serviceId?, accountId })`

Looks up the active linked binding for an account and issues a fresh nonce for a
service-driven PASS request.

Recommended usage:
- call this when your service needs human proof for a gated action
- return `createLinkedProofRequestResponse()` from `POST /presence/linked-accounts/:accountId/nonce`
- hand the resulting `proofRequest` descriptor to product UI
- have the app submit PASS to `verifyLinkedAccount()`

Return shape:
- `ok: true` with `binding` + fresh `nonce` when the account is linked and eligible
- `ok: false, state: "missing_binding"` when nothing is linked for that account
- `ok: false` with `state: "unlinked" | "revoked" | "recovery_pending"` when a binding exists but should not accept a fresh PASS request
- the normalized HTTP success shape is `{ ok: true, proofRequest: { flow: "reauth", bindingId, nonce, endpoints } }`

### `getLinkedAccountReadiness({ serviceId?, accountId, now?, maxSnapshotAgeSeconds? })`

Returns the service-side linked account readiness decision that should gate access.

Recommended usage:
- treat `ready: true` as the only pass condition
- treat `state: "stale"` as a recently verified PASS that fell out of the ordinary ready state but may still be covered by a short service grace policy
- treat `state: "not_ready"` as a state where no backend-accepted PASS is currently available
- treat `state: "recovery_pending"` as an explicit mismatch/recovery condition that should block access until resolved

Important clarification:
- a linked binding existing is **not** the same thing as the account being currently ready
- the linked account becomes ready only when the backend has a verified PASS snapshot that satisfies current policy
- if app-local state and backend readiness disagree, backend readiness should win

### `unlinkAccount({ serviceId?, accountId, reason? })`

Marks the binding as `unlinked` and records an audit event.

### `revokeDevice({ deviceIss, reason? })`

Marks the linked device as revoked and revokes all bindings on that device.

### `listAuditEvents(filter?)`

Returns linkage lifecycle events for analytics, ops review, or user history.

---

## Store requirements

```ts
interface LinkageStore {
  saveLinkSession(session: LinkSession): Promise<void>;
  getLinkSession(sessionId: string): Promise<LinkSession | null>;
  saveServiceBinding(binding: ServiceBinding): Promise<void>;
  getServiceBinding(serviceId: string, accountId: string): Promise<ServiceBinding | null>;
  listBindingsForDevice(deviceIss: string): Promise<ServiceBinding[]>;
  getLinkedDevice(deviceIss: string): Promise<LinkedDevice | null>;
  saveLinkedDevice(device: LinkedDevice): Promise<void>;
  appendAuditEvent(event: LinkageAuditEvent): Promise<void>;
  listAuditEvents(filter?: ...): Promise<LinkageAuditEvent[]>;
}
```

Included adapters:
- `InMemoryLinkageStore` — tests/dev only
- `FileSystemLinkageStore` — reference persistent adapter backed by JSON on disk
- `RedisLinkageStore` — reference adapter for shared backend state using a minimal Redis client contract

`FileSystemLinkageStore` is not meant as a final production DB, but it demonstrates the persistence contract and recovery/audit shapes without staying in-memory.
`RedisLinkageStore` is still intentionally simple, but it shows how Presence linkage can move to a real multi-instance backend without tying the SDK to one Redis package.

### Current filesystem-store guarantees

The filesystem-backed store now explicitly aims to protect **authoritative server truth** better than a naive JSON file write path.
It now:
- rejects corrupted JSON rather than silently treating it as an empty store
- writes through a temp file + sync + rename path
- serializes mutations per store path
- keeps `mutate()` operations within one staged persistence boundary

That makes it much safer as a reference store than a simple read/modify/write example, but it is still a file-backed reference adapter rather than a final production database.

---

## Re-auth, mismatch, and recovery

Recommended service behavior:

- **Fresh re-auth**: request a new nonce and call `verifyLinkedAccount()`.
- **Binding mismatch** (`iss` changed): return recovery UI and, if policy allows, issue a relink session.
- **User-initiated unlink**: call `unlinkAccount()` and remove the account from active sign-in surfaces.
- **Fraud/device compromise**: call `revokeDevice()` so all related bindings require recovery.

The product distinction is:
- re-auth = same device proves again
- relink = same account binds a new or replaced device
- recovery = operator/user flow that resolves mismatch or revocation safely

---

## Backend completion endpoint contract

Recommended backend surface:

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

The SDK now includes response helpers for these shapes:
- `createCompletionSessionResponse()`
- `createCompletionSuccessResponse()`
- `createRecoveryResponse()`
- `createAuditEventsResponse()`
- `createLinkedProofRequestResponse()`
- `createLinkedAccountReadinessResponse()`

See `examples/backend-completion-reference.ts` for a practical handler layout.
Use `../docs/presence-integration-quickstart.md` as the canonical flow/state guide.

## QR / deeplink completion architecture

Minimal reference model in this phase:

1. Backend creates `LinkSession`.
2. Backend exposes `session.completion.qrUrl` and/or `session.completion.deeplinkUrl`.
3. Web or desktop client renders QR.
4. Mobile app opens the deeplink and extracts:
   - `session_id`
   - `service_id`
   - optional `service_domain`
   - optional `binding_id`
   - optional `flow`
   - optional fallback `code`
   - optional `nonce_url`, `verify_url`
5. If the deeplink/session includes sync URLs like `nonce_url` or `verify_url`, mobile should validate them against `https://{service_domain}/.well-known/presence.json` before proof submission.
6. Mobile produces proof and posts to `session.completion.completionApiUrl` or the standardized completion endpoint.
7. Later, when the service needs PASS for a linked account, backend calls `createLinkedProofRequest()` and returns a normalized `/presence/linked-accounts/:accountId/nonce` response containing:
   - fresh nonce
   - linked binding id
   - verify/status endpoint metadata
8. Mobile submits PASS to `verifyLinkedAccountApiUrl` for that linked account.
9. Mobile may still retry failed linked PASS submissions on foreground/background wake as best-effort catch-up.
10. Service calls `completeLinkSession()`, `verifyLinkedAccount()`, or `getLinkedAccountReadiness()` and returns a normalized linked/recovery/readiness payload.

This is enough to wire real product UX without building scanner/native camera stack yet.

---

## Background / lifecycle expectations

For service integrators, one subtle but important point is that the mobile app and backend play different roles.

- The app can measure, prove, and attempt sync.
- The backend decides whether a linked account is currently ready.
- Background execution behavior on iOS is best-effort, not an unconditional guarantee.

That means a Presence integration should be designed around:
- strong foreground correctness
- strong foreground-resume recovery
- best-effort background catch-up where platform conditions allow it
- explicit backend readiness checks

Do not assume that a background-capable mobile app will keep PASS ready on a fixed schedule without a user request or foreground recovery.

---

## Trust metadata checklist

If you emit `service_domain`, `nonce_url`, or `verify_url` in deeplinks or session completion metadata:

- `https://{service_domain}/.well-known/presence.json` must be publicly reachable over HTTPS
- `service_id` in the well-known JSON must match the emitted `service_id`
- `allowed_url_prefixes` must cover the emitted `nonce_url` and `verify_url`
- well-known responses should use cache headers that will not pin stale metadata during rollout or debugging

---

## Production checklist

- [ ] Replace in-memory nonce handling with a persistent managed store
- [ ] Replace `InMemoryTofuStore` with a persistent DB-backed implementation
- [ ] Replace `FileSystemLinkageStore` with your real DB adapter
- [ ] Always send explicit top-level `platform`
- [ ] Set `iosAppId` and/or `androidPackageName`
- [ ] Complete platform attestation integration in `presence-verifier`
- [ ] Enforce `getLinkedAccountReadiness()` or equivalent readiness gating before granting access
- [ ] Add user-facing notification UX around revoke / relink

---

## Build & test

```bash
cd ../presence-verifier && npm install && npm run build && npm test
cd ../presence-sdk && npm run build && npm test
```

`npm test` now includes a local HTTP reference-server round-trip that exercises:
- `POST /presence/link-sessions`
- `POST /presence/link-sessions/:sessionId/complete`
- `POST /presence/linked-accounts/:accountId/nonce`
- `POST /presence/linked-accounts/:accountId/verify`

So you can verify the end-to-end linkage flow locally: create session -> app proof -> complete -> binding saved -> request PASS now -> verify linked account.

---

## License

MIT
