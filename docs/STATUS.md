# Presence status / closeout (after latest stabilization cycle)

_Last updated: 2026-03-23_

## 1) Current canonical flow (what is intended default)
- `link once -> stay linked -> service requests PASS -> user opens Presence -> pending request hydrates/nonce -> user submits fresh proof -> server verifies and stores authoritative readiness`
- Canonical behavior is server-authoritative (client UI is not authoritative for access decisions).
- Push/notification path is **not required** for correctness.
- Public contract for this flow is documented in:
  - `docs/README.md`
  - `docs/presence-public-architecture.md`
  - `docs/presence-integration-quickstart.md`

## 2) Verified working state (real device/live server)
- **Real iPhone + live HTTPS trust + verifier completion happy-path validated** end-to-end
  - Documented in `PRESENCE_RELEASE_VALIDATION_2026-03-19.md`.
- **Live server canonical loop (link/verify/reauth/ready persistence) validated repeatedly on real device + Noctu**
  - Documented in `projects/presence-ship-closeout-2026-03-21.md`.
  - Includes repeated verify success, readiness (`ready`, `lastVerifiedAt`, `stateValidUntil`) advancing, and audit/event consistency.
- **Trust model + service-domain prefix behavior confirmed on-device**
  - `/.well-known/presence.json` happy path and boundary checks validated; stale/invalid trust failures are fail-closed (`PRESENCE_RELEASE_VALIDATION_2026-03-19.md`).
- **Live pending-proof API surface is now redeployed and route-mapped**
  - `POST /presence/linked-accounts/:accountId/pending-proof-requests`
  - `GET /presence/linked-accounts/:accountId/pending-proof-requests`
  - `GET /presence/pending-proof-requests/:requestId`
  - `POST /presence/pending-proof-requests/:requestId/respond`
  - Documented in `projects/presence-happy-path-pending-proof-redeploy-2026-03-22.md` and `projects/presence-happy-path-deploy-guardrails-2026-03-21.md`.
- **Live route-base/URL compatibility fixed** for `https://noctu.link/presence-demo/presence` through `ROUTE_BASE_PATH` stripping (`presence-happy-path/app/server.cjs`, commit `d37d550`; follow-up note `projects/presence-push-live-route-fix-2026-03-22.md`).
- **Push token upload path hardened** and route accepts persisted token formats only (`projects/presence-push-token-apns-format-fix-2026-03-22.md`, `projects/presence-ios-push-entitlement-debug-2026-03-22.md`).
- **Minimal service auth boundary added** to the reference server (`PRESENCE_SERVICE_API_KEY`) for service-owned endpoints; callback proof endpoints remain public and auth is opt-in for local/dev (`presence-happy-path/app/server.cjs`, `scripts/check-server-auth.mjs`).
- **SQLite-backed `SqliteLinkageStore` now persists pending-proof request records and their status transitions** (`presence-sdk/src/sqlite-store.ts`, `presence-sdk/src/test/sdk.test.ts`).

## 3) Non-canonical / optional / experimental
- **APNs wake path** is optional and non-authoritative (`docs/presence-push-setup-vs-steady-state.md` and `docs/README.md`).
- **Background proof/renewal guarantees** remain best-effort and are not the canonical product promise (`docs/presence-known-limitations.md`, `docs/presence-pending-proof-request-architecture.md`).
- **File-backed linkage store** in `presence-sdk` remains functional and hardened, but not the preferred long-term production store (`docs/presence-known-limitations.md`, `projects/presence-sqlite-design-2026-03-21.md`).
- **Local measurement PASS** is not equivalent to server-access PASS unless verified flow completes.

## 4) Remaining follow-ups / backlog
- **Phase 2 is otherwise closed.** The only explicit blocker left is the **final real-device happy-path replay of pending-proof `respond`** against a known `(accountId, requestId)` on live server.
  - Evidence and current status are tracked in:
    - `projects/presence-pending-proof-respond-live-validation-2026-03-23.md`
    - `projects/presence-phase2-closeout-2026-03-23.md`
  - Expected final-check result: `POST /presence/pending-proof-requests/:requestId/respond` returns 200 with `ok: true` and `request.status === "verified"`, and linked-account readiness reflects an updated `lastVerifiedAt` / `stateValidUntil`.
- Finish **reliable APNs live delivery path** (token flow + notification wake + app hydration evidence) and then rerun the same request/replay path with that linked device.
- Known accepted Phase 1 debt in `SqliteLinkageStore`: `listAuditEvents()` still applies filters in-memory after loading rows; acceptable for small-team baseline scale, with SQL-level filtering deferred.
- Known accepted Phase 1 debt in `SqliteLinkageStore`: sqlite handle lifecycle does not yet expose explicit `close()`/`destroy()` semantics; acceptable for current single-process SQLite-first baseline and long-tail tests, but should be hardened in later phase.

## 5) Notes for future reviewers/operators
- Single source of truth for deployable server runtime should stay in-repo (`presence-happy-path/app/server.cjs`) and be installed via tarball+restart, not manual drift edits on VPS.
- `PRESENCE_SERVICE_DOMAIN`, `ROUTE_BASE_PATH`, and `PUBLIC_BASE_URL` are distinct knobs:
  - trust domain/prefix: `PRESENCE_SERVICE_DOMAIN` + `/.well-known/presence.json`
  - inbound path mounting: `ROUTE_BASE_PATH`
  - client-facing URLs: `PUBLIC_BASE_URL`
  - see `docs/presence-server-routing-guide.md`.
- Prefer adding future state notes as short dated entries in `projects/` plus this closeout doc when direction changes.
