# Presence authoritative binding write-back — 2026-03-21

## Purpose
After live-server persistence and the authoritative device-bindings endpoint were added, the app still had a local-drift risk:
- UI hydration could show a fuller binding set
- but persisted local `PresenceState.serviceBindings` could remain partial
- later measurement / renewal / sync would then continue from the partial local set

## Implemented direction
The test app now writes hydrated authoritative bindings back into persisted local state.

### Code changes
- Added state helper:
  - `mergeAuthoritativeServiceBindings(state, bindings)`
- Behavior:
  - merges hydrated authoritative bindings through the existing `addOrUpdateServiceBinding(...)` path
  - preserves current merge semantics while updating persisted local state

### App hydration flow
When Service modal hydration succeeds:
1. fetch from `GET /presence/devices/:deviceIss/bindings`
2. fallback to `audit-events + linked-account status` if needed
3. update in-memory hydrated display bindings
4. load persisted local state
5. if `persisted.iss === deviceIss`, merge hydrated bindings into persisted state
6. save updated local state back to AsyncStorage

## Expected effect
- authoritative server-backed bindings are no longer only a temporary UI overlay
- future local measurement / renewal / sync cycles can start from a fuller persisted binding set
- reduces the chance that the app repeatedly falls back to an incomplete local list after successful hydration

## Remaining caveat
This does not yet prove product correctness on-device. Real confirmation still requires fresh links on the now-persistent live server plus real-device validation.
