# Presence happy-path live sync note — 2026-03-21

## What was already committed in repo

### 1) SDK / example server pattern added
- Commit: `dd4204c`
- Summary: added authoritative device-bindings endpoint pattern
- Endpoint:
  - `GET /presence/devices/:deviceIss/bindings`
- Reflected in:
  - `presence-sdk/src/api.ts`
  - `presence-sdk/examples/backend-completion-reference.ts`
  - `presence-sdk/examples/local-reference-server.js`

### 2) Test app hydration updated
- Commit: `ec958c0`
- Summary: Service tab now hydrates bindings from device endpoint first, then falls back to audit-events + linked-account status, then merges with local bindings.
- Reflected in:
  - `presence-test-app/App.tsx`
  - `TIME_TEST_CHECKLIST.md`

---

## What was patched directly on the live server

Target host:
- `noctu`
- systemd service: `presence-happy-path.service`
- runtime file: `/home/openclaw/presence-happy-path/app/server.cjs`

### Live patch 1 — persistent linkage store
Previous live behavior:
- server used `mkdtempSync(join(tmpdir(), ...))`
- linkage store path changed on every service restart
- result: bindings/devices/audit state were not durably preserved across restarts

Applied live change:
- replaced tmp-root usage with persistent storage root
- current logic:
  - `const storageRoot = process.env.PRESENCE_STORAGE_ROOT || join(process.cwd(), "var", "presence");`
  - `mkdirSync(storageRoot, { recursive: true });`
  - `const storePath = fileLinkageStorePath(storageRoot);`

Observed result:
- persistent directory now exists at:
  - `/home/openclaw/presence-happy-path/app/var/presence`

### Live patch 2 — authoritative device bindings endpoint
Added route to live `server.cjs`:
- `GET /presence/devices/:deviceIss/bindings`

Behavior:
- loads device via `presence.linkageStore.getLinkedDevice(deviceIss)`
- loads bindings via `presence.linkageStore.listBindingsForDevice(deviceIss)`
- filters bindings to current `serviceId`
- sorts by `lastVerifiedAt || lastLinkedAt` descending
- returns `{ ok, device, bindings }`

### Live patch 3 — endpoint contract updated
Live `endpointContract` was updated with:
- `deviceBindingsPath: route("/presence/devices/:deviceIss/bindings")`

### Service restart
After patching live `server.cjs`:
- restarted `presence-happy-path.service`
- service came back healthy
- endpoint responded successfully

---

## Important investigation finding

A major root cause was confirmed on the live server:
- the old live server stored linkage state in a tmp directory
- therefore historical linked bindings were not being durably preserved in the expected way

This strongly explains:
- why public `audit-events` often looked nearly empty
- why authoritative linked bindings were missing
- why Service-tab restoration based on public server data could fail even when prior test history seemed to exist

---

## Recovery / historical data check performed

Checked old tmp stores under paths like:
- `/tmp/presence-public-reference-server-*/presence-linkage-store.json`

Findings:
- several prior tmp store files still existed
- however, they contained:
  - `bindings = 0`
  - `devices = 0`
  - only small numbers of `auditEvents`
- sampled audit events were mostly `link_started`, not durable linked binding state

Implication:
- historical linkage state is not reliably recoverable from currently remaining live tmp store artifacts
- going forward, newly created bindings should persist correctly because the live server now uses a persistent store path

---

## Current operational status

### Repo status
- SDK/example changes: committed and pushed
- test-app changes: committed and pushed

### Live server status
- patched directly in place on VPS
- not yet mirrored into a dedicated deployable live-server source file in the repository

---

## Recommended next step

1. Recreate a few fresh links on the now-persistent live server
2. Verify that:
   - `/presence/devices/:deviceIss/bindings` returns full linked set
   - Service tab shows all linked services/accounts for the device
3. After confirming behavior, mirror the live `server.cjs` delta back into a repo-tracked deploy source or ops note so future deploys cannot regress to tmp storage
