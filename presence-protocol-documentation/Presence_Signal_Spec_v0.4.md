# Presence Signal Specification
### v0.4 — Draft

---

## 1. Scope

This document defines the PASS/FAIL-oriented protocol model for Presence.

Main changes in this version:
- confidence score removed from primary protocol path
- PASS/FAIL state defined over a rolling 72h window
- linkage-oriented connection model clarified

---

## 2. PASS State Definition

A device is in **PASS** state when, within the most recent **72-hour rolling window**, there exists at least one **local calendar day** (in the device user's timezone) satisfying all of the following:

1. at least `6` BPM samples are within `40–200`
2. those BPM samples are distributed across at least `3` distinct 10-minute buckets
3. BPM is not completely fixed
4. steps for that same local day are at least `100`

Otherwise the device is in **FAIL** state.

---

## 3. Human Readiness State

```json
{
  "human": true,
  "pass": true,
  "signals": ["heart_rate", "steps"],
  "state_created_at": 1741234567,
  "state_valid_until": 1741494567
}
```

Constraints:
- `human` MUST be `true` for an issued attestation
- `pass` MUST be `true` for an issued attestation
- `signals` MUST follow canonical order
- if `pass == true`, `signals` MUST be exactly `["heart_rate", "steps"]`
- `state_valid_until` MUST be greater than `state_created_at`
- `state_valid_until` MUST NOT exceed `state_created_at + 259200`

---

## 4. Presence Attestation

```json
{
  "pol_version": "1.0",
  "iss": "presence:device:a3f8c2e1b7d94f06c9b85e2f4d1a7830",
  "iat": 1741298000,
  "state_created_at": 1741234567,
  "state_valid_until": 1741494567,
  "human": true,
  "pass": true,
  "signals": ["heart_rate", "steps"],
  "nonce": "TnZfQ2hhbGxlbmdlXzEyMw",
  "device_attestation_digest": "3f2c7a9b...(64 hex chars)",
  "signature": "..."
}
```

`device_attestation_digest` is the SHA-256 digest of the full device attestation object.

---

`human` indicates Presence issuance conditions are satisfied.
`pass` indicates the rolling 72h PASS condition is satisfied.

---

## 5. Removed / Deprecated Concepts

The following are removed or deprecated from the primary protocol model:
- 0–1000 confidence score
- threshold-based service policy
- bonus-based scoring model

Presence v0.4 is PASS/FAIL-first.

---

## 6. Time Basis

All recent-data language should be interpreted using a **rolling 72-hour window**, not a fixed 24-hour window.

Per-day co-occurrence checks within that window use the device user's **local calendar day**, not UTC-day bucketing.

For heart-rate evaluation, implementations SHOULD use discrete valid BPM readings and their distribution across distinct 10-minute buckets. Raw HealthKit sample spans MAY be retained as metadata, but they SHOULD NOT be used as the primary PASS threshold.

---

## 7. Connection Model

Presence assumes:
- initial one-time connection
- persistent linked device state
- fresh attestation generated on request

It is not a repeated full re-link model.

---

## 8. Identifier Direction

A global identifier may still be used in the current structure as a tradeoff.
The preferred long-term direction is a **service-scoped identifier**.

---

Presence Signal Specification v0.4 — Draft
