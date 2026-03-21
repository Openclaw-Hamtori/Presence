# Presence integration quickstart

This is the shortest practical path for integrating Presence into a service.

---

## What you need

You need three moving parts:

1. **Presence mobile app**
   - reads on-device health signals
   - evaluates PASS / FAIL locally
   - produces fresh proof material

2. **presence-sdk** on your backend
   - creates link sessions
   - verifies linked accounts
   - persists bindings/devices/snapshots
   - computes readiness

3. **Your service backend / product UI**
   - presents QR or deeplink linking UX
   - calls backend endpoints
   - gates access on readiness

---

## Mental model

A Presence integration is not:
- just a mobile app
- just a verifier
- just a one-time QR link

It is a linked identity system with **on-demand proof submission**.

The service should trust:
- fresh verified proofs
- stored linkage state
- server readiness

not merely the client UI state.

---

## Minimal backend flow

### 1. Create a link session

Your backend creates a one-time link session.

Typical result:
- session id
- QR URL / deeplink URL
- completion endpoint metadata

### 2. Show QR or deeplink

Your product UI renders the QR or exposes the deeplink.

### 3. Mobile opens the session

The Presence app opens the deeplink / scanned payload, evaluates PASS locally, and prepares a proof for the service.

### 4. Backend completes the link

Your backend calls the SDK completion path, verifies the proof, and persists:
- binding
- linked device
- verified snapshot
- audit event

### 5. Use readiness for access

Your service should gate access on linked-account readiness.

Recommended rule:
- only `ready: true` means allow

---

## Minimal proof-on-demand flow

After linking, the service can request a fresh proof whenever a human check is needed.

Typical path:
1. backend decides a proof is required for an action or session
2. backend issues linked-account nonce
3. app is opened via deeplink / QR / explicit action
4. app generates a fresh proof
5. app submits proof to verify endpoint
6. backend verifies and updates authoritative snapshot
7. service allows or denies the gated action based on the result

---

## Suggested endpoint surface

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

---

## What the service should store

At minimum, store:
- linked account binding
- linked device identity
- latest verified PASS snapshot
- audit trail

This is what lets the service answer:
- is this account linked?
- is it ready right now?
- when was it last freshly verified?

---

## Recommended access rule

Treat backend readiness as the authority.

Examples:
- `ready` -> allow
- `stale` -> expired or grace-period handling, depending on product policy
- `not_ready` -> block
- `missing_binding` -> block / relink
- recovery-related states -> block until recovery completes

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

## Documents to read next

- `docs/presence-public-architecture.md`
- `presence-sdk/README.md`
- `presence-mobile/README.md`
- `presence-verifier/README.md`
