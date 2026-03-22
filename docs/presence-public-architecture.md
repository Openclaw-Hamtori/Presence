# Presence public architecture

This document explains how the Presence app, SDK, verifier, and service backend fit together as one product system.

It is written for people evaluating, integrating, or publicly understanding Presence.

---

## The short version

Presence is **not** just a mobile app and it is **not** just a verifier library.
It is a split system:

- the **Presence app** measures health-derived signals and produces proofs
- the **Presence SDK** runs on the service/backend side and manages linking, proof verification flows, readiness, and persistence
- the **Presence verifier** performs the proof verification itself
- the **service backend** decides access based on server-side authoritative truth

That split is intentional.

The simplest current product description is:

**`link once -> service requests PASS -> user opens Presence -> pending request hydrates -> user taps orb -> fresh proof -> server verify`**

---

## System roles

### 1. Presence app

The app is responsible for:
- reading health data on device
- evaluating PASS / FAIL locally
- generating proof material
- calling service sync endpoints for linked accounts
- maintaining local UX state

The app is **not** the final source of truth for service access.
It can measure and prove, but the service still needs to verify and store the result.

### 2. presence-verifier

`presence-verifier` is the lowest-level verification layer.
It is responsible for:
- nonce validation
- attestation validation
- signature validation
- PASS / human checks

It does **not** persist account linking or product-level service state by itself.

### 3. presence-sdk

`presence-sdk` is the service integration layer.
It wraps the verifier with product-facing behavior such as:
- link session creation
- linked account verification
- persistent service bindings
- linked device records
- readiness decisions
- audit events
- unlink / revoke / recovery flows

This is the layer that turns proof verification into something a real service can operate.

### 4. Service backend

The backend owns the authoritative state used for access decisions.
It stores and exposes:
- linked account bindings
- linked devices
- pending proof requests when the service uses durable app-open proof flow
- latest verified PASS snapshot
- readiness state
- audit trail

If app-local state and server state disagree, the server wins.

---

## Why authoritative server truth matters

Presence must distinguish between:
- a mobile UI saying “PASS”
- a server having a verified PASS snapshot for a linked account that still satisfies backend policy

Those are not the same thing.

A mobile app can look healthy locally while the service has not yet received or stored a valid update.
Because of that, Presence uses **authoritative server truth** for service access.

Recommended rule:
- the app may show local status, but requestless local measurement should be labeled as local-only rather than final PASS
- the service should gate on server-side readiness

---

## Core flow

### Initial link

1. Service creates a link session
2. Service shows a QR or deeplink to the user
3. Presence app opens the link context
4. App measures health signals and produces proof
5. Backend verifies the proof with `presence-sdk`
6. Backend persists:
   - link session outcome
   - service binding
   - linked device
   - latest verified PASS snapshot
   - audit event

### On-demand proof submission

1. A linked service decides a human check is required
2. Service either issues a linked-account nonce immediately or creates a durable pending proof request
3. App opens the request directly or hydrates pending work from the backend
4. App submits proof to the verify endpoint or the request-specific respond endpoint
5. Backend verifies and updates the latest snapshot plus any pending request status
6. Service allows or denies the action based on authoritative readiness

### Unlink / relink

1. A service/backend can unlink a linked account binding
2. The backend marks that binding as `unlinked` and records an audit event
3. Backend readiness for that account is no longer `ready`
4. Once the app performs authoritative hydration again, outdated local service cards should disappear rather than surviving as cached linked entries
5. A future connection should create a new linked binding and restore readiness through proof submission

---

## What “PASS is sent to the server” actually means

Presence does not send a plain text "I passed" flag.

The actual shape is:
- service issues a nonce
- app creates a fresh attested proof bound to that nonce
- backend verifies that proof
- backend stores the resulting verified snapshot

So the service trusts:
- verified proof
- linked binding/device state
- server-side readiness logic

not merely the client UI state.

---

## Readiness model

A service should generally treat **server readiness** as the decision surface.

Typical states include:
- `ready`
- `stale`
- `not_ready`
- `missing_binding`
- recovery-related states

Important distinction:
- **binding exists** does not automatically mean **account is currently ready**
- readiness depends on the latest verified PASS snapshot and current backend policy

---

## Background and lifecycle expectations on iOS

Presence can support useful background-related behavior, but iOS background execution is not an unlimited runtime.

Practical expectations:
- foreground and foreground-resume paths can be made highly reliable
- background refresh may work opportunistically
- exact periodic execution is not guaranteed
- force-quit survival should not be treated as guaranteed behavior

This means Presence should be documented and designed around:
- strong foreground correctness
- strong foreground-resume recovery
- best-effort background catch-up
- explicit server proof rules

---

## Persistence model

The SDK includes reference persistence adapters such as a filesystem-backed linkage store.
That is useful for reference deployments and local development, but the broader architectural rule remains:

- service-side persistence must preserve authoritative truth correctly
- proof verification without durable state correctness is not enough

Presence should be evaluated as:
- runtime correctness
- linkage/history correctness
- persistence correctness
- operational truthfulness

---

## What integrators should understand

If you are integrating Presence into a service, the practical rule is:

1. use the mobile app to collect and prove
2. use `presence-sdk` to link, verify, and store
3. use server-side readiness as the gate
4. treat local mobile state as UX, not authority

---

## Public claim that is safe to make

A precise public description is:

> Presence is a linked proof system where the mobile app produces health-derived proofs, the verifier checks them, and the service backend stores authoritative readiness state for linked accounts.

That is much more accurate than saying:
- “the app itself decides access”
- or “the verifier alone is the product”

---

## Recommended related docs

- `presence-sdk/README.md`
- `presence-mobile/README.md`
- `presence-verifier/README.md`
