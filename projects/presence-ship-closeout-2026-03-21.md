# Presence ship closeout — 2026-03-21

## Summary

Today closed the remaining ship-blocking Presence issues across both the app flow and the server persistence layer.

The key outcome is that Presence now demonstrates the full intended loop on a real device and live server:
- app measures health data
- app reaches PASS
- app sends verified proof to server
- server persists authoritative binding/device truth
- automatic renewal repeats without collapsing server state

## What was wrong

### 1. App-side false-success window
There was a period where the app could look locally refreshed while the server had not actually been updated.

This meant:
- PASS / renewal could appear successful in the app
- but server authoritative truth (`lastVerifiedAt`, `stateValidUntil`, audit/update path) did not necessarily advance

### 2. Server-side stale/broken SDK persistence behavior
The live Noctu happy-path server was still running an older `presence-sdk` storage path with two dangerous properties:
- corrupted JSON could be treated like an empty store on the next mutation
- file-store writes were not hardened enough at the storage boundary

This matched the live symptom we observed multiple times:
- audit event append survived
- but `bindings` / `devices` disappeared
- and sometimes the store file showed tail corruption (`JSONDecodeError: Extra data`, seam like `}774086508,`)

## What was fixed

### App / renewal / sync side
The app-side flow was tightened so renewal success is only trusted when the verify/write-back path actually completes, rather than just because local UI/state advanced.

### Server / SDK side
`presence-sdk/src/linkage.ts` was hardened so that:
- corrupted JSON fails closed instead of silently becoming an empty store
- writes use temp file -> fsync -> rename semantics
- mutation boundaries are serialized per store path
- `mutate()` behaves more like a real transactional staging boundary

Regression tests were added for:
- corrupted JSON fail-closed behavior
- cross-instance mutation serialization against the same file

## Live deployment notes

The Noctu server uses:
- `/home/openclaw/presence-happy-path/app/server.cjs`
- `/home/openclaw/presence-happy-path/app/node_modules/presence-sdk`

So fixing repo source alone was not enough.
The updated `presence-sdk` tarball had to be rebuilt and reinstalled on the live server, then the service restarted.

## Live verification performed

After the SDK redeploy and store reseed, real-device renewals were re-tested against the live Noctu server.

Observed good state after repeated renewals:
- linked account readiness stayed `ready`
- binding remained present
- device remained present
- `lastVerifiedAt` advanced
- `stateValidUntil` advanced
- `reauth_succeeded` audit events accumulated
- store counts remained stable (`bindings: 1`, `devices: 1`)

This is the main reason today counts as a meaningful stabilization milestone rather than another partial app-only fix.

## Practical conclusion

Presence requires both sides to be correct:
- the app must actually measure, prove, and call verify correctly
- the server SDK/store must preserve authoritative truth correctly

Today’s work fixed both layers and aligned them again.

## Remaining caution

This hardens the current single-host JSON store significantly, but it is still a file-based authoritative store.
For longer-term robustness, SQLite/WAL (or another transactional store) remains the likely next authoritative-store step.
