# Presence Test App

Reference React Native test surface for the Presence mobile flow.

This app is primarily for:
- integration testing
- product-flow validation
- QR/deeplink linking UX checks
- linked proof and server-sync debugging

It should not be described as the whole Presence product by itself.
It is a reference/testing surface around the broader Presence architecture.

## What changed in this phase

The app now demonstrates the canonical Presence UX:

1. Service creates a one-time link session
2. Session is encoded as a QR/deeplink payload (`presence://link?...`)
3. App opens the deeplink and previews the request
4. User submits PASS on device
5. Service verifies the proof, stores the binding, and the service becomes connected
6. Later, linked services can request proof on demand; ordinary FAIL measurements stay local and are not pushed upstream as a separate failure event

## Notes

- On iPhone, the top-right QR entry now opens a native AVFoundation-based camera scanner and feeds the scanned payload into the same link/proof-request flow.
- Manual paste / deeplink open still works as a fallback and uses the exact same parsing + proof-submission path.
- The app also registers the `presence://` URL scheme so a service deeplink can jump straight into the current session preview.
- The home screen now emphasizes request state, linked services, local-only checks, and proof submission when a service requests proof.
- Requestless local checks are explicitly local-only; the app should not imply final PASS until a service verifies proof.
- Best-effort background catch-up still exists for testing, but the app now treats that as implementation detail rather than the product promise.
- PASS scoring remains a rolling 72-hour health window from `presence-mobile`:
  - data is bucketed by **local calendar day** (device timezone)
  - one local day can satisfy the full PASS threshold, which requires at least:
    - 6 valid BPM samples in that day
    - samples spread across 3+ distinct 10-minute buckets
    - non-fixed BPM values
    - at least 100 steps on the same local day
- Local freshness is a separate app-level concern: in this test app, a PASS snapshot ages quickly (3 minutes in this fork), so stale local PASS is no longer treated as FAIL when there is no active request.
- UI rules follow a strict contract:
  - neutral/`IDLE` by default
  - `PASS` only for server-verified success
  - action-result failures (request submit/verify) remain brief `FAIL`
  - structural/policy failures remain persistent where they are real issues.
- Simulator builds can compile, but live QR scanning itself still requires a real iPhone camera.
- Session links can now carry `service_domain`; if they also include `nonce_url` / `verify_url`, the app validates those URLs against `https://{service_domain}/.well-known/presence.json` before proof submission or later sync.
- Shared `presence-mobile/src` mirrors, bridge re-exports, and intentional `presence-test-app/src` forks are documented in `../presence-mobile/SOURCE_OF_TRUTH.md` and checked by `npm run check:mobile-sync`.

## Checks

```bash
npm run type-check
npm run lint
```

`lint` currently depends on project-local ESLint configuration/tooling that is not fully present in this repo snapshot.
