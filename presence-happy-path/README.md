# presence-happy-path

Reference backend surface for Presence.

## What this directory is

This package is the repo-tracked reference server shape used for the deployable happy-path backend.
The main runtime entrypoint is:

- `app/server.cjs`

Use it when you want a concrete example of how `presence-sdk` is bound into HTTP routes, env config, and persistence for a small self-hosted deployment.

## What it is not

- not the full product spec
- not the only deployment topology
- not a promise that every file here is production-hardened for every environment

Canonical architecture/docs still live in:
- `../docs/README.md`
- `../docs/presence-integration-quickstart.md`
- `../docs/presence-server-routing-guide.md`
- `../docs/presence-production-runbook.md`
- `../docs/STATUS.md`

## Current operator note

As of the latest 2026-03-24 release-prep pass:
- mobile trust metadata is guarded at runtime for link-session creation/read
- canonical short-link hydration has been validated live on real device + live server
- `PRESENCE_SERVICE_DOMAIN`, `PUBLIC_BASE_URL`, and `ROUTE_BASE_PATH` must be kept conceptually separate
- the next live validation target is a new TestFlight build plus fresh/new-device revalidation on that build

## Minimal orientation

If you are trying to understand or run this server, start with:
1. `app/server.cjs`
2. `../docs/presence-server-routing-guide.md`
3. `../docs/presence-production-runbook.md`
4. `../docs/presence-live-retest-reset-playbook.md`
