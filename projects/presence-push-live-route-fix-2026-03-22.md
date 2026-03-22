# Presence push routing fix — 2026-03-22

## Problem
App-facing API base is `https://noctu.link/presence-demo/presence`, but live server handlers only matched raw paths under `/presence/...`. Since Caddy mounts backend at `/presence-demo`, requests to `/presence-demo/presence/...` were not matched and returned `ERR_NOT_FOUND`, so real device push-token registration never reached server.

## Fix applied
- Updated `presence-happy-path/app/server.cjs` to support route-base stripping:
  - Added `normalizeRouteBasePath()` and `stripRouteBase()` helpers.
  - Read `ROUTE_BASE_PATH` from env.
  - Normalized each request path before all route matching.
- Resulting behavior: with `ROUTE_BASE_PATH=/presence-demo`, live URL `/presence-demo/presence/...` maps internally to `/presence/...`.
- Committed as `d37d550` with message: `fix: honor route base path for production API mounting`.

## Deployment+validation steps done
- Updated live file and restarted `presence-happy-path.service` on `noctu`.
- Verified route now resolves:
  - `POST /presence-demo/presence/linked-accounts/x/pending-proof-requests` returns JSON instead of 404.
  - `POST /presence-demo/presence/devices/<linkedDeviceIss>/push-tokens` now returns 200/`ERR_DEVICE_NOT_FOUND` for missing device and success for valid linked device.
- Verified local syntax: `node --check presence-happy-path/app/server.cjs`.

## Next step for real APNs delivery
- Have user/device retry iPhone app registration flow now.
- Confirm mobile log shows `maybeSyncStoredPushToken` call and server response on `/presence-demo/presence/devices/<deviceIss>/push-tokens` (currently expected 200 + `pushToken`).
- Then validate APNs delivery path with a real pending-proof signal.
