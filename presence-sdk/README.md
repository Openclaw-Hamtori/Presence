# presence-sdk

Presence SDK — service integration layer for Presence Signal Spec v0.4.

Wraps `presence-verifier` with:
- challenge nonce creation + issuance
- transport parsing for HTTP/JSON requests
- service policy wiring
- persistent linkage lifecycle for linked Presence accounts
- unlink / revoke / relink / recovery primitives
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

## Quick start

```ts
import {
  PresenceClient,
  FileSystemLinkageStore,
  fileLinkageStorePath,
} from "presence-sdk";

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

const { session, nonce } = await presence.createLinkSession({
  serviceId: "discord-bot",
  accountId: "user_123",
});

// return session.completion.qrUrl or session.completion.deeplinkUrl to your product UI

const linkResult = await presence.completeLinkSession({
  sessionId: session.id,
  body: req.body,
});

if (linkResult.verification.verified) {
  res.json({
    linked: true,
    bindingId: linkResult.binding?.bindingId,
    deviceIss: linkResult.binding?.deviceIss,
  });
}
```

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

Verifies a fresh proof against an already-linked account.

Possible outcomes:
- success with updated snapshot
- standard verifier failure
- `ERR_BINDING_RECOVERY_REQUIRED` with `recoveryAction`

### `getLinkedAccountReadiness({ serviceId?, accountId, now?, maxSnapshotAgeSeconds? })`

Returns the service-side linked account readiness decision that should gate access.

Recommended usage:
- treat `ready: true` as the only pass condition
- treat `state: "stale"` as an expired-but-still-grace-period snapshot
- treat `state: "not_ready"` as a snapshot where no usable fresh PASS remains after grace
- treat `state: "recovery_pending"` as an explicit mismatch/recovery condition that should block access until resolved

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
- `createLinkedAccountReadinessResponse()`

See `examples/backend-completion-reference.ts` for a practical handler layout.

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
5. If the deeplink/session includes sync URLs like `nonce_url` or `verify_url`, mobile should validate them against `https://{service_domain}/.well-known/presence.json` before approval.
6. Mobile produces proof and posts to `session.completion.completionApiUrl` or the standardized completion endpoint.
7. After the first link, mobile can refresh in background by calling:
   - `linkedNonceApiUrl` to mint a fresh nonce
   - `verifyLinkedAccountApiUrl` to submit a fresh PASS proof
7. Mobile persists failed PASS verify attempts locally and retries them on foreground/background wake.
8. Service calls `completeLinkSession()`, `verifyLinkedAccount()`, or `getLinkedAccountReadiness()` and returns a normalized linked/recovery/readiness payload.

This is enough to wire real product UX without building scanner/native camera stack yet.

---

## Production checklist

- [ ] Replace in-memory nonce handling with a persistent managed store
- [ ] Replace `InMemoryTofuStore` with a persistent DB-backed implementation
- [ ] Replace `FileSystemLinkageStore` with your real DB adapter
- [ ] Always send explicit top-level `platform`
- [ ] Set `iosAppId` and/or `androidPackageName`
- [ ] Complete platform attestation integration in `presence-verifier`
- [ ] Enforce `getLinkedAccountReadiness()` or equivalent freshness gating before granting access
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
- `POST /presence/linked-accounts/:accountId/verify`

So you can verify the end-to-end linkage flow locally: create session -> app proof -> complete -> binding saved -> verify linked account.

---

## License

MIT
ost-only
- [ ] `https://{service_domain}/.well-known/presence.json` is publicly reachable over HTTPS
- [ ] `service_id` in the well-known JSON matches the link session `service_id`
- [ ] `allowed_url_prefixes` actually covers emitted `nonce_url` and `verify_url`
- [ ] well-known responses use cache headers that won't pin stale metadata during rollout/debugging

---
