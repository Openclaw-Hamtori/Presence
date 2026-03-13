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
- a reusable `ConnectionFlowScreen` that walks through service session -> QR/deeplink -> device approval -> proof completion
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
   └── screens/ConnectionFlowScreen.tsx — reference session approval flow
```

---

## Linked Presence model

### Core local entities

- **LinkedDevice** — local durable device identity derived from Secure Enclave key / `iss`
- **LinkSession** — one-time bootstrap context for initial link or recovery relink
- **ServiceBinding** — persistent mapping from a service account to this linked device
- **PresenceSnapshot** — most recent PASS snapshot maintained on device

### Lifecycle

1. Service starts a one-time link session and issues a nonce.
2. Mobile app enters one of four flows: `initial_link`, `reauth`, `relink`, or `recovery`.
3. Device evaluates PASS, produces fresh App Attest evidence, and returns proof.
4. After service verification succeeds, the binding remains active until revoked/unlinked.
5. Future auth checks reuse the binding, while the device still produces a **fresh attestation** when requested.
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
  accountId: "user_123",
  bindingId: "pbind_xy98mn76",
  flow: "relink",
  method: "deeplink",
  nonce: "base64url_nonce",
  returnUrl: "myapp://presence/complete",
  code: "AB12CD",
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

This gives product teams a path to UX completion without implementing native scanner/camera behavior in this phase.

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

Background work is still best-effort.
The test app includes an iOS `BGTaskScheduler` scaffold, but the reusable mobile package is not yet a production-hardened background runtime.
Failed linked PASS verify attempts may be retried on the next foreground or background wake when the app has enough context to do so.
A linked account stays linked even when a specific PASS snapshot expires.
The next successful auth still requires fresh PASS state + fresh attestation.

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
