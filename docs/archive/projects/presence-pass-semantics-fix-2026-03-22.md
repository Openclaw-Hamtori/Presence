# Presence PASS semantics fix plan

Date: 2026-03-22

## Problem

The app currently treats a successful local measurement (`PresenceState.pass === true`) as if it were a product-level PASS.
That lets the orb/home UI show `PASS` even when:

- no link session or pending proof request is active
- nothing was submitted to the server
- no backend verification happened

That is product-wrong and breaks the server-authoritative model.

## Desired semantics

- `PASS` is reserved for server-verified success.
- Local measurement success is only local proof eligibility.
- If there is no active request/session/pending proof request, the UI must say that explicitly.
- Requestless local measurement may still exist for diagnostics/preflight, but it must be labeled as local-only and not server-verified.
- Expired requests should surface as expired, not silently collapse into generic local PASS/FAIL copy.

## State model clarification

- `PresenceState.pass`
  - meaning: latest local measurement can support proof generation
  - not meaning: server-authoritative PASS
- `PresenceSnapshot.source: "measurement" | "proof"`
  - meaning: local provenance of the latest snapshot/proof attempt
  - not meaning: backend verification result
- backend-linked truth
  - authoritative readiness still lives on the service/backend side
  - local `lastVerifiedAt` is only evidence that a successful server round-trip happened before; it must not become requestless PASS UI by itself

## Implementation plan

1. Make the app/test-app home product state request-aware.
   - show `LOCAL` / `IDLE` / `READY` / `VERIFY` / `EXPIRED` / `FAIL` instead of using local `pass` as final PASS
   - show explicit no-request and local-only copy when there is no active request context
2. Preserve request-driven submission.
   - keep the orb able to run a local check
   - but do not present the resulting state as final PASS without server verification
3. Update mirrored mobile UI components.
   - `PresenceStatusCard`
   - `OnboardingScreen`
4. Update source-of-truth docs and READMEs.
   - local measurement != requestless PASS
   - server verification remains authoritative
5. Add tests around the corrected product-state mapping.

## Out of scope for this pass

- inventing a new durable client-side "server verified PASS" cache/state machine
- claiming end-to-end verified PASS UI after request completion when that state is not explicitly modeled yet
- redesigning every older demo/reference screen in the repo
