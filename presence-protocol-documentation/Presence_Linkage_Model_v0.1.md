# Presence Linkage Model
### v0.2 — Phase 3 Draft

---

## 1. Goal

Presence moves from a one-shot proof generator toward a **linked auth product** with durable account bindings, explicit recovery paths, and product-grade completion handoff.

Phase 3 operationalizes the linkage model without pretending the full production UX is finished.

---

## 2. Product semantics

### Initial link

A service starts with a **one-time initial link**:
1. service creates a link session
2. service issues a nonce
3. service renders a QR code or deeplink
4. mobile app proves Presence once
5. verifier validates the proof
6. service persists the binding

### Persistent linkage

After the initial link, the connection remains active **unless revoked or explicitly unlinked**.

The user should not need to repeat full onboarding for every auth event.

### Fresh attestation

Persistent linkage does **not** eliminate fresh proof requirements.
A service may request a new Presence proof whenever needed.

Examples:
- high-risk login
- session step-up
- stale PASS snapshot
- policy-driven re-authentication

### Recovery is distinct from re-auth

Presence should distinguish:
- **re-auth** — same linked device proves again
- **relink** — same account binds a replacement or rotated device
- **recovery** — higher-friction flow after mismatch, revoke, or trust break

---

## 3. Core entities

### LinkedDevice

Represents the durable device identity behind `iss`.

Suggested fields:
- `iss`
- `platform`
- `firstLinkedAt`
- `lastVerifiedAt`
- `lastAttestedAt`
- `trustState`
- `revokedAt?`
- `recoveryStartedAt?`

### LinkSession

Represents the one-time bootstrap used for first linking or relink.

Suggested fields:
- `id`
- `serviceId`
- `accountId`
- `issuedNonce`
- `requestedAt`
- `expiresAt`
- `status`
- `linkedDeviceIss?`
- `relinkOfBindingId?`
- `recoveryReason?`
- `completion?`

### ServiceBinding

Represents the persistent relation between service account and linked device.

Suggested fields:
- `bindingId`
- `serviceId`
- `accountId`
- `deviceIss`
- `status`
- `createdAt`
- `updatedAt`
- `lastLinkedAt`
- `lastVerifiedAt`
- `lastAttestedAt`
- `lastSnapshot?`
- `reauthRequiredAt?`
- `recoveryStartedAt?`
- `recoveryReason?`

### PresenceSnapshot

Represents the latest successfully verified PASS state attached to a binding.

Suggested fields:
- `deviceIss`
- `capturedAt`
- `attestedAt`
- `human`
- `pass`
- `signals`
- `stateCreatedAt?`
- `stateValidUntil?`

### LinkageAuditEvent

Represents append-only lifecycle history.

Suggested event families:
- `link_started`
- `link_completed`
- `reauth_succeeded`
- `binding_mismatch`
- `binding_unlinked`
- `device_revoked`
- `relink_started`
- `recovery_completed`

---

## 4. Minimal operational flow

```text
create link session
  → issue nonce
  → generate QR/deeplink handoff
  → mobile proves Presence once
  → verifier validates proof
  → create linked device + service binding + audit event
  → later auth checks reuse binding
  → fresh attestation requested when needed
  → mismatch/revoke can escalate into recovery or relink
```

---

## 5. Unlink / revoke / relink policy

### User unlink

User-initiated unlink should:
- mark the service binding as `unlinked`
- preserve audit history
- stop silent reuse of the old binding
- allow relink only if service policy permits it

### Service/device revoke

Service-side revocation should:
- mark device trust state as `revoked`
- revoke all bindings attached to that device
- require explicit recovery or relink before the account is usable again

### Relink policy

A service may allow relink when:
- a user replaced their phone/watch
- a device key rotated legitimately
- support manually approved account recovery

A service may deny relink when:
- fraud or abuse is suspected
- policy requires manual support review
- the previous binding was revoked for trust reasons

---

## 6. Binding mismatch and recovery

If a fresh proof verifies cryptographically but `iss` differs from the stored linked device:

1. service MUST NOT silently overwrite the binding
2. service marks the binding `reauth_required` or `recovery_pending`
3. service returns a product response indicating recovery action
4. if policy allows, service creates a relink session tied to the original binding
5. successful relink updates the binding to the new `iss`

This avoids accidental takeover when a different device presents a valid Presence proof.

---

## 7. QR / deeplink completion architecture

Phase 3 adds a minimal completion contract:

### Backend output

A link session should carry:
- `method` (`qr`, `deeplink`, or `manual_code`)
- `qrUrl?`
- `deeplinkUrl?`
- `fallbackCode?`
- `expiresAt?`

### Product handoff

- web/desktop renders QR from `qrUrl` or `deeplinkUrl`
- mobile app resolves the session from the deeplink
- mobile sends proof with `link_context`
- service completes the link server-side

### Explicit non-goals for this phase

- native scanner implementation
- camera permissions UX
- universal-link edge case hardening
- final app-store-grade polish

---

## 8. Background PASS maintenance

The mobile app should maintain PASS state in the background on a best-effort basis.

Important constraints:
- this work is opportunistic, not guaranteed on exact intervals
- linkage remains persistent even if background maintenance is temporarily unavailable
- a service may still require fresh proof before accepting auth

So the product model is:
- **binding is durable**
- **PASS snapshot is perishable**
- **attestation is fresh when requested**
- **recovery is explicit when trust changes**

---

## 9. Phase boundary

Included in this phase:
- shared terminology for unlink / revoke / relink / recovery
- domain entities supporting recovery and audit history
- pluggable persistent store examples beyond in-memory
- docs for QR/deeplink completion architecture

Not included in this phase:
- QR scanner implementation
- deep native link handling code for every platform edge case
- final production database schema migrations
- final recovery notification UX
