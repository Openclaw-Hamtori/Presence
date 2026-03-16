# Presence Release Audit — 2026-03-16

## Verdict
Presence is now **repo-level release-ready / runtime-level pending**.

That means:
- code / package / config / product-boundary work is in strong shape
- the remaining release gates are operational validation items, not major implementation blockers

## What is now verified

### Repo / package / config
- Root `npm run test` passes after the latest fixes.
- `presence-sdk` build + tests pass.
- `presence-verifier` build + tests pass.
- `presence-mobile` type-check passes.
- `presence-test-app` type-check passes.
- `presence-sdk` `npm pack --dry-run` passes.
- `presence-verifier` `npm pack --dry-run` passes.
- Physical-device `xcodebuild` for `PresenceTestApp` passes after the Metro/workspace fix.
- `@babel/runtime` was corrected into runtime dependency shape for the React Native app.
- `presence-test-app/metro.config.js` now explicitly supports workspace-root + app-local module resolution.
- `presence-test-app/ios/Podfile` now matches workspace-hoisted `node_modules` layout.

### Product boundary / semantic consistency
- Presence/Noctu contamination in the root app surface was removed.
- Presence onboarding copy was restored to Presence-native wording.
- `PRODUCT_BOUNDARIES.md` now states the durable separation rule clearly.

### Real-device / UX checks completed
- App installs to physical iPhone.
- App launches without immediate crash.
- Main screen renders normally.
- PASS state is visible on device.
- Direct proof action works on device.
- Manual link session loading works.
- Loaded-session approval card appears.
- Approve action returns to the main app surface as designed.
- QR flow works end-to-end as an input path into the same session approval flow.

### Reference backend / linked auth checks completed
- Local reference round-trip succeeded:
  - create session
  - complete session
  - binding saved
  - linked account verify
  - mismatch -> recovery_pending / relink session
- This was re-confirmed via `presence-sdk/examples/local-linked-auth-harness.js`.

### External final review
- Claude Opus final repo audit verdict: `READY_WITH_CAVEATS`
- Key conclusion: **zero repo/code blockers remain**; only runtime/operational validation gates remain before final release signoff.

## Remaining release gates

### 1. Real backend round-trip (production-like service path)
Still required:
- create real service session
- mobile approve with real completion metadata
- backend completion API receives payload
- binding persists in real service path
- linked verify succeeds in the real path

Why it still matters:
- the reference harness proves the contract and core logic
- but release confidence still wants one proof against the actual intended backend integration path

### 2. Background refresh / renewal observation on real iPhone
Still required:
- observe at least one realistic renewal-window crossing
- verify refresh behavior under real iOS wake/network conditions
- confirm no silent failure around renewal scheduling

Why it still matters:
- this is the highest remaining operational risk for Presence
- repo/static correctness is not enough here

### 3. Remaining checklist evidence gaps
Still desirable to tighten:
- explicit Health permission request/state-update observation if not already captured in durable detail
- PASS criteria detail confirmation (sample/bucket/steps diagnostic evidence)
- explicit confirmation of link-context-free local proof in durable wording
- FAIL/readiness-degrade path evidence in a more explicit recorded form

## Overall judgment
If judging only the repository, package shape, configs, and current device/reference evidence:
- **Presence is in strong release-near shape**
- there are **no known major code blockers left**

If judging final ship / signoff:
- **do not fully sign off until the real backend path and background refresh gate are closed**

## Recommended next actions
1. Run one real backend completion round-trip and record the evidence.
2. Run/observe one background refresh + renewal-window validation and record the evidence.
3. Update `REGRESSION_CHECKLIST.md` and this audit note with those final results.
4. Then perform final release signoff.
