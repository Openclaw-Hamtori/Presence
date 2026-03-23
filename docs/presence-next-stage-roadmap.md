# Presence Next-Stage Architecture & Roadmap (Post-Stabilization)

_Last updated: 2026-03-22_

## Scope and framing

This document defines the **next implementation stage** after stabilization, with one hard constraint:

- **APNs / app-push is intentionally excluded from this roadmap.**

The team’s canonical behavior remains:

**`link once -> service requests PASS -> user opens Presence -> pending request hydrates -> orb -> fresh proof -> server verify`**

This is a design/implementation plan document for what to build next, not a speculative product strategy.

---

## Current state summary

What is already in the reference stack as of this writing:

- Link session flow and verification are working end-to-end.
- Canonical authoritative server truth model is established (`presence-public-architecture`, `presence-integration-quickstart`).
- Durable-ish pending-proof surface exists at API level (`/presence/linked-accounts/:accountId/pending-proof-requests`, `/presence/pending-proof-requests/:requestId`, `/presence/pending-proof-requests/:requestId/respond`, plus `pending_url` in initial link metadata).
- App foreground path can hydrate pending requests and submit proofs without a fresh deeplink.
- Filesystem-based persistence exists and is used in reference code paths.
- Server route/config separation has been clarified in `presence-server-routing-guide`.

Current limitations preventing true self-host production credibility:

- Reference persistence is still mostly file-backed (`FileSystemLinkageStore`); durable shared state under concurrency is incomplete.
- A `RedisLinkageStore` exists in `presence-sdk` and serializes all entities over a Redis-like client, but it uses a full-blob read/write pattern — no row-level atomicity or transactional nonce safety.
- Nonce/request lifecycle is not fully decoupled for long-lived reliability across restart/pod churn.
- `InMemoryTofuStore` was the default in-memory TOFU implementation; for sqlite-first deployments `PresenceClient` can now auto-pick `SqliteTofuStore` when linked via SQLite-backed linkage persistence, preserving Android TOFU across restarts.
- Authz/authn boundaries between public app APIs, operator actions, and service requests still need hardening.
- Operational controls, alerting hooks, and tenant-safe isolation are still lightweight.

---

## Why next bottlenecks are server/ops, not app

The mobile app path is now close to stable for the primary flow:

- It already supports open → hydrate pending request → orb proof → respond path.
- There are no blocking app-side protocol changes needed to hit the next milestone.

Remaining blockers are all server-side:

1. **Durability under real deployment:** single-process file store is not enough for scaling, restarts, multiple instances.
2. **State correctness:** pending request state and nonce lifecycle need stronger guarantees for crash/retry/restart behavior.
3. **Multi-tenant safety:** explicit tenant/auth boundaries are needed before broad operator access.
4. **Operations:** noisy incident handling requires auditable controls, metrics, and runbook-level documentation.
5. **Package/control separation:** we need to stop overloading reference server and SDK for production operational needs.

If we do not fix these first, adding more app polish will not increase production robustness.

---

## Target architecture direction

### 1) Data-first, server-authoritative, DB-backed runtime

- Move from in-process file-backed linkage to **shared DB-backed stores** for:
  - linked accounts
  - linked devices
  - nonce/request lifecycle
  - pending proof request status
  - audit/log metadata
- Keep app as UX/presentation + proof originator.
- Keep verifier as cryptographic engine (pure, side-effect free).
- Keep `presence-sdk` as protocol/state orchestration layer.
- Keep reference server package as one concrete deployable binding of SDK into a full API + persistence adapters.

### 2) Two-level request model

- `linked account request nonce` (existing): short-lived proof challenge.
- `pending proof request` (existing API, needs durability): the API surface and state type (`pending | verified | recovery_required | expired | cancelled`) are already implemented; what is missing is durable, shared persistence and enforced state machine transitions.

The pending request must survive restarts and be idempotently consumed.

### 3) Shared but scoped control plane

- Keep a stable **service-facing API** for end-user flows.
- Add a separate **operator/admin API** (or privileged actions) for:
  - request cleanup
  - tenant/config views
  - nonce/request inspection for support
  - manual remediation in recovery scenarios

---

## Phase plan

### Phase 1 — DB-backed store + durable shared nonce/pending state + self-host model

**Primary goal:** replace reference file defaults with production-credible persistence and deterministic lifecycle semantics.

- Implement repository-level store abstraction in `presence-sdk` with at least one production adapter (Postgres/SQLite first-class choice; MySQL later optional).
- Align on schema naming with the existing SQLite design (`projects/presence-sqlite-design-2026-03-21.md`) before implementation. Current domain model uses `ServiceBinding`, not "linked account" — table names must reflect the actual data model.
- Add/solidify schemas:
  - `service_bindings` (not `linked_accounts` — a binding is scoped to (serviceId, accountId, deviceIss))
  - `link_sessions`
  - `linked_devices`
  - `pending_proof_requests`
  - `nonce_store` (or nonce table) with single-use + expiry semantics
  - `tofu_store` with per-iss public key and revocation semantics (`SqliteTofuStore` now available for SQLite-backed single-service deployments)
  - `audit_events` (not `proof_events` — matches existing `LinkageAuditEvent` type)
- Ensure **nonce state is durable/shared**, not ephemeral:
  - issuance, single-use marking, and verification reads should be atomic transactionally.
  - duplicate consumption must fail safely.
- Add explicit pending request state machine (`pending`, `verified`, `expired`, `recovery_required`, `cancelled`) and deterministic expiry checks.
- Persist and hydrate pending requests by `accountId` and binding identity, not local cache.
- Add DB-backed migration strategy and bootstrap docs for:
  - schema creation
  - env vars for database connection
  - startup checks and smoke-test data path
- Add self-host documentation bundle:
  - `docs/presence-self-hosting.md` (or equivalent)
    - architecture diagram (text)
    - required env var matrix (`ROUTE_BASE_PATH`, `PUBLIC_BASE_URL`, `PRESENCE_SERVICE_DOMAIN`, DB config, signing keys)
    - request/response contracts
    - deployment steps
    - verification checklist (link, nonce verify, pending request respond)
- Update existing deployment notes so this becomes the default reference stack, not a “labs” setup.

**Acceptance criteria (phase 1):**
- Re-running the same flow across process restart and second instance returns same outcome.
- Pending proof request can be created, listed, responded-to, and idempotently marked terminal.
- Nonce replay attempts are reliably rejected after successful verification.

---

### Phase 2 — Verifier / SDK / server boundary cleanup

**Primary goal:** harden package boundaries so integrations can consume stable contracts and operators can self-host safely.

- Split responsibilities explicitly:
  - `presence-verifier`: pure proof verification + cryptographic checks.
  - `presence-sdk`: protocol primitives, state transitions, and typed store contracts.
  - `presence-happy-path` / reference server: transport + route handlers + lifecycle orchestration only.
- Introduce adapter-style boundaries in SDK interfaces:
  - storage adapters
  - audit/event sinks
  - transport adapters (webhook/push optional)
- Enforce service/domain contract boundaries:
  - reject non-trusted return URLs
  - explicit URL validation across all request entry points
- Clarify tenant scoping in data model:
  - tenant or service partitioning on every persistent row
  - prevent cross-tenant reads/writes by API contract and query constraints
- Create explicit service auth model (details in open questions but initial baseline):
  - per-service credential (API key or signed JWT)
  - token scopes: `presence:nonce`, `presence:verify`, `presence:pending:create`, `presence:status:read`
  - key rotation and revocation strategy
- Standardize package exports for external users:
  - separate `api`, `store`, `types`, `errors` entrypoints
- Add integration matrix for implementers:
  - minimal in-memory / reference
  - production DB-backed
  - operator/test variants

**Acceptance criteria (phase 2):**
- A service implementation can upgrade only specific packages without changing route semantics.
- Tenant boundaries can be asserted by tests from SDK layer down to route handler.
- Reference server composes SDK via dependency injection of store + auth + config.

---

### Phase 3 — Operator controls + observability + service auth / tenant clarification

**Primary goal:** make Presence operable and diagnosable under incident conditions.

- Operator actions (scoped and auditable):
  - force-cancel/request expiry extension
  - dry-run and cleanup scripts for stale requests
  - per-service readiness overrides for maintenance
  - key/device unlink tooling
- Observability:
  - structured request logs with correlation IDs
  - metrics: request create/consume latency, verification failure ratios, nonce reuse attempts, pending request expiry reasons
  - health endpoints with dependency checks (`/ready`, `/healthz` already aligned + DB checks)
- Audit and incident playbook:
  - security incident response notes
  - runbook for “stuck pending proof requests”, “recovery_required flood”, “db lock/timeouts”
- Service auth/tenant model finalization:
  - explicit tenant ownership for linked account and pending requests
  - authorization checks on every endpoint that reads or mutates tenant-scoped state
  - per-tenant rate limits and quotas
- Add ops docs for safe deployment and rollback of auth key/DB migrations.

**Acceptance criteria (phase 3):**
- Operator can identify and repair stale state without full redeploy.
- Support can trace each verify outcome to tenant, service, account, and request lineage.
- Mis-tenant access attempts are denied and logged.

---

## Package / store / control-plane implications

### Package implications

- `presence-verifier`: no deployment assumptions, no persistence concerns.
- `presence-sdk`: canonical domain model + store interface + service APIs.
- `presence-happy-path`: concrete reference server + default adapters + docs by example.
- `presence-test-app` / mobile remains unchanged protocol consumer (except integration with new persistence contracts).

### Store implications

- Move from implicit mutable store behavior to explicit transactional boundaries.
- Keep a small adapter interface surface to avoid lock-in:
  - create/read/update/list for each core aggregate
  - transactions where required for nonce/request atomicity
- Provide migration path with idempotent init scripts or migration tool hooks.

### Control-plane implications

- Introduce an operator surface separated from user/service flows.
- Keep operator actions out of client-visible mobile contract.
- Log all operator writes with actor identity and reason to support audit.

---

## Non-goals (explicit)

- **No app push/APNs as a canonical path** in this roadmap.
- No guarantee of background/force-quit behavior beyond best effort.
- No silent/full replacement of initial link session model.
- No rewrite of verification cryptography.
- No broad SDK API overhaul that breaks existing integration contracts in Phase 1.
- No dependency on external identity provider before core DB/auth boundary is complete.

---

## Open questions / decisions to make

- DB choice for first-party stack: **Postgres** vs **SQLite** for small self-host deployments?
- Service auth scheme:
  - static API keys vs short-lived JWT service tokens?
  - what claims/scopes to support at launch?
- Tenant model:
  - explicit `tenant_id` column vs namespace inferred from service key?
  - can a tenant own multiple services? if yes, how is policy partitioned?
- Replay safety semantics:
  - keep strict one-time nonce consumption globally or per-bound account partitioning?
- Operational retention:
  - TTL for completed/stale pending requests
  - event retention period for audit/export
- Rate limiting policy:
  - global versus tenant-aware enforcement for request creation and verify attempts.

---

## Tracking and next doc artifacts

Treat this as the implementation blueprint for the next cycle. For phase execution, add dated entries under `projects/` for concrete work and validation, and update `docs/STATUS.md` with completion status as phases land.
