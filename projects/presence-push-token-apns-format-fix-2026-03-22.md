## Presence push token `abc123` fix (2026-03-22)

Root cause observed: the app would happily persist and upload whatever token string came through the push registration bridge, including short test-like values (e.g. `abc123`) if they were ever in local state.

Fixes made:
- iOS native bridge (`PresencePushNotificationsModule.swift`) now validates APNs token length (`>=64` hex chars, even length) before emitting `PresencePushTokenRegistered`.
- If invalid, it emits `PresencePushRegistrationFailed` with `invalid apns token format received`.
- Push token normalization (`presence-mobile/src/pushRegistrationState.ts`) now rejects normalized tokens that are not a valid APNs-length hex string, preventing cached placeholders from being reused as real registration payloads.
- Updated `pushRegistrationState` test fixture token to a full-length hex sample.

Effect: stale/placeholder `abc123` values no longer get uploaded as server `push-tokens`; valid 64+ hex APNs tokens continue through.
