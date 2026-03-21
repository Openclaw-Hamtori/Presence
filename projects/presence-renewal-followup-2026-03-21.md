# Presence renewal follow-up — 2026-03-21

## Current finding
- `presence-test-app/src/state/presenceState.ts`
  - `STATE_VALIDITY_SECONDS = 3 * 60`
  - `RENEWAL_WINDOW_SECONDS = 30`
  - `FAILED_RETRY_SECONDS = 30 * 60`
- This means the test app is already using compressed timing suitable for fast renewal observation.

## Blocking risk for renewal evidence
- `presence-sdk/src/client.ts` still defaults `gracePeriodSeconds` to `15 * 60`.
- For renewal/expiry validation, this can mask the intended transition by reporting `stale` during grace instead of exposing the exact expiry/not-ready boundary.
- Search did not show an obvious current test-app call site explicitly passing `gracePeriodSeconds: 0` for linked-account readiness checks.

## Operational implication
Before claiming final renewal evidence, ensure the test path used for readiness/access gating during this test either:
1. explicitly passes `gracePeriodSeconds: 0`, or
2. avoids readiness code paths where the SDK grace can mask the state transition being measured.

## Recommended next steps
1. Identify the exact readiness/access-gating code path exercised during the renewal test.
2. Confirm whether it calls SDK linked-account readiness.
3. If yes, add a renewal-test path/config that forces `gracePeriodSeconds: 0`.
4. Run and record the real-device sequence:
   - PASS
   - RENEW SOON
   - renewal trigger
   - expiry boundary
   - stale/not_ready behavior after grace-free check
5. Record timestamps and screenshots/logs as release evidence.

## Why this note exists
The time constants alone are not enough. Renewal evidence can be false-positive or ambiguous if the SDK grace window is still active while evaluating expiry behavior.
