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
- **SQLite-backed `SqliteLinkageStore` now persists pending-proof request records and their status transitions** (`presence-sdk/src/sqlite-store.ts`, `presence-sdk/src/test/sdk.test.ts`).

## 3) Non-canonical / optional / experimental
- **APNs wake path** is optional and non-authoritative (`docs/presence-push-setup-vs-steady-state.md` and `docs/README.md`).
- **Background proof/renewal guarantees** remain best-effort and are not the canonical product promise (`docs/presence-known-limitations.md`, `docs/presence-pending-proof-request-architecture.md`).
- **File-backed linkage store** in `presence-sdk` remains functional and hardened, but not the preferred long-term production store (`docs/presence-known-limitations.md`, `projects/presence-sqlite-design-2026-03-21.md`).
- **Local measurement PASS** is not equivalent to server-access PASS unless verified flow completes.

## 4) Remaining follow-ups / backlog
- Confirm **real-device end-to-end completion** of pending-proof request RESPOND route against live server (`/presence/pending-proof-requests/:requestId/respond`) after latest push-token/setup and route-base fixes.
  - Partial validation captured in `projects/presence-pending-proof-respond-live-validation-2026-03-22.md` (route existence and missing/request-error handling for `create/list/get/respond`).
  - Outstanding: single-session real-device `respond` happy-path replay with a known `requestId` and linked account/device pair.
- Finish **reliable APNs live delivery path** (token flow + notification wake + app hydration evidence) with same linked account/device used on-device.
- Close remaining validation gap around **relink/unlink and stale-link cleanup** on fresh sessions in long-running manual runs.
- Finish durable shared nonce storage + operator hardening (still phase 2), while small-server SQLite path for pending-proof request state transitions remains the validated Phase 1 baseline slice. (SQLite/WAL design referenced in `projects/presence-sqlite-design-2026-03-21.md`).
- Known accepted Phase 1 debt in `SqliteLinkageStore`: `listAuditEvents()` still loads/filter-in-memory instead of pushing filters into SQL; acceptable for small-team baseline scale, but should move to SQL-level filtering in Phase 2.
- Known accepted Phase 1 debt in `SqliteLinkageStore`: sqlite handle lifecycle does not yet expose explicit `close()`/`destroy()` semantics; acceptable for current single-process baseline/tests, but should be hardened in Phase 2.

## 5) Notes for future reviewers/operators
- Single source of truth for deployable server runtime should stay in-repo (`presence-happy-path/app/server.cjs`) and be installed via tarball+restart, not manual drift edits on VPS.
- `PRESENCE_SERVICE_DOMAIN`, `ROUTE_BASE_PATH`, and `PUBLIC_BASE_URL` are distinct knobs:
  - trust domain/prefix: `PRESENCE_SERVICE_DOMAIN` + `/.well-known/presence.json`
  - inbound path mounting: `ROUTE_BASE_PATH`
  - client-facing URLs: `PUBLIC_BASE_URL`
  - see `docs/presence-server-routing-guide.md`.
- Prefer adding future state notes as short dated entries in `projects/` plus this closeout doc when direction changes.
