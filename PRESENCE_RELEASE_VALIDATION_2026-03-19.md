# Presence Release Validation — 2026-03-19

## Current verdict
Presence is now **code/test/integration-doc ready**, and the previously blocking **real iPhone HTTPS trust + completion + verifier happy-path** has been validated end-to-end. Full ship signoff is now mainly waiting on the remaining runtime/device evidence outside this core linking gate.

## Freshly re-verified today
### Baseline automated checks
- `presence-sdk` — `npm run build` ✅
- `presence-sdk` — `npm test` ✅
- `presence-verifier` — `npm run build` ✅
- `presence-verifier` — `npm test` ✅
- `presence-mobile` — `npm run type-check` ✅
- `presence-test-app` — `npm run type-check` ✅

### Trust-model integration closure
- Mobile trust runtime hardening already landed:
  - well-known fetch timeout
  - path-boundary-safe prefix matching
  - trust failure treated as permanent/exhausted rather than retry-budget noise
- Integration/docs/examples now also reflect the new trust model:
  - `presence-sdk/examples/local-reference-server.js`
    - can publish `/.well-known/presence.json`
    - can inject `service_domain` into generated deeplink/QR URLs
  - `presence-protocol-documentation/Presence_Product_Integration_v0.1.md`
    - now documents `service_domain`
    - now documents fail-closed well-known validation for `nonce_url` / `verify_url`
- Manual/example verification completed:
  - `/.well-known/presence.json` response confirmed
  - generated `qrUrl` / `deeplinkUrl` confirmed to include `service_domain`

## What is effectively closed
- core proof / linking / recovery implementation
- retry / timeout / renewal deadlock class fixes
- trust-model 1st-pass implementation
- trust-model integration guidance for backend/service teams
- baseline package/build/type-test confidence
- reference-server linked auth round-trip confidence
- PASS expiry degradation model remains aligned with no ordinary explicit `not_ready` push

## What is still open
### 1. Real iPhone installation / launch re-check for the latest state
Current state:
- latest `presence-test-app` build re-installed to `iphone L` successfully ✅
- latest build launched and trust happy-path manual flow reached approval UI on-device ✅

Still need to confirm on-device:
- main screen / broader non-link UI sanity after latest release-critical changes

### 2. Trust validation UX on real device
Current state:
- invalid trust metadata path was exercised on-device
- fail-closed behavior worked: the bad session did not proceed
- follow-up fix landed: connection trust errors are now surfaced inside the connect modal and should clear on input change / modal dismiss / different-session reload
- valid public HTTPS trust metadata path now also passed on a real iPhone:
  - `service_domain=noctu.link`
  - `https://noctu.link/.well-known/presence.json`
  - sync URLs under `https://noctu.link/presence-demo/presence/...`
  - session opened and approval UI became reachable

Resolved blocker chain for this happy-path:
- stale generic `service_domain` branch still present in `presence-test-app/src/linkTrust.ts`
- `service_domain` host validation was too dependent on runtime URL parsing quirks on iPhone
- well-known `allowed_url_prefixes` initially used a trailing slash that failed the app boundary rule
- well-known trust metadata needed no-store cache headers to avoid stale fetch behavior during debugging
- allowed URL prefixes were being normalized through `new URL(...).href`, which changed prefix semantics by reintroducing a trailing slash
- final fix: validate/keep allowed URL prefixes as absolute prefix strings rather than normalizing them through URL parser output

Still need to check on-device:
- invalid/missing trust metadata now fails clearly *and* clears cleanly without app restart

### 3. Final runtime release evidence
Still needed before full release signoff:
- background wake / renewal-window observation on real device
- recorded evidence for `ready -> stale -> not_ready` propagation behavior under the latest build

Already closed in this phase:
- real backend completion round-trip on a real iPhone
- verifier success after PEM stripping for `signing_public_key`
- verifier success after signing the canonical attestation payload directly
- duplicate approve / nonce replay UX guard in the test app
- iOS verifier plumbing now passes `iosAppleRootCA` into verifier context
- HealthKit background observer wiring now retains `HKHealthStore` / observer queries and no longer masks BGTask registration failure
- stale patch entitlements now include the same HealthKit keys as the active test-app entitlements
- known behavior note established: reused or expired deeplinks can fail with `nonce expired or not issued by service`, while fresh deeplinks continue to link successfully

## Suggested immediate sequence
1. Keep the current real-device happy-path result as the baseline
2. Run the remaining real-device renewal-window observation
3. Record the final `ready -> stale -> not_ready` evidence under the latest build
4. Flip App Attest entitlement from `development` to `production` only at App Store / TestFlight release cut
5. Then do final release signoff

## Latest resolved issues
- `d954bf4` — `fix: isolate connect flow errors from main banner`
- `8d995e5` — `fix: strip PEM envelope from device public key`
- `7024628` — `fix: sign canonical attestation payload directly`
- `71cccdb` — `fix: block duplicate approve for linked sessions`
- `a804030` — `feat: wire HealthKit background delivery into renewal`
- `6605e5f` — `fix: harden iOS verifier and health observer wiring`
- `ccfe361` — `fix: retain health observers and remove nonce self-export`
- `3f711ea` — `fix: remove corrupted healthkit module tail`

## Notes
- This file is the current handoff point for release validation.
- `REGRESSION_CHECKLIST.md` is the checkbox ledger; this file is the judgment/evidence summary.
- Code-level ship blockers are closed as of the latest audit.
- Remaining release risk is concentrated in real-device renewal/background evidence, not the core linking/verifier flow.
