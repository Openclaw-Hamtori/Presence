# Presence binding path investigation — 2026-03-21

## Scope
Investigated how `presence-test-app` can under-represent linked services/accounts even before UI rendering.

Files inspected:
- `presence-test-app/src/state/presenceState.ts`
- `presence-test-app/src/service.ts`
- `presence-test-app/src/sync/linkedBindings.ts`
- `presence-test-app/App.tsx`

---

## Main finding

There is still a real app-side risk that local `serviceBindings` can under-represent the full intended list, even after the live server fixes.

This is not only a rendering issue.

---

## Relevant code-path findings

### 1) `measure()` can recreate state from only the existing local bindings
File: `presence-test-app/src/service.ts`

When a fresh state is created, it uses:
- `serviceBindings: existingState?.serviceBindings`
- `linkedDevice: existingState?.linkedDevice`

So a new state inherits whatever local list already exists.
If local state is incomplete, state recreation preserves that incompleteness.

---

### 2) `updatePresenceSnapshot()` preserves current local bindings only
File: `presence-test-app/src/state/presenceState.ts`

`updatePresenceSnapshot()` runs:
- `serviceBindings: touchBindingsForMeasurement(state.serviceBindings, ...)`

This means measurement/proof refresh updates metadata on the current local list, but does not perform any authoritative reload of the full binding set.

---

### 3) `syncLinkedBindings()` only works from local bindings
File: `presence-test-app/src/sync/linkedBindings.ts`

The sync path starts from:
- `state.serviceBindings.filter(...)`

So sync only verifies/retries bindings that are already present locally.
If a binding is missing from local state, sync cannot rediscover it.

---

### 4) `addOrUpdateServiceBinding()` intentionally collapses active bindings by logical key
File: `presence-test-app/src/state/presenceState.ts`

Current behavior:
- first tries exact `bindingId`
- then falls back to active binding with same `(serviceId, accountId)`
- removes active bindings with same `(serviceId, accountId)` before pushing the new one

Implication:
- if product semantics allow multiple active bindings sharing the same `serviceId + accountId`, local state will collapse them into one
- even if current product expectation is more like one binding per service/account pair, this remains a cardinality-sensitive merge rule and should be treated explicitly, not implicitly

---

### 5) Service-tab hydration is now better, but still additive on top of local state
File: `presence-test-app/App.tsx`

Current app behavior now:
1. try `GET /presence/devices/:deviceIss/bindings`
2. fallback to `audit-events + linked-account status`
3. merge hydrated bindings with local bindings for display

This improves display, but it does not yet make the local persisted state itself authoritative.
So the display path is improved, while the underlying local-state lifecycle may still stay partial.

---

## Practical implication

Even after server-side persistence and device-bindings endpoint were fixed, the app can still drift if:
- local state starts incomplete
- measurement/renewal/update keeps preserving the incomplete local list
- sync only operates on the incomplete list

So the next app-side hardening step is likely one of:

### Option A — authoritative backfill into persisted local state
When Service tab opens, app foregrounds, or state loads:
- fetch authoritative device bindings from server
- merge/write them back into persisted `PresenceState.serviceBindings`

### Option B — explicit separation of display cache vs persisted operational state
Maintain:
- operational local bindings for sync/retry
- separate authoritative display cache for full server-backed list

Option A is simpler for product correctness if the server endpoint is now reliable.

---

## Recommended next step

1. Keep the new live server authoritative endpoint as the primary source.
2. Add an app-side path that writes hydrated authoritative bindings back into persisted local state, not just UI memory.
3. Review whether `(serviceId, accountId)` collapse is truly intended product behavior.
4. Re-test with fresh bindings created on the now-persistent live server.
