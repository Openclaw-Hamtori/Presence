# Presence production/deployment runbook

Use this for a first production-style deployment of the reference server (`presence-happy-path`) and local reference server parity checks.

## Platform scope (current)

- **Current runtime target is iOS-first.** `presence-mobile` implements the iOS app-attest/HealthKit flow end-to-end.
- Android transport/state shape entries are preserved for forward compatibility, but are not part of current public production guidance.

## Required environment and config

Before deployment, set these environment values:

- `PRESENCE_SERVICE_ID` (required): stable service identifier used in trust and session metadata.
- `PRESENCE_SERVICE_DOMAIN` (recommended): domain that serves `/.well-known/presence.json` for trust checks.
- `PUBLIC_BASE_URL` (required): public-facing base URL for route absolute URLs (no trailing slash).
- `ROUTE_BASE_PATH` (optional): mount path if server is behind a reverse proxy path segment.
- `PRESENCE_STORAGE_ROOT` (required): writable filesystem path for reference/server store files.

### Service boundary hardening for production-like deployments

Set these for production-like behavior:

- `PRESENCE_REFERENCE_AUTH_MODE=strict`
- `PRESENCE_SERVICE_API_KEY=<strong random secret>`
- optional: `PRESENCE_SERVICE_API_KEY` also readable as secret source for orchestration.

The server exposes callback endpoints publicly by design for mobile-to-server completion
(`POST /presence/link-sessions/:sessionId/complete`, `POST /presence/linked-accounts/:accountId/verify`, `POST /presence/pending-proof-requests/:requestId/respond`).
All other `/presence/*` endpoints are protected when `PRESENCE_SERVICE_API_KEY` is configured.

### Request-size guardrail

Set size limits to protect endpoint handlers from oversized payloads:

- `PRESENCE_MAX_BODY_BYTES` (optional, default `65536`).
- Lower this if you need tighter limits in front of hostile traffic.

### Practical abuse / rate-limiting posture

Reference implementations intentionally keep protocol-level hardening minimal and portable.
For public deployments, layer abuse controls at the edge/proxy first:

- enforce per-IP and per-service token request rate caps,
- add short burst limits on session/proof write endpoints,
- set connection/body size ceilings (`PRESENCE_MAX_BODY_BYTES`, load balancer limits),
- block repeated malformed requests rapidly and observe elevated `4xx`/parse errors,
- keep callback/public proof endpoints reachable but monitor abuse spikes.

Recommended quick defaults for a first production posture:

- `429` for request bursts above your chosen quota (at infra layer),
- `ERR_INVALID_*` response codes are deliberately stable for malformed body/path payloads on the reference server.

The reference server does not currently implement a distributed rate limiter by default; avoid adding a heavy framework in single-process reference deployments.

### Runtime health and cleanup tuning

- `PRESENCE_CLEANUP_INTERVAL_SECONDS` (default `300`, max `3600`, `0` disables sweep).
- `PRESENCE_PUSH_TRANSPORT` (`off`, `log`, optional `apns`).
- Ensure store surface and capabilities are visible in `/health` after startup.

## Deployment checklist

### 1) Preflight

- [ ] Confirm Node runtime, file permissions, and outbound network for `https://<PRESENCE_SERVICE_DOMAIN>`.
- [ ] Set required variables above and mount TLS/HTTPS terminator.
- [ ] Confirm route base path and PUBLIC base URL match client expectations.
- [ ] Confirm `PRESENCE_SERVICE_ID` is stable per environment (dev/stage/prod should differ).

### 2) Start and verify

- Start server with `node presence-happy-path/app/server.cjs` (or package-equivalent reference server path), or container/systemd equivalent.
- Verify:
  - `curl http://<host>:<port>/health`
  - `/.well-known/presence.json` returns configured `service_id` and `allowed_url_prefixes`.
  - Service callbacks and endpoints return JSON and no obvious auth regression.

### 3) Contract checks

Run from repo root:

```bash
npm run check:server-contract
npm run check:server-auth
npm run check:server-request-contract
```

Use for release-readiness smoke checks:

```bash
PRESENCE_SMOKE_LOCAL=1 npm run check:runtime-smoke
```

### 4) Runtime smoke (optional)

- `npm run check:runtime-smoke` (or `npm run check:phase1-smoke` for local harness pre-check)
- Keep `PRESENCE_SMOKE_LOCAL=1` for local server bootstrap checks, if your environment cannot hit remote.

### 5) Post-deploy rollback readiness

- Keep `PORT` and storage volumes in process manager config.
- Capture `/health` output for store kind/surface verification.
- Keep startup logs showing:
  - selected auth mode
  - active service API key status
  - optional trusted route base

## Common failure modes

- `ERR_AUTH_REQUIRED` on all service endpoints:
  - check `PRESENCE_SERVICE_API_KEY` and auth mode.
- `/.well-known/presence.json` unavailable:
  - verify `PRESENCE_SERVICE_DOMAIN` and any frontend host rewrite/proxy rules.
- callback routes returning 5xx:
  - validate client-generated `platform`/attestation metadata and trust-domain prefix mapping.
- `ERR_SERVICE_TRUST_INVALID (missing service_domain)` on fresh links from new devices:
  - check `service_domain` is present in the returned `qrUrl`/`deeplinkUrl` for initial links.
  - if absent, confirm `PUBLIC_BASE_URL` is HTTPS and `PRESENCE_SERVICE_DOMAIN` is set correctly.
- body parse failures:
  - check `ERR_REQUEST_BODY_TOO_LARGE` or `ERR_INVALID_JSON`, and ensure request payloads are sane.

## Canonical entry docs

- `README.md` (repo orientation)
- `docs/README.md` (documentation map)
- `docs/presence-public-architecture.md` (protocol)
- `docs/presence-integration-quickstart.md` (implementation order)
- `docs/presence-server-routing-guide.md` (route/env details)
