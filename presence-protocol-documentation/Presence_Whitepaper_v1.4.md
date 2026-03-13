# Presence
### A Device-Based Human Presence Signal Protocol

**Whitepaper Version 1.4**

> This document is **Whitepaper v1.4** and describes a **PASS/FAIL-oriented protocol model**.
> Normative details are defined in the companion specs:
> - Presence Signal Specification v0.4
> - Presence Verifier Specification v0.4
> - Presence Mobile Client Flow v0.4
> - Presence Threat & Trust Assumptions v0.4

---

## 1. Introduction

Presence is a device-based human presence signal protocol using smartwatch-derived biometric and activity signals.

Presence lets trusted consumer devices emit a verifiable **human-presence PASS signal**.

```text
smartwatch sensors (BPM, steps)
    |
health data stored on phone (HealthKit / Health Connect)
    |
Presence app (device)
    |
local PASS evaluation over a rolling 72h window
    |
Presence-linked device state
    |
fresh Presence Attestation when a service requests it
```

Presence is not an identity system. It is a human-presence linkage and attestation system.

---

## 2. PASS Definition

A device is considered **PASS** when, within the most recent **72-hour rolling window**, there exists at least one day satisfying all of the following:

- at least `6` BPM samples are within `40–200`
- those samples span at least `3` distinct 10-minute buckets
- BPM is **not** a completely fixed value
- steps are at least `100`

If these conditions are not met, the device is **FAIL**.

Presence uses **PASS/FAIL only** in the current version.
Previous confidence-style scoring concepts are deprecated from the main protocol model.

---

## 3. Connection Model

Presence is based on:
- **initial one-time connection**
- **ongoing linked state**
- **fresh attestation when needed**

This means the user does **not** reconnect from scratch on every request.
After initial setup and linkage, the device maintains state in the background on a best-effort basis.
When a service asks for proof, the device produces a fresh attestation from current valid state.

---

## 4. Multi-Service Linking

The same device may be linked to multiple different services such as:
- X
- Google
- Discord
- other supported services

This is allowed.

Presence does **not** define same-service anti-multi-account policy.
Preventing multiple accounts within a single service is the responsibility of that service.

---

## 5. Background Operation

Presence does **not** require exact measurement every 72 hours.
Instead:
- the app collects relevant health data in the background on a best-effort basis
- the app refreshes PASS state when possible
- the app revalidates when needed before issuance

This model is intentionally tolerant of platform scheduling limits.

---

## 6. Optional Relay / Webhook Architecture

Relay / webhook delivery is **optional architecture**, not core protocol.

If a connected service wants ongoing status delivery or asynchronous updates, relay/webhook infrastructure may be added.
That layer is operational convenience, not a mandatory part of Presence core verification.

---

## 7. Identifier Direction

The current structure may use a global device identifier as a practical tradeoff.

However, the long-term recommended direction is a **service-scoped identifier** to reduce cross-service linkability.

So the model is:
- **current:** global identifier tradeoff possible
- **future recommended:** service-scoped identifier

---

## 8. Verification Summary

At a high level, a verifier checks:
1. protocol format
2. nonce validity
3. time validity
4. full device attestation validity
5. attestation digest match
6. signature validity
7. PASS state validity

Presence is now framed as a **PASS/FAIL attestation protocol**, not a score-threshold protocol.

---

## 9. Summary

| Item | Value |
|------|------|
| Whitepaper version | 1.4 |
| State model | PASS / FAIL |
| Time basis | rolling 72h window |
| PASS conditions | ≥6 valid BPM samples + ≥3 distinct 10-minute buckets + non-fixed BPM + steps >= 100 |
| Connection model | initial link + persistent linked state + fresh attestation |
| Multi-service use | allowed |
| Same-service anti-multi-account | service responsibility |
| Background behavior | best-effort refresh + revalidation |
| Relay/webhook | optional architecture |
| Long-term identifier direction | service-scoped identifier |

---

Presence Whitepaper v1.4
