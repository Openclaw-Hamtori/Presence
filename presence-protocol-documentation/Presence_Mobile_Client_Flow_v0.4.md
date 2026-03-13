# Presence Mobile Client Flow
### v0.4 — Draft

---

## 1. Scope

This document describes PASS/FAIL-oriented client behavior for Presence with a **persistent linkage model**.

---

## 2. Core evaluation window

All recent-data checks use a **rolling 72-hour window**.

---

## 3. PASS evaluation

Client treats the device as PASS when, within the most recent 72-hour rolling window, there exists at least one qualifying **local calendar day** satisfying:
- at least `6` BPM samples within `40–200`
- those samples distributed across at least `3` distinct 10-minute buckets
- BPM is not completely fixed
- steps for that same local day >= `100`

For current mobile implementations, local day means the device user's local timezone. PASS evaluation should use discrete BPM sample distribution, not inferred covered-minute duration.

Otherwise the state is FAIL.

---

## 4. Linkage model

Presence client behavior is:
- one-time initial link
- persistent linked connection afterward unless revoked/unlinked
- fresh proof generation when the service requires it

The user should not need to fully reconnect for every request.

---

## 5. Initial link flow

1. service creates a link session
2. service issues a nonce
3. mobile app evaluates PASS
4. mobile app creates or refreshes local Presence state
5. mobile app generates fresh App Attest evidence
6. mobile app signs the Presence Attestation
7. mobile app submits attestation + device attestation + optional link context
8. service verifies and persists the binding

---

## 6. Re-auth / linked proof flow

For already-linked accounts:
1. service recognizes an existing binding
2. service issues a fresh nonce
3. mobile app reuses persistent linkage metadata
4. mobile app generates a fresh attestation
5. service verifies the proof against the stored linked device

Persistent linkage and fresh attestation are complementary, not substitutes.

---

## 7. Background behavior

Background behavior is best-effort.

The app should:
- maintain PASS state when OS scheduling allows
- keep the local Presence snapshot fresh enough for fast auth
- request fresh attestation whenever the service asks

The app MUST NOT assume exact periodic execution.

---

## 8. Deferred UX

This phase does not complete:
- QR scanner UX
- deeplink completion UX
- full background scheduler

Those are product/UI layers on top of the linkage model.

---

Presence Mobile Client Flow v0.4 — Draft
