# Presence Final Release Review — 2026-03-13

## Executive Summary
Current state is **close to release-ready in code/document/test consistency**, but **not yet fully release-complete operationally**.

Why:
- Code, docs, SDK, verifier, and app/test-app were brought into one consistent **PASS-only** model.
- Static verification and package-level build/test checks passed.
- The main remaining risk is no longer core product logic, but **real-device operational validation**.

## What was verified

### Package checks
- `presence-test-app` — `npm run type-check` ✅
- `presence-mobile` — `npm run type-check` ✅
- `presence-sdk` — `npm run build && npm test` ✅
- `presence-verifier` — `npm run build && npm test` ✅

### Architectural consistency
Verified consistent across code/docs/tests:
- PASS-only upstream model
- No explicit ordinary FAIL push path (`not_ready_url`, `reportNotReadyApiUrl`, `reportLinkedMeasurementFailure`, etc. removed)
- Linked-service readiness degrades from last successful PASS snapshot
- Recovery/relink remains explicit and separate from ordinary PASS expiry

### UX/status checks completed in code
- Connect modal background tap dismisses keyboard / closes modal
- Service modal background tap closes modal
- Current UI direction appears aligned with product intent

## Immediate items found during final review

### 1) Stale mobile README wording
Status: fixed now ✅

Issue:
- `presence-mobile/README.md` still mentioned old `not-ready reports` retry behavior.

Action taken:
- Reworded to reflect current PASS-only behavior:
  - retry language now refers to failed linked PASS verify attempts
  - no explicit ordinary FAIL push wording remains

## Remaining release risks
These are the real remaining risks after code/doc/test closure.

### A. Real-device background refresh validation
Severity: High

Need to verify on actual iPhone:
- background wake actually happens under realistic OS constraints
- refresh near renewal window behaves as expected
- app does not silently miss too many wake opportunities

### B. Real linked-service runtime validation
Severity: High

Need to verify with real backend flow:
- initial link
- linked verify
- readiness degradation from last PASS snapshot
- recovery / relink behavior after mismatch

### C. Release confidence still depends on runtime, not just static checks
Severity: High

Current confidence is strong for:
- product logic
- code consistency
- build/test correctness

Current confidence is not final for:
- iOS runtime scheduling behavior
- wake/network timing edge cases
- field behavior around expiry/renewal

## Recommended release gate
Do **not** define final launch readiness from code checks alone.
Use this release gate:

1. Static/package checks all green ✅
2. PASS-only model verified end-to-end with real backend ⏳
3. Real iPhone background refresh / renewal behavior observed ⏳
4. Recovery/relink real-device run completed ⏳

## My current judgment

### What is effectively closed
- core product direction
- PASS-only semantics
- app/sdk/verifier/documentation consistency
- package-level test/build correctness

### What is not fully closed yet
- real-device background reliability
- end-to-end operational trust under wake/network/runtime conditions

## Bottom line
This project now looks **implementation-complete enough to enter final field validation**, not yet “ship blindly without device/runtime checks.”

The remaining work is mostly:
- operational validation
- release confidence building
- last-mile runtime proof

Not major product rework.
