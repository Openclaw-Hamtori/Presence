# Presence happy-path deploy guardrails — 2026-03-21

## Why this note exists
The live Noctu happy-path server was patched directly on the VPS to fix real production/test-path issues. Those changes are operationally important and must not be lost on the next manual redeploy.

This note is the deploy-side guardrail until the live server source is fully mirrored into a repo-tracked deploy artifact.

Update on 2026-03-22:
- repo-tracked live source now exists at `presence-happy-path/app/server.cjs`
- pending proof request rollout steps live in `docs/archive/projects/presence-happy-path-pending-proof-redeploy-2026-03-22.md`

---

## Live service identity
- host: `noctu`
- systemd unit: `presence-happy-path.service`
- working dir: `/home/openclaw/presence-happy-path/app`
- entry file: `/home/openclaw/presence-happy-path/app/server.cjs`
- canonical public Presence API base for mobile/trust/public sync: `https://noctu.link/presence-demo/presence`
- canonical trust metadata URL for `service_domain=noctu.link`: `https://noctu.link/.well-known/presence.json`

Systemd definition currently points to:
- `ExecStart=/usr/bin/node /home/openclaw/presence-happy-path/app/server.cjs`

---

## Required live-server behaviors (must preserve on redeploy)

### 1) Persistent linkage storage
The server must NOT create a new tmp linkage-store root on each restart.

Required pattern:
- `const storageRoot = process.env.PRESENCE_STORAGE_ROOT || join(process.cwd(), "var", "presence");`
- `mkdirSync(storageRoot, { recursive: true });`
- `const storePath = fileLinkageStorePath(storageRoot);`

Why:
- previous tmp-root behavior caused linkage state loss across restarts
- this directly broke authoritative binding/device truth

Current live persistent dir:
- `/home/openclaw/presence-happy-path/app/var/presence`

### 2) Authoritative device-bindings endpoint
The live server must expose:
- `GET /presence/devices/:deviceIss/bindings`

Expected behavior:
- load device via `getLinkedDevice(deviceIss)`
- load bindings via `listBindingsForDevice(deviceIss)`
- filter to current `serviceId`
- sort by latest verification/link time descending
- return `{ ok, device, bindings }`

Why:
- the app now depends on this path as the authoritative source before fallback logic

### 3) Contract completeness
Endpoint contract should include:
- `deviceBindingsPath: route("/presence/devices/:deviceIss/bindings")`

### 4) Pending proof request surface
The live server should expose:
- `POST /presence/linked-accounts/:accountId/pending-proof-requests`
- `GET /presence/linked-accounts/:accountId/pending-proof-requests`
- `GET /presence/pending-proof-requests/:requestId`
- `POST /presence/pending-proof-requests/:requestId/respond`

Related trust requirement:
- `https://noctu.link/.well-known/presence.json` must advertise `allowed_url_prefixes: ["https://noctu.link/presence-demo/presence"]`
- do not advertise `https://noctu.link/presence`; mobile hydrated sync URLs live under `/presence-demo/presence/...`
- the prefix should stay broad enough to cover both linked-account and pending-proof-request routes, not only `/linked-accounts/...`

---

## Redeploy checklist

Before replacing or regenerating live `server.cjs`:
- [ ] Confirm the new source still uses persistent storage, not `mkdtempSync(tmpdir())`
- [ ] Confirm `GET /presence/devices/:deviceIss/bindings` route exists
- [ ] Confirm endpoint contract includes `deviceBindingsPath`
- [ ] Confirm `PUBLIC_BASE_URL=https://noctu.link/presence-demo` for the happy-path deployment so the emitted public API base is `https://noctu.link/presence-demo/presence`
- [ ] Confirm host-root trust metadata at `https://noctu.link/.well-known/presence.json` advertises `allowed_url_prefixes: ["https://noctu.link/presence-demo/presence"]`
- [ ] Run syntax check: `node --check server.cjs`
- [ ] Restart service: `sudo systemctl restart presence-happy-path.service`
- [ ] Verify unit health: `systemctl status presence-happy-path.service`
- [ ] Verify endpoint:
  - `curl https://noctu.link/.well-known/presence.json`
  - `curl https://noctu.link/presence-demo/presence/audit-events`
  - `curl https://noctu.link/presence-demo/presence/devices/<deviceIss>/bindings`

---

## Recommended longer-term cleanup

### Preferred future state
Mirror the live server code into a repo-tracked deployable source so the VPS is not the only canonical location.

Two acceptable directions:
1. make a dedicated repo-tracked `server.cjs` / `server.ts` for the Noctu happy-path deployment
2. generate the live file from a repo-tracked example/deploy template and document the deployment command clearly

### Why this matters
Right now:
- SDK/example behavior is in repo
- live server behavior is on VPS
- they are close, but not guaranteed to stay in sync unless explicitly maintained

---

## Current truth status
As of 2026-03-21:
- live VPS has been directly patched
- persistent store behavior is live
- authoritative device-bindings endpoint is live
- this file exists to reduce regression risk until deploy-source unification is completed
