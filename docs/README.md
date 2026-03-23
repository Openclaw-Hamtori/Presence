# Presence docs map

Use this as the starting point for implementing or integrating Presence today.

## Primary flow (canonical)

The implemented default product path is:

`link once -> service requests PASS -> user opens Presence -> pending request hydrates -> user taps orb -> fresh proof -> server verify`

Canonical meaning:
- link once (single initial setup)
- stay linked
- service requests PASS when needed
- user opens Presence and user action hydrates pending request
- user provides fresh proof from orb interaction
- server verifies and marks readiness/action based on verification result

## Where to read first

1. `docs/presence-integration-quickstart.md`
   - full backend + mobile integration flow
   - endpoint contract and required states
   - push/APNs positioning (optional / non-canonical)
2. `docs/presence-public-architecture.md`
   - protocol and architecture view of linked service + pending request flows
3. `docs/presence-pending-proof-request-architecture.md`
   - detailed pending-proof responder lifecycle and recovery cases
4. `docs/presence-push-setup-vs-steady-state.md`
   - why push is best-effort and experimental in this branch

## Package-level guidance

- `presence-sdk/README.md`: backend helper APIs, contract helpers, integration expectations.
- `presence-mobile/README.md`: mobile SDK semantics, proof-generation expectations, and user-state behavior.
- `presence-happy-path/app/server.cjs`: local reference server implementing the canonical flow with `ROUTE_BASE_PATH`, `PUBLIC_BASE_URL`, and `PRESENCE_SERVICE_DOMAIN` support.
- `presence-sdk/examples/*`: lightweight reference implementation of endpoint handlers.

## Quick implementation order

1. Implement the minimal endpoints from `presence-integration-quickstart`.
2. Wire link session creation/consumption.
3. Implement linked-account PASS request paths (`/nonce`, `/verify`, `/status`).
4. Add pending-proof request surface for app-hydrated proof taps.
5. Add service-domain trust metadata + HTTPS `/.well-known/presence.json`.
6. Make push transport optional (off by default).

## Production roadmap

- `docs/presence-next-stage-roadmap.md`: priorities for moving from stabilized reference implementation to self-hostable, operator-grade stack.

## Regression baseline (start here before Phase 1/2 changes)

- `docs/presence-phase1-starter-pack-2026-03-23.md`: durable baseline checklist and concrete Phase 1 starter execution plan.
- `npm run check:phase1-smoke` runs the baseline smoke preflight checks.
- `npm run check:runtime-smoke` runs an optional endpoint smoke check against a running Presence server (`PRESENCE_SMOKE_LOCAL=1` to auto-start local server from this repo, or `PRESENCE_SMOKE_URL` for existing live server target).
- `npm run ci:phase1` is the CI baseline guardrail target for PRs: it validates the server contract (`check:server-contract`) and then runs the phase 1 smoke preflight.