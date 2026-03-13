# Presence Verifier Specification
### v0.4 — Draft

---

## 1. Scope

This document defines PASS/FAIL-oriented verifier behavior for Presence.

The verifier validates a **fresh proof**. Persistent account linkage is handled by the service/product layer above it.

---

## 2. Inputs

Verifier MUST receive:
- Presence Attestation JSON
- full Device Attestation object

Digest-only verification is insufficient.

---

## 3. Verification order

```text
Step 1. parse format
Step 2. validate pol_version
Step 3. validate nonce format
Step 4. validate nonce freshness
Step 5. validate nonce uniqueness
Step 6. validate logical time constraints
Step 7. validate clock drift
Step 8. validate full device attestation
Step 9. verify device_attestation_digest
Step 10. obtain validated device public key
Step 11. verify signature
Step 12. require human == true
Step 13. require pass == true
Step 14. return result
```

---

## 4. PASS/FAIL model

Verifier MUST require:
- `human == true`
- `pass == true`

If either is not true, verification fails.

---

## 5. Relationship to persistent linkage

A service MAY keep a persistent binding between an account and a device `iss`.
That binding can survive across many auth events until revoked or unlinked.

However, each auth event that requires Presence still depends on a **fresh verifier pass** over a newly issued nonce.

So the model is:
- initial link is one-time
- binding is persistent
- attestation is fresh when needed

### Linked readiness model (service layer)

The verifier still answers a narrow question: did this fresh proof pass right now?

A linked service sitting above the verifier MAY additionally maintain a readiness state derived from the latest successful proof snapshot:

- `ready` = latest `state_valid_until > now`
- `stale` = latest successful snapshot expired, but still within a short grace window that absorbs temporary wake/network delay
- `not_ready` = no usable fresh snapshot remains and grace has also passed
- `recovery_pending` = explicit device mismatch / recovery state

Recommended propagation model:
- success: app/service updates the latest successful snapshot (`state_created_at`, `state_valid_until`)
- ordinary refresh failure: no explicit FAIL signal is required; service naturally degrades from `ready` -> `stale` -> `not_ready` as the last successful PASS ages out
- explicit recovery conditions (for example device mismatch) MAY still be pushed as `recovery_pending`

---

## 6. Output schema

### Success

```json
{
  "verified": true,
  "pol_version": "1.0",
  "iss": "presence:device:a3f8c2e1b7d94f06c9b85e2f4d1a7830",
  "iat": 1741298000,
  "human": true,
  "pass": true,
  "signals": ["heart_rate", "steps"],
  "nonce": "TnZfQ2hhbGxlbmdlXzEyMw",
  "state_created_at": 1741298000,
  "state_valid_until": 1741557200
}
```

### Failure

```json
{
  "verified": false,
  "error": "ERR_PASS_FALSE"
}
```

---

## 7. Grace window guidance

A verifier implementation does not itself need to return `stale`.
`stale` is a linked-service readiness interpretation above the verifier.

Recommended guidance:
- PASS proof success should surface `state_created_at` and `state_valid_until`
- services MAY apply a short grace window after `state_valid_until`
- inside grace => `stale`
- after grace => `not_ready`
- explicit mismatch/recovery flows => `recovery_pending`

## 8. Error codes

- `ERR_INVALID_FORMAT`
- `ERR_UNSUPPORTED_VERSION`
- `ERR_NONCE_INVALID`
- `ERR_NONCE_EXPIRED`
- `ERR_NONCE_REUSED`
- `ERR_TIME_INVALID`
- `ERR_STATE_EXPIRED`
- `ERR_INVALID_ATTESTATION`
- `ERR_ATTESTATION_DIGEST_MISMATCH`
- `ERR_INVALID_SIGNATURE`
- `ERR_HUMAN_FALSE`
- `ERR_PASS_FALSE`

---

Presence Verifier Specification v0.4 — Draft
