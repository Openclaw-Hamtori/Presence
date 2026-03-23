# Phase 1/2 Starter Pack — Baseline + Execution Plan

_Last updated: 2026-03-23_

This document is the stable starting gate for Phase 1 work.
It captures the **current known-good Presence regression baseline** and a concrete, repo-grounded execution plan that preserves the single-server/single-DB happy path as the default deployment model.

---

## A) Durable baseline regression checklist (known-good state)

## Scope and intent

- This is the **current production-equivalent baseline** for the current happy-path implementation.
- It is not “all possible tests forever”; it is the minimum set to keep:
  - canonical link/on-demand proof flow intact,
  - small-team deployments runnable,
  - and optional complexity behind explicit gates.
- Baseline status should be re-verified before shipping any Phase 1/2 slice.

## Baseline truth model (must hold)

1. Canonical app server flow stays:
   - `link once -> service requests PASS -> user opens Presence -> pending request hydrates -> user provides fresh proof -> server verifies`.
2. Push/APNs is optional (best-effort) and not required for correctness.
3. SQLite-first persistence path remains a valid and complete small-team deployment route.
4. Reference server (`presence-happy-path/app/server.cjs`) remains runnable standalone.
5. “Happy path” remains pushless and no-rewrite:
   - Existing endpoints and payload contracts continue to behave as before unless explicitly versioned.

## Preflight (must pass before any code changes)

### Automated preflight
- [ ] `npm run check:mobile-sync`
- [ ] `npm run test -w presence-sdk`
- [ ] `npm run test -w presence-verifier`
- [ ] `npm run type-check -w presence-mobile`
- [ ] `npm run type-check -w presence-test-app`

### Reference server runtime baseline
- [ ] `presence-happy-path` starts with:
  - `ROUTE_BASE_PATH` set as deployed (`/presence-demo` on Noctu snapshot)
  - `PUBLIC_BASE_URL` and `PRESENCE_SERVICE_DOMAIN` set to canonical origin/domain used by clients
- [ ] Health/ready endpoints are reachable and return expected success when server is up.
- [ ] Route mounts and trust metadata endpoints remain unchanged from baseline: check `presence-happy-path/app/server.cjs`.

### Functional baseline (manual)
- [ ] iOS app installs and launches from clean state (no crash).
- [ ] PASS scoring UI shows expected ready/not-ready states.
- [ ] Link-by-code and link-by-QR create session, open session, and allow approval prompt.
- [ ] Trust boundary checks work in `/.well-known/presence.json` with HTTPS domain and trust failures as expected.
- [ ] App can open a `pending_url` and hydrate pending proof request UI.
- [ ] Fresh proof from orb path verifies successfully via live server (`/presence/pending-proof-requests/:requestId/respond` + canonical verify path).
- [ ] Re-deep-link with expired/invalid nonce produces deterministic failure (`nonce expired or not issued by service`) and does not hard-fail unrelated app state.

### Persistence and data-grounded checks (baseline-only)
- [ ] Existing file-backed linkage is consistent under normal flow on single process.
- [ ] Recovery-required/mismatch behavior is preserved and visible in logs/docs.
- [ ] No server behavior relies on hidden push wakeups for readiness.

### Exit rule
- Do not proceed to implementation slice unless baseline is green, and log exceptions explicitly (time + reason).

---

## B) Phase 1 implementation plan, grounded in current repo

The goal of this phase is **opt-in production-hardening**, without destabilizing small-team flow.

### Slice 0 — Baseline lock-in (this pack)
- Keep this checklist as the project contract.
- Add a lightweight readiness harness so engineers can run Phase 1 checks in one command.

### Slice 1 — Schema and store readiness for DB-backed path
- Inspect existing store interfaces in:
  - `presence-sdk/src/linkage/*`
  - `presence-sdk/src/pending-proof-requests/*`
  - `presence-sdk/src/index.ts`
- Introduce explicit adapter contracts for persistence operations (minimal, additive) and keep existing filesystem adapter default behavior.
- Add type-safe boundary tests around adapter method behavior (read/list/create/update transition semantics).

### Slice 2 — Transaction-safe nonce + pending request lifecycle
- Implement atomicity wrappers in SDK/store layer where supported by adapters.
- Add explicit state transition assertions:
  - `pending -> verified`
  - `pending -> expired`
  - `pending -> recovery_required`
  - `pending -> cancelled`
- Ensure these transitions are represented in one place, then exercised by unit tests.

### Slice 3 — Self-host/deployment hardening without migration risk
- Add docs for single-server + single-DB mode as first-class path:
  - `sqlite` DSN / file path
  - initialization checks
  - startup validation notes
- Keep current file-backed defaults as fallback until DB migration feature-flag/test passes.

### Slice 4 — Release guardrails
- Add a “Phase 1 baseline” CI target that at minimum validates:
  - test/typecheck checks
  - no obvious API contract drift in `presence-happy-path/app/server.cjs`
  - optional smoke for pending-proof endpoint availability
- Require checklist re-validation in PRs affecting `presence-sdk`, `presence-happy-path`, `presence-mobile`, or deployment scripts.

---

## C) Safe starter implementation step completed in this pass

- Added lightweight non-invasive baseline readiness harness:
  - `scripts/phase1-baseline-smoke.mjs`
  - `npm run check:phase1-smoke`
- This harness executes read-only checks and mirrors the checklist preflight in code form.
- It does not modify runtime behavior or persistence paths.

## Next immediate implementation slice (recommended)

1. Add a small **baseline fixture test** in `presence-sdk` for pending-proof state transition invariants (no external storage dependency).
2. Expand `check:phase1-smoke` to include optional, explicit endpoint smoke calls against a configured local dev server.
3. Freeze this checklist link in `docs/README.md` and `docs/STATUS.md` as required pre-flight before any Phase 1 changes.