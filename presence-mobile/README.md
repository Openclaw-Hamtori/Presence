# presence-mobile

Presence — Mobile Client (iOS)
React Native CLI, TypeScript

Based on:
- Presence Mobile Client Flow v0.4
- Presence Signal Spec v0.4
- Presence Verifier Spec v0.4

---

## Status

> ⚠️ Reference implementation. Requires native module integration before production use.

Phase 4 extends the persistent linkage model on device with:
- unlink / revoke / relink-aware local state
- local recovery markers for binding mismatch or re-auth requirement
- deeplink parsing / generation helpers for link completion
- a reusable `ConnectionFlowScreen` that walks through service request -> QR/deeplink -> device proof submission -> server completion
- direct `submitLinkedBindingProof()` support for linked-service PASS submission
- richer `link_context` routing metadata for initial link, re-auth, relink, and recovery
- explicit local-calendar-day PASS evaluation semantics for BPM + steps

Still intentionally unfinished:
- camera QR scanner UI (this phase uses deeplink / QR payload scaffolding)
- native universal link registration / app-site-association hosting
- push-driven recovery notifications
- production-hardened cross-platform background scheduler

---

## Architecture

```text
presence-mobile/src/
├── types/                         — core attestation + linkage entities
├── health/                        — HealthKit BPM + steps reading
├── crypto/                        — Secure Enclave key handling + signing
├── attestation/                   — Apple App Attest bridge
├── state/presenceState.ts         — local Presence state + linkage persistence
├── service.ts                     — prove() orchestration for link + reauth flows
├── deeplink.ts                    — deeplink / QR payload build+parse helpers
└── ui/
   ├── usePresenceState.ts         — hook that now accepts full `ProveOptions`
   └── screens/ConnectionFlowScreen.tsx — reference link/proof-request flow
```

---

## Linked Presence model

### Core local entities

- **LinkedDevice** — local durable device identity derived from Secure Enclave key / `iss`
- **LinkSession** — one-time bootstrap context for initial link or recovery relink
- **ServiceBinding** — persistent mapping from a service account to this linked device
- **PresenceSnapshot** — most recent local PASS/FAIL snapshot maintained on device

### Lifecycle

1. Service starts a one-time link or proof request and issues a nonce.
2. Mobile app enters one of four flows: `initial_link`, `reauth`, `relink`, or `recovery`.
3. Device evaluates PASS, produces fresh App Attest evidence, and returns proof.
4. On the first successful verification, the service stores the binding and the connection becomes active until revoked/unlinked.
5. Later auth checks reuse that binding, and the device submits PASS only when the service asks.
6. If the service detects a mismatch, local state can be marked `recovery_pending` until relink completes.

---

## Proof generation

```ts
import { prove } from "./src";

const result = await prove({
  nonce,
  flow: "relink",
  linkSession: {
    id: "plink_ab12cd34",
    serviceId: "discord-bot",
    accountId: "user_123",
    recoveryCode: "AB12CD",
    completion: {
      method: "deeplink",
      returnUrl: "myapp://presence/complete",
      fallbackCode: "AB12CD",
    },
  },
  bindingHint: {
    bindingId: "pbind_xy98mn76",
    serviceId: "discord-bot",
    accountId: "user_123",
  },
});
```

Returned payload includes routing metadata:

```json
{
  "platform": "ios",
  "attestation": { "...": "..." },
  "device_attestation": "...",
  "signing_public_key": "...",
  "link_context": {
    "service_id": "discord-bot",
    "link_session_id": "plink_ab12cd34",
    "binding_id": "pbind_xy98mn76",
    "flow": "relink",
    "recovery_code": "AB12CD",
    "completion": {
      "method": "deeplink",
      "return_url": "myapp://presence/complete",
      "code": "AB12CD"
    }
  }
}
```

## Linked-service proof submission

After a service is already linked, the canonical app action is to submit PASS for
that linked service, not to model a separate renewal product flow.

```ts
import { submitLinkedBindingProof } from "presence-mobile";

const result = await submitLinkedBindingProof({
  binding,
});

if (result.status === "verified") {
  // service accepted PASS for this linked account
}
```

If the service already supplied a nonce in its request, pass it through:

```ts
await submitLinkedBindingProof({
  binding,
  nonce: serviceNonce,
});
```

The helper uses the existing `nonceUrl` + `verifyUrl` metadata on the binding.
When a nonce is not supplied directly, it fetches one from the service first and
then submits PASS to the verify endpoint.

---

## Deeplink / QR completion scaffolding

Included helpers:

```ts
import {
  buildPresenceLinkUrl,
  parsePresenceLinkUrl,
  ConnectionFlowScreen,
} from "presence-mobile";

const url = buildPresenceLinkUrl({
  sessionId: "plink_ab12cd34",
  serviceId: "discord-bot",
  serviceDomain: "presence.example.com",
  accountId: "user_123",
  bindingId: "pbind_xy98mn76",
  flow: "relink",
  method: "deeplink",
  nonce: "base64url_nonce",
  returnUrl: "myapp://presence/complete",
  code: "AB12CD",
  nonceUrl: "https://presence.example.com/presence/nonce",
  verifyUrl: "https://presence.example.com/presence/verify",
});

const parsed = parsePresenceLinkUrl(url);

// Optional reference UI for product teams
<ConnectionFlowScreen presence={presence} />;
```

Recommended architecture:
- desktop/web service renders QR from backend-provided deeplink
- mobile app opens the deeplink and resolves session context
- mobile calls `prove()` with flow + session + binding hint
- service completes the session server-side

If a deeplink/session includes `nonce_url` or `verify_url`, the app now requires
`service_domain` and validates those URLs against `https://{service_domain}/.well-known/presence.json`
before proof submission or later binding sync. Mismatches fail closed.
`status_url`, `nonce_url`, and `verify_url` must already be absolute URLs at the
mobile boundary; backend-relative paths are rejected until the backend rewrites
them for public/mobile use.

This gives product teams a path to initial linking and later proof submission without implementing native scanner/camera behavior in this phase.

---

## Recovery concepts in code

- `markBindingMismatchForRecovery(bindingId)` marks a local binding as pending recovery
- `locallyUnlinkBinding(bindingId)` marks a local binding as unlinked after remote unlink succeeds
- `PresenceState.status` can now become `recovery_pending`

This is intentionally small but enough for app state machines and UI copy.

---

## PASS semantics

Within the rolling 72-hour window, the app looks for at least one qualifying **local calendar day** in the device user's timezone.

A day qualifies when:
- valid BPM samples are within `40–200`
- at least `6` valid BPM samples are present
- those samples span at least `3` distinct 10-minute buckets
- BPM values are not completely fixed
- steps for that same local day are at least `100`

### BPM distribution rule

`presence-mobile` now evaluates per-day BPM evidence using discrete readings rather than inferred coverage time. A qualifying day needs:
- at least `6` valid BPM samples
- samples distributed across at least `3` distinct 10-minute buckets
- BPM values that are not completely fixed

Raw sample duration may still be preserved as source metadata, but it no longer drives PASS qualification.

## Background behavior

Background work is still best-effort, but it is no longer the product centerpiece.
The test app includes an iOS `BGTaskScheduler` scaffold, but the reusable mobile package is not yet a production-hardened background runtime.
Failed linked PASS verify attempts may be retried on the next foreground or background wake when the app has enough context to do so.
A linked account stays linked even when the last PASS is no longer accepted by the service; the service simply asks for another PASS when needed.
The main user-facing model is still: stay linked, then submit PASS when a service asks.

If you do wire background catch-up into app code, prefer the public name
`usePresenceBackgroundSync()` over older renewal-centric wording.

Important public expectation-setting:
- foreground and foreground-resume flows can be made highly reliable
- background catch-up may succeed opportunistically
- exact periodic execution is not guaranteed by iOS
- force-quit survival should not be treated as guaranteed behavior

So product design should prefer:
- strong resume recovery
- explicit backend proof checks
- honest background-lifecycle documentation

---

## Installation

```bash
npm install
cd ios && pod install
```

## Checks

```bash
npm run type-check
```

---

## License

MIT
