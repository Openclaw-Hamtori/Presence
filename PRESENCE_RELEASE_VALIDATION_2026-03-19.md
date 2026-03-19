# Presence Release Validation — 2026-03-19

## Current verdict
Presence is now **code/test/integration-doc ready**, but still **runtime/device evidence pending** before full ship signoff.

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

Still need to confirm on-device:
- launch succeeds
- main screen renders

### 2. Trust validation UX on real device
Current state:
- invalid trust metadata path was exercised on-device
- fail-closed behavior worked: the bad session did not proceed
- follow-up fix landed: connection trust errors are now surfaced inside the connect modal and should clear on input change / modal dismiss / different-session reload

Still need to check on-device:
- valid `service_domain` + well-known path passes
- invalid/missing trust metadata now fails clearly *and* clears cleanly without app restart

### 3. Final runtime release evidence
Still needed before full release signoff:
- background wake / renewal-window observation on real device
- real backend completion round-trip
- recorded evidence for `ready -> stale -> not_ready` propagation behavior
- known limitations note after device/runtime observation

## Suggested immediate sequence
1. Reinstall latest `presence-test-app` on `iphone L` when the phone is back on the Mac
2. Confirm launch + visible UI sanity
3. Re-run the trust failure path and confirm the message clears cleanly inside the connect modal
4. Run one trust-model happy-path manual check with a proper HTTPS domain + valid well-known metadata
5. Then collect background refresh + real-backend evidence

## Tonight device plan
When the phone is connected again tonight, use this order:
1. install latest build
2. open app and confirm launch/main screen
3. open Connect modal
4. paste a deliberately bad session and confirm:
   - error shows inside the connect modal
   - editing the link clears the error
   - closing/reopening the modal clears stale trust error UI
5. run one valid session against a proper HTTPS trust setup
6. if that passes, move to renewal / backend evidence collection

## Notes
- This file is the current handoff point for release validation.
- `REGRESSION_CHECKLIST.md` is the checkbox ledger; this file is the judgment/evidence summary.
- Relevant latest fixes in this phase:
  - `a326193` — trust metadata integration guidance
  - `323e2c5` / `bf1a72c` — release validation + device reinstall progress notes
  - `5992801` — connect trust errors surfaced + cleared more predictably
