# Presence Push Setup vs Steady-State

Date: 2026-03-22

## Goal

Keep push as a best-effort wake signal for pending proof requests, while making APNs registration a real one-time setup responsibility instead of an accidental side effect of the steady-state proof path.

## Product split

### 1. Initial setup phase

This happens once per device link, with occasional refresh if APNs token or app install state changes.

Required steps:

1. link the device/service through the existing link session flow
2. request notification permission and obtain an APNs token
3. upload that token to `POST /presence/devices/:deviceIss/push-tokens`
4. confirm the stored token on the backend device record
5. persist local setup state so upload failures can retry after restart

Rules:

- setup state is device-level, not pending-request state
- push registration is never allowed to change proof truth
- failure to register push must not block linking or direct foreground proof submission

### 2. Steady-state responder phase

This is the normal repeated-use path after setup is complete.

1. service creates a pending proof request
2. server looks up stored device push token(s) and sends a wake push
3. app opens, foregrounds, or receives a notification tap
4. app hydrates authoritative bindings and pending requests from the server
5. user taps the orb
6. app generates and submits fresh proof
7. verified `PASS` is shown briefly
8. request is consumed immediately

Rules:

- push is non-authoritative
- server hydration is always the source of truth
- no APNs permission or token UX should appear in this steady-state responder loop unless setup is genuinely incomplete or the token rotated

## Current gap found in the repo

The codebase already had:

- iOS APNs permission + token foundations
- backend token storage route
- pending-proof push wake handling

But the setup path was still incomplete because token upload confirmation was not durable:

- a successful APNs token event could be lost if backend upload failed
- retry state was mostly in memory
- local setup state did not survive app restart
- the app did not reuse backend device state to confirm that a token was already stored

## Implementation direction

Implement the smallest robust setup layer:

- persist the latest APNs token locally
- persist per-device upload confirmation / error state locally
- retry token upload when a linked device becomes available and when the app foregrounds
- treat `GET /presence/devices/:deviceIss/bindings` device payload as authoritative confirmation when it already includes the active token

This keeps the pending-proof responder path unchanged while making initial push setup actually finish reliably.
