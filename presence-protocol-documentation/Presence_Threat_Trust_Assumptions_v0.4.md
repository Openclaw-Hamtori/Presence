# Presence Threat & Trust Assumptions
### v0.4 — Draft

---

## 1. Scope

This document explains the PASS/FAIL-oriented trust and threat model for Presence.

---

## 2. Core Security Position

Presence is a human-presence signal protocol.
It is not a personal identity system.

Its goal is to raise the cost of automated abuse using:
- device attestation
- smartwatch-derived biometric/activity evidence
- fresh signed attestations

Presence depends on Apple/Google platform trust roots.
It does not claim to prove real-world identity.

---

## 3. Trust Roots and Boundaries

Presence relies on:
- Apple App Attest / Apple trust roots
- Google Play Integrity / Google trust roots
- OS-level health data integrity assumptions

Presence does not inherently solve identity uniqueness.
`1 device != 1 identity`.

---

## 4. PASS/FAIL Direction

Presence now centers on PASS/FAIL rather than confidence scoring.

This improves:
- implementation simplicity
- UX clarity
- verifier consistency

---

## 5. Multi-Service Linking

The same device may link to multiple different services.
That is allowed.

Preventing multiple accounts inside a single service is not handled by Presence core protocol.
That remains a service-policy issue.

---

## 6. Unsupported Attacker Model

Presence does not fully prevent:
- proxy human usage
- physical spoofing of smartwatch-derived signals
- single-account high-effort attacks
- platform compromise below the app layer

---

## 7. Identifier Tradeoff

A global identifier may still exist in the current structure as a tradeoff.
This creates cross-service linkability risk.

The recommended long-term direction is a **service-scoped identifier**.

---

## 8. Background / Relay Model

Background refresh is best-effort, not exact-timed.
Relay / webhook delivery is optional architecture, not core protocol.

---

## 9. Sybil / Identity Note

Presence is useful as a cost-raising anti-abuse layer.
It is not a guarantee of one-human-one-account.

---

Presence Threat & Trust Assumptions v0.4 — Draft
