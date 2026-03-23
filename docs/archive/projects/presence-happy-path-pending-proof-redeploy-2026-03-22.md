# Presence happy-path pending proof request redeploy — 2026-03-22

## Goal

Redeploy the live Noctu happy-path server so it exposes the pending proof request routes from the repo-tracked server source:

- `POST /presence/linked-accounts/:accountId/pending-proof-requests`
- `GET /presence/linked-accounts/:accountId/pending-proof-requests`
- `GET /presence/pending-proof-requests/:requestId`
- `POST /presence/pending-proof-requests/:requestId/respond`

This note assumes the current VPS model is still:

- app dir: `/home/openclaw/presence-happy-path/app`
- entry file: `/home/openclaw/presence-happy-path/app/server.cjs`
- SDK installed from local tarballs, not from npm registry
- systemd unit: `presence-happy-path.service`

The repo-tracked deploy source is now:

- `presence-happy-path/app/server.cjs`

Canonical public contract for this redeploy:

- public Presence API base for mobile-facing/trust-facing sync URLs: `https://noctu.link/presence-demo/presence`
- `service_domain` remains host-only: `noctu.link`
- host-root trust metadata used by mobile: `https://noctu.link/.well-known/presence.json`
- required `allowed_url_prefixes`: `["https://noctu.link/presence-demo/presence"]`

## What changed in the server source

The tracked `server.cjs` now intentionally exposes the live happy-path surface, including:

- persistent storage root under `var/presence`
- `/.well-known/presence.json` payload generation from `PUBLIC_BASE_URL`, which for Noctu must be `https://noctu.link/presence-demo` so the emitted allowed prefix is `https://noctu.link/presence-demo/presence`
- linked proof request routes
- pending proof request create/list/get/respond routes
- linked status / unlink / device revoke / device bindings / audit routes

## Local build and validation before upload

From the repo root:

```bash
npm test -w presence-sdk
node --check presence-happy-path/app/server.cjs
```

Build fresh tarballs from each package directory so the VPS does not keep using stale SDK code:

```bash
cd /Users/chaesung/Desktop/Presence_GPT/presence-verifier
npm pack

cd /Users/chaesung/Desktop/Presence_GPT/presence-sdk
npm pack
```

Expected artifacts:

- `/Users/chaesung/Desktop/Presence_GPT/presence-verifier/presence-verifier-0.1.0.tgz`
- `/Users/chaesung/Desktop/Presence_GPT/presence-sdk/presence-sdk-0.1.0.tgz`

## Upload to the VPS

Copy three files to the live app directory:

```bash
scp \
  /Users/chaesung/Desktop/Presence_GPT/presence-verifier/presence-verifier-0.1.0.tgz \
  /Users/chaesung/Desktop/Presence_GPT/presence-sdk/presence-sdk-0.1.0.tgz \
  /Users/chaesung/Desktop/Presence_GPT/presence-happy-path/app/server.cjs \
  noctu:/home/openclaw/presence-happy-path/app/
```

## Install and restart on the VPS

On `noctu`:

```bash
cd /home/openclaw/presence-happy-path/app

cp server.cjs server.cjs.bak.$(date +%Y%m%d-%H%M%S)

npm install ./presence-verifier-0.1.0.tgz ./presence-sdk-0.1.0.tgz

systemctl show presence-happy-path.service --property=Environment --no-pager

node --check server.cjs

sudo systemctl restart presence-happy-path.service
systemctl status presence-happy-path.service --no-pager
```

Notes:

- install both tarballs together so `presence-sdk` resolves against the local `presence-verifier` tarball instead of drifting to whatever the host last had
- do not patch `node_modules/presence-sdk` in place; the repo-tracked `server.cjs` plus tarball reinstall is the canonical path now
- before restart, confirm the unit/environment still sets `PUBLIC_BASE_URL=https://noctu.link/presence-demo`; if it drifts to `https://noctu.link`, the server will emit the wrong public sync URLs and wrong allowed prefix

## Smoke checks after restart

Basic health and trust metadata:

```bash
curl -sSf https://noctu.link/presence-demo/health
curl -sSf https://noctu.link/.well-known/presence.json
```

Route-existence checks that do not require a real proof:

```bash
curl -sS -X POST \
  https://noctu.link/presence-demo/presence/linked-accounts/nonexistent/pending-proof-requests

curl -sS \
  https://noctu.link/presence-demo/presence/pending-proof-requests/ppreq_missing
```

Expected behavior:

- create on a nonexistent account returns `404` with `ERR_BINDING_NOT_FOUND`
- get on an unknown request id returns `404` with `ERR_PENDING_PROOF_REQUEST_NOT_FOUND`
- `https://noctu.link/.well-known/presence.json` returns `allowed_url_prefixes: ["https://noctu.link/presence-demo/presence"]`
- that prefix is broad enough to cover both `/presence-demo/presence/linked-accounts/...` and `/presence-demo/presence/pending-proof-requests/...`
- if the well-known payload instead advertises `https://noctu.link/presence`, mobile trust validation will still reject recovered binding sync URLs during hydration

If you have a real linked account available, confirm the live create/get path:

```bash
curl -sS -X POST \
  https://noctu.link/presence-demo/presence/linked-accounts/<accountId>/pending-proof-requests

curl -sS \
  https://noctu.link/presence-demo/presence/pending-proof-requests/<requestId>
```

## What this does not prove by itself

This redeploy only proves the live server can now create, expose, and resolve pending proof requests.

It does **not** by itself prove:

- the mobile app has already been redeployed to hydrate/use the pending request surface in production
- the host-root `https://noctu.link/.well-known/presence.json` has actually been updated/redeployed to the matching allowed prefix
- a real device has completed `/presence/pending-proof-requests/:requestId/respond` end to end against the redeployed server

Those are follow-up live validation steps after the VPS rollout.
