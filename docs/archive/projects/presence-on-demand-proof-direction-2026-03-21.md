# Presence direction shift — on-demand proof model

Date: 2026-03-21

## Decision

Presence should shift away from a product definition centered on automatic renewal.

New canonical model:
- user links Presence to a service once via deeplink / QR
- the app stays linked in the background as a connection identity, not as a continuously renewed PASS holder
- when the service needs human proof, it asks for a Presence PASS submission
- the user opens Presence, performs proof, submits PASS
- the service verifies and allows the action

In short:

**Link once -> stay linked -> prove on demand**

---

## Why this is the better direction

### 1. Better match for iOS reality

iOS does not give a reliable guarantee that a normal app can continuously renew in the background or after force quit.
The product should not depend on behavior the platform does not actually guarantee.

### 2. Simpler app model

This removes or de-emphasizes:
- renewal timers
- renew-soon UX
- exact freshness countdown semantics as a product centerpiece
- background scheduler dependence
- force-quit survival as a product expectation

### 3. Cleaner service model

The service can ask for proof when it matters:
- login
- risky action
- payout / transfer
- moderation-sensitive action
- anti-bot gate

### 4. Clearer public explanation

Presence becomes easier to explain as:
- a linked human-proof app
- not a constantly self-refreshing liveness daemon

---

## New canonical user flow

### A. Initial linking
1. Service creates a link session
2. Service shows QR/deeplink
3. User opens Presence and approves
4. Backend verifies the initial proof
5. Binding is created
6. App now shows the service as connected

### B. Idle linked state
1. The app keeps the linked service relationship
2. The app does not need to promise constant background PASS renewal
3. The service knows the account is linked, but still requests fresh proof when needed

### C. Proof on demand
1. The service decides that a human proof is required
2. The service triggers Presence via deeplink, QR, push, or explicit button
3. The user opens Presence
4. Presence measures health signals and creates proof
5. Presence submits proof to the service
6. Backend verifies and marks that proof/challenge as passed
7. The service allows the gated action

---

## Product model changes

### Old center of gravity
- automatic renewal
- PASS maintenance in the background
- expiry countdown as a primary product concept

### New center of gravity
- linked identity
- proof request
- proof submission
- server verification
- action-time human validation

---

## App changes implied by this decision

### Keep
- link session / deeplink / QR flow
- linked service list
- proof generation
- PASS/FAIL measurement
- nonce / verify integration
- unlink / relink handling

### De-emphasize or remove
- automatic renewal as the main product promise
- renew-soon messaging as a headline UX
- background refresh as a core value proposition
- expiry countdown as the central home-screen concept

### New app UX focus
- Connected services
- Pending proof requests (if modeled explicitly)
- Prove now / Submit PASS
- Last successful proof result
- Unlink / relink clarity

---

## SDK / backend implications

### Keep
- link sessions
- linked account bindings
- nonce issuance
- verify endpoint
- readiness / audit concepts where useful

### Shift emphasis toward
- challenge-driven proof request
- service action gating
- per-request or per-action proof outcomes

### Suggested evolution path
Option A (fastest):
- keep current linked-account nonce/verify structure
- treat proof as an on-demand action rather than a background-renewed state
- reduce renewal emphasis in UI/docs

Option B (cleaner later):
- introduce an explicit challenge model
- e.g. `create challenge -> prove -> verify -> challenge passed`
- promote challenge semantics over renewal semantics

Recommended near-term path: **Option A first**.

---

## Documentation changes implied

### Must update
- public architecture docs
- SDK README wording
- mobile README wording
- known limitations
- app README / test-app wording

### New public framing
Presence is:
- a linked human-proof system
- where the mobile app produces proof when needed
- and the backend remains the authoritative verifier/state holder

Presence is not:
- a guaranteed background-renewal engine
- a force-quit-surviving liveness daemon

---

## Implementation TODOs

### App
1. Reduce renewal-centered home-screen language
2. Reframe PASS as a submission action, not a continuously maintained passive status
3. Add or strengthen proof-request entry flow
4. Keep connected service management + unlink/relink behavior
5. Decide whether countdown/expiry UI remains at all

### SDK / service
1. Keep linked-account flow working
2. Reword examples around on-demand proof
3. Consider adding explicit challenge APIs later
4. Keep authoritative unlink/readiness semantics documented

### Docs
1. Replace auto-renewal-heavy product framing
2. Document `Link once -> stay linked -> prove on demand`
3. Be explicit that background proof is best-effort, not the core promise

---

## Proposed immediate next step

Do not redesign the whole protocol first.
Instead:
1. update product/docs terminology
2. simplify app UX around on-demand proof
3. keep current backend primitives
4. decide later whether a first-class challenge API is worth introducing
