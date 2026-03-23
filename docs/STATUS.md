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
- **Live pending-proof API surface is now redeployed, route-mapped, and real-device revalidated on latest deploy**
  - `POST /presence/linked-accounts/:accountId/pending-proof-requests`
  - `GET /presence/linked-accounts/:accountId/pending-proof-requests`
  - `GET /presence/pending-proof-requests/:requestId`
  - `POST /presence/pending-proof-requests/:requestId/respond`
  - Latest clean retest on deployed server succeeded after authoritative unlink → relink → fresh request:
    - relink session `plink_c99d5bdc5edc8e8d` consumed successfully
    - fresh request `ppreq_b41138f5ca96adf4` became `verified`
    - readiness remained `ready: true`
    - snapshot remained `pass: true`
  - Documented in `projects/presence-happy-path-pending-proof-redeploy-2026-03-22.md`, `projects/presence-happy-path-deploy-guardrails-2026-03-21.md`, and `projects/presence-pending-proof-respond-live-validation-2026-03-23.md`.
- **Live route-base/URL compatibility fixed** for `https://noctu.link/presence-demo/presence` through `ROUTE_BASE_PATH` stripping (`presence-happy-path/app/server.cjs`, commit `d37d550`; follow-up note `projects/presence-push-live-route-fix-2026-03-22.md`).
- **Push token upload path hardened** and route accepts persisted token formats only (`projects/presence-push-token-apns-format-fix-2026-03-22.md`, `projects/presence-ios-push-entitlement-debug-2026-03-22.md`).
- **Minimal service auth boundary added** to the reference server (`PRESENCE_SERVICE_API_KEY`) for service-owned endpoints; callback proof endpoints remain public and auth is opt-in for local/dev (`presence-happy-path/app/server.cjs`, `scripts/check-server-auth.mjs`).
- **SQLite-backed `SqliteLinkageStore` now persists pending-proof request records and their status transitions** (`presence-sdk/src/sqlite-store.ts`, `presence-sdk/src/test/sdk.test.ts`).
- **Reference server cleanup sweep wired** for local/single-instance deployments: reference servers now run `presence.cleanupPersistedNonces()` on a startup + timer cadence controlled by `PRESENCE_CLEANUP_INTERVAL_SECONDS`, and expose sweep config on `/health` (`presence-happy-path/app/server.cjs`, `presence-sdk/examples/local-reference-server.js`).
- **Operator truth-surface disambiguation added** so live diagnosis is less error-prone:
  - `/health` now exposes `store.kind`, `store.schema`, `store.path`, `store.surface`, and `store.capabilities`
  - startup logs identify the authoritative store surface/path
  - clean retest/reset procedure is documented in `docs/presence-live-retest-reset-playbook.md`

## 3) Non-canonical / optional / experimental
- **APNs wake path** is optional and non-authoritative (`docs/presence-push-setup-vs-steady-state.md` and `docs/README.md`).
- **Background proof/renewal guarantees** remain best-effort and are not the canonical product promise (`docs/presence-known-limitations.md`, `docs/presence-pending-proof-request-architecture.md`).
- **File-backed linkage store** in `presence-sdk` remains functional and hardened, but not the preferred long-term production store (`docs/presence-known-limitations.md`, `projects/presence-sqlite-design-2026-03-21.md`).
- **Local measurement PASS** is not equivalent to server-access PASS unless verified flow completes.

## 4) Remaining follow-ups / backlog
- **Phase 2 is fully closed.** The final real-device happy-path replay of pending-proof `respond` succeeded on live server, and a fresh latest-deploy clean retest also succeeded after authoritative unlink → relink → new request.
  - Evidence is tracked in:
    - `projects/presence-pending-proof-respond-live-validation-2026-03-23.md`
    - `projects/presence-phase2-closeout-2026-03-23.md`
    - `docs/presence-live-retest-reset-playbook.md`
- Finish **reliable APNs live delivery path** only if push is revisited as an optional wake-path. It is not part of the canonical correctness path.
- Consider upgrading the live server runtime to a supported Node version (`>=20`) because deployment currently emitted `EBADENGINE` warnings for `@peculiar/x509` and `better-sqlite3` under Node `v18.19.1`, even though the service restarted successfully.
- Repo-publication hygiene remains a separate follow-up track:
  - strengthen root orientation (`README` / entry map)
  - archive dated/internal review notes
  - clarify reference/demo boundaries
  - tighten ignore patterns for generated/local artifacts
- `SqliteLinkageStore` now uses a versioned schema migration path with `_schema_migrations` and explicit schema setup, matching the verifier's migration style while keeping SQLite-first single-team ergonomics.

## 5) Notes for future reviewers/operators
- Single source of truth for deployable server runtime should stay in-repo (`presence-happy-path/app/server.cjs`) and be installed via tarball+restart, not manual drift edits on VPS.
- `PRESENCE_SERVICE_DOMAIN`, `ROUTE_BASE_PATH`, and `PUBLIC_BASE_URL` are distinct knobs:
  - trust domain/prefix: `PRESENCE_SERVICE_DOMAIN` + `/.well-known/presence.json`
  - inbound path mounting: `ROUTE_BASE_PATH`
  - client-facing URLs: `PUBLIC_BASE_URL`
  - see `docs/presence-server-routing-guide.md`.
- Prefer adding future state notes as short dated entries in `projects/` plus this closeout doc when direction changes.
