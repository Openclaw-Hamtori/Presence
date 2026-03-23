# Presence Phase 2 closeout note (2026-03-23)

## Objective
Close remaining Phase 2 checklist items in-repo, with one explicit exception:
- **final live real-device `/presence/pending-proof-requests/:requestId/respond` validation**

## What is now explicitly marked closed
- SQLite/store hardening and restart-resilience for link-session + pending-proof nonces are in place and covered by tests.
- Error-shape runtime smoke coverage for pending-proof endpoints is present in CI-local `check-runtime-presence-smoke.mjs` (missing binding and unknown/probe request handling).
- Phase 2 docs/closeout status now explicitly says the phase is closed except for the final manual replay gate.

## Explicitly still-open blocker (only)
- One manual end-to-end real-device validation remains: replaying a real pending-proof `respond` payload from a linked phone against a known live `(accountId, requestId)` and confirming persisted `request.status === "verified"` and readiness advancement.

This blocker is intentionally excluded from this pass per instruction.

## Scope kept intact
- No Phase 3/architectural expansion
- Baseline behavior preserved
- Single-server / single-DB SQLite-first friendliness remains the documented baseline expectation for this phase
