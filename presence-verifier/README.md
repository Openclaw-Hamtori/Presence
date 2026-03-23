# presence-verifier

Presence Attestation Verifier — Reference Implementation

Based on:
- Presence Verifier Spec v0.4
- Presence Signal Spec v0.4
- Presence Android Platform Appendix v0.1

---

## Status

> ⚠️ This package verifies Presence proofs, not full product account-linking by itself.
> Phase 2 adds linkage-oriented terminology in the surrounding architecture, but persistent account bindings live one layer above the verifier.

The verifier still owns the core proof checks:
- nonce freshness + replay protection
- logical time validation
- device attestation digest validation
- signature verification
- `human == true`
- `pass == true`

Platform attestation status is now split more clearly:
- iOS App Attest: structural attestation_object verification + cert chain validation when Apple root CA is provided
- Android Play Integrity: compact JWS parsing, signature verification against x5c leaf cert, optional chain validation to a pinned Google root CA, and payload verdict/nonce/package checks

Remaining production TODOs are now mostly about trust material and real environment inputs, not a hardcoded STUB path.

### Small-team persistence helper

For SQLite-first/single-server deployments, Presence verifier now includes `SqliteTofuStore` in `src/stores.ts`. It persists Android TOFU key bindings by `iss` in a local sqlite database so Android key continuity survives server restarts.

---

## Role in the linked architecture

Presence now distinguishes between:
- **initial link** — service bootstraps a one-time link session and nonce
- **persistent binding** — service keeps the device linked until revoked/unlinked
- **fresh auth proof** — verifier checks a new Presence proof whenever required

`presence-verifier` is deliberately the lowest layer in that stack.
It does not persist service bindings, issue unlink decisions, or manage product UX.

---

## Verification order

Implements Verifier Spec v0.4 in normative order. Steps MUST NOT be reordered.

1. parse format
2. validate `pol_version`
3. validate nonce format
4. validate nonce freshness
5. validate nonce uniqueness
6. validate logical time constraints
7. validate clock drift
8. validate full device attestation
9. verify `device_attestation_digest`
10. obtain validated device public key
11. verify signature
12. require `human == true`
13. require `pass == true`
14. mark nonce used and return result

Optional service freshness policies may run between steps 7 and 8.

---

## Why this matters for persistent linkage

A service can keep a long-lived binding to `iss`, but it should still ask for a **fresh Presence proof** when risk, session age, or product policy requires it.

That means:
- binding persistence is a product decision
- attestation freshness is still a verifier/input policy decision
- PASS freshness is represented through `iat`, `state_created_at`, and `state_valid_until`

This separation is intentional.

---

## Installation

```bash
npm install presence-verifier
```

---

## Build & test

```bash
npm run build
npm test
```

## Platform attestation notes

### iOS App Attest

What is verified locally:
- CBOR decoding of `attestation_object`
- `fmt == apple-appattest`
- `attStmt.x5c` structure
- leaf/intermediate parsing
- certificate chain validation when `appleRootCA` is supplied
- `authData` structure, flags, AAGUID, RP ID hash, and counter extraction

What still requires real Apple environment inputs:
- real App Attest artifacts from device enrollment
- production Apple App Attestation Root CA provided to the verifier
- any service-specific onboarding nonce correlation beyond cached-attestation reuse

### Android Play Integrity

What is verified locally:
- compact JWS structure
- header parsing
- RS256 signature verification against bundled `x5c` leaf certificate
- optional chain validation if `policy.google_play_root_ca` is supplied
- `requestDetails.nonce`
- package name match against `policy.android_package_name`
- `appRecognitionVerdict == PLAY_RECOGNIZED`
- `deviceRecognitionVerdict` includes `MEETS_DEVICE_INTEGRITY`

What still requires real Google environment inputs:
- real Play Integrity tokens from Android clients
- pinned Google trust material / deployment trust policy for production
- optional server-side integration with Google decode APIs if your architecture wants authoritative remote decoding rather than local JWS handling

### Local harness escape hatch

`policy.allow_unverified_play_integrity = true` exists only for local harnessing when you want to exercise payload validation without an `x5c` chain. Do not use it in production.

---

## License

MIT
