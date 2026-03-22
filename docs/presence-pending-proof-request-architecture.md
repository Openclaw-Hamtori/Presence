# Presence Pending Proof Request Architecture

Date: 2026-03-22

## Problem statement

Presence currently works well for the initial link:

1. service creates a one-time link session
2. user scans QR or opens deeplink
3. app measures PASS and completes the session
4. backend persists the binding

After that, the user experience is still too session-shaped. When a linked service wants PASS again, the practical path still tends to require a fresh QR, deeplink, or ad hoc request envelope to put the app into the right state. That creates unnecessary friction for repeat use and leans too hard on one-shot transport instead of durable linkage.

The next UX architecture needs to preserve:

- initial link by QR/deeplink only
- fresh proof and backend-authoritative gating
- current fixes around fresh proof state and server-truth UI

But it should add:

- durable server-side pending proof request state
- app-side pending request hydration on foreground open
- orb/proof tap response without a new QR/deeplink/session for each repeat PASS request

## Product goal

Canonical product model:

- Link once by QR/deeplink.
- Stay linked.
- When a linked service wants PASS, it creates a pending proof request on the server.
- The user opens Presence and taps the orb.
- Presence submits proof for the pending request.
- The backend verifies and resolves the protected action.

## Non-goals

- No promise of guaranteed autonomous background proof submission.
- No dependence on force-quit survival.
- No silent-push-only critical path.
- No replacement of the existing one-shot session flow for initial link or relink.
- No sweeping conversion of all linked proof traffic to a brand-new protocol in one pass.

## Apple / iOS feasibility constraints

This design is intentionally grounded in Apple-supported foreground and user-visible launch paths, not in optimistic background assumptions.

Practical constraints:

- iOS background execution is limited and system-scheduled. It is not a safe critical path for "service needs PASS now". Apple explicitly frames background work as limited and heuristic-driven rather than guaranteed.
- Background task APIs are best-effort scheduling tools, not an exact delivery guarantee.
- User-visible notification interaction is viable. When the user interacts with a delivered notification, iOS delivers a `UNNotificationResponse` to the app.
- Universal links are viable for explicit user launch and routing into a specific in-app context.
- Local persistence is acceptable for non-authoritative client state, but authoritative pending request state must live on the server.

Apple references:

- Background execution strategy: <https://developer.apple.com/documentation/backgroundtasks/choosing-background-strategies-for-your-app>
- Background task scheduling: <https://developer.apple.com/documentation/uikit/using-background-tasks-to-update-your-app>
- Universal links / associated domains: <https://developer.apple.com/documentation/xcode/allowing-apps-and-websites-to-link-to-your-content>
- Notification permission and delivery model: <https://developer.apple.com/documentation/usernotifications/asking-permission-to-use-notifications>
- Notification tap response handling: <https://developer.apple.com/documentation/usernotifications/unnotificationresponse>

Design consequence:

- The critical path must succeed when the user explicitly opens the app from the home screen, taps a notification, or follows a universal link.
- Background refresh and silent push may improve freshness, but they are auxiliary only.

## Proposed architecture

### 1. Keep initial link exactly as the one-shot transport

- `POST /presence/link-sessions`
- `GET /presence/link-sessions/:sessionId`
- `POST /presence/link-sessions/:sessionId/complete`

Initial link still uses QR/deeplink, still binds fresh proof to a one-time nonce, and still seeds durable binding sync metadata into local state.

### 2. Add first-class pending proof requests on the backend

New additive backend object:

- `PendingProofRequest`

Suggested shape:

- `id`
- `serviceId`
- `accountId`
- `bindingId`
- `deviceIss`
- `nonce`
- `requestedAt`
- `expiresAt`
- `status: "pending" | "verified" | "recovery_required" | "expired" | "cancelled"`
- `completedAt?`
- `recoveryReason?`
- `metadata?`

Semantics:

- A service creates a pending request when it needs PASS now.
- The request is server-authoritative and durable.
- The request is bound to the existing binding plus a fresh nonce.
- Only one active pending request should normally remain for the same binding/action slot; newer requests may cancel older still-pending ones.

### 3. Let the app discover pending work from trusted binding metadata

Add additive binding sync metadata:

- `pendingRequestsUrl`

Initial link completion metadata should include:

- `nonce_url`
- `verify_url`
- `pending_url`

The app stores that on the linked binding after the initial link completes.

When the app enters the foreground, it:

1. loads linked bindings from secure local persistence
2. validates the service sync URLs against `/.well-known/presence.json`
3. fetches pending proof requests from each linked binding’s `pendingRequestsUrl`
4. persists the resulting pending request descriptors locally
5. renders the highest-priority pending request as the orb’s current action target

This makes "open app and tap orb" work even if the service did not send a fresh deeplink for that request.

### 4. Use request-specific respond endpoints

For pending request response, prefer:

- `POST /presence/pending-proof-requests/:requestId/respond`

Instead of forcing the app to reconstruct the older `verify + x-presence-nonce` dance manually every time, the request-specific respond endpoint:

- looks up the pending request
- uses its stored nonce
- verifies the proof
- marks the request terminal on success or recovery-required

The legacy linked proof request path remains supported for explicit deeplink/session-driven flows.

## Request lifecycle

### Initial link

1. service creates link session
2. user scans QR / opens deeplink
3. app generates fresh proof
4. backend completes link session
5. backend returns binding plus sync URLs including `pending_url`
6. app persists linked binding and sync metadata

### Service wants PASS later

1. service backend calls `createPendingProofRequest(accountId)`
2. backend persists `PendingProofRequest(status="pending")`
3. service may notify the user by product UI, push notification, or universal link
4. user opens Presence by icon, notification tap, or universal link
5. app foreground sync fetches current pending requests for linked bindings
6. app renders the pending request target on the orb
7. user taps orb
8. app measures PASS and posts proof to `/presence/pending-proof-requests/:requestId/respond`
9. backend verifies proof and updates:
   - binding snapshot / verification state
   - pending request status
10. app removes or updates the local pending request record

### Failure / recovery cases

- If local PASS is false, request stays pending until expiry or a later successful attempt.
- If backend verification returns `ERR_BINDING_RECOVERY_REQUIRED`, request becomes `recovery_required`, binding becomes recovery-pending, and the orb stops presenting it as a normal PASS action.
- If request expires before response, server marks it `expired`; app drops it from active pending UX.

## Server API and state model changes

### Additive SDK / backend state

- `PendingProofRequestStatus`
- `PendingProofRequest`
- store methods for save/get/list pending proof requests

### Additive endpoints

- `POST /presence/linked-accounts/:accountId/pending-proof-requests`
  - create a fresh pending proof request for an already-linked account
- `GET /presence/linked-accounts/:accountId/pending-proof-requests`
  - list current pending proof requests for that linked account
- `GET /presence/pending-proof-requests/:requestId`
  - inspect a single pending proof request
- `POST /presence/pending-proof-requests/:requestId/respond`
  - verify proof against the stored nonce and resolve the request

### Existing endpoints retained

- `POST /presence/linked-accounts/:accountId/nonce`
- `POST /presence/linked-accounts/:accountId/verify`
- `GET /presence/linked-accounts/:accountId/status`

Rationale:

- Existing linked proof request APIs keep working for current flows and backwards compatibility.
- New pending request endpoints provide the durable app-open/orb-only model.

## App state and UI changes

### Local state additions

Persist `pendingProofRequests[]` in app state.

Each item should include:

- `requestId`
- `serviceId`
- `accountId`
- `bindingId`
- `deviceIss`
- `nonce`
- `requestedAt`
- `expiresAt`
- `status`
- `respondUrl`
- optional `statusUrl` / `unlinkUrl`

### Orb behavior

Priority order:

1. opened link/deeplink envelope, if present
2. otherwise first active pending proof request
3. otherwise normal local PASS measurement

### UI copy

- If there is a pending request and the device has PASS: "Proof request ready"
- If there is a pending request and local PASS is false: "Proof request blocked"
- If response is in flight: "Submitting proof"
- If request resolved with mismatch/recovery: "Recovery required"

### Foreground sync

Trigger pending request hydration on:

- app cold start / foreground load
- explicit refresh after a successful proof response
- optional service modal open / user refresh affordance

## Security, replay, and wrong-target protections

- Fresh nonce per pending request. The request stores a unique nonce and uses the existing verifier single-use semantics.
- Binding scoping. Each pending request is pinned to `serviceId + accountId + bindingId + deviceIss`.
- Wrong-target suppression on app side. The app should only surface pending requests that match an active locally linked binding.
- Trusted URL scope. `pendingRequestsUrl` and other sync URLs must validate against `https://{service_domain}/.well-known/presence.json`.
- Server authority. The backend decides whether the binding is still linked, revoked, or recovery-pending at response time.
- Replay resistance. Reusing a consumed request nonce fails verifier checks.
- No silent local completion. The app never marks a request complete without server response.

## Migration and backward compatibility

- Initial link QR/deeplink flow remains unchanged.
- Existing relink/recovery session flow remains unchanged.
- Existing linked proof request nonce/verify endpoints remain supported.
- Existing clients without `pending_url` continue to function with the current session/deeplink-driven path.
- Services can adopt pending proof requests incrementally:
  1. keep current flow
  2. add `pending_url` to initial link completion metadata
  3. create pending proof requests server-side
  4. optionally add notification / universal-link affordances later

## Phased implementation plan

### Phase 1: foundation now

- add `PendingProofRequest` state to `presence-sdk`
- add store support in in-memory / filesystem / Redis stores
- add additive SDK methods:
  - `createPendingProofRequest()`
  - `getPendingProofRequest()`
  - `listPendingProofRequests()`
  - `respondToPendingProofRequest()`
- add API helpers and reference endpoint shapes
- add `pending_url` to initial link completion metadata
- add app-local persisted `pendingProofRequests`
- add app foreground sync for trusted `pendingRequestsUrl`
- let orb submit the first active pending request without a fresh deeplink

### Phase 2: user-visible wake-up affordances

- service push notification with user-visible alert
- notification tap deep-links into Presence
- optional universal link from service web/app surfaces to open Presence directly

### Phase 3: prioritization and UX hardening

- multiple simultaneous pending requests
- explicit request list UI
- request priority / newest-wins policy
- richer request expiry / stale-state copy

### Phase 4: production hardening

- secure persistence review for locally cached request descriptors
- request/action correlation metadata for service-side audit trails
- optional explicit cancellation endpoint
- rate limiting and anti-spam policy on pending request creation

## Implementation started in this repo

This pass begins Phase 1 only.

Implemented foundation:

- `presence-sdk` pending proof request model, store support, client methods, and API helpers
- initial link completion metadata now carries `pending_url`
- reference backend/example endpoints for pending proof requests
- app/test-app local pending request persistence and foreground sync scaffolding
- orb can consume a pending proof request directly when no fresh envelope is open

Still intentionally not implemented in this pass:

- APNs/user-visible notification delivery
- universal-link routing for pending request launch
- request prioritization UI beyond "first active request"
- native secure-storage hardening beyond current local persistence model
