import test from "node:test";
import assert from "node:assert/strict";

import {
  SCHEDULED_CHECK_LEAD_SECONDS,
  canReuseMeasuredPassState,
  isFreshMeasurementSnapshot,
} from "./measurementFreshness.ts";

test("canReuseMeasuredPassState() only reuses PASS states that are still comfortably valid", () => {
  const capturedAt = 1_700_000_000;

  assert.equal(
    canReuseMeasuredPassState({ pass: true, stateValidUntil: capturedAt + SCHEDULED_CHECK_LEAD_SECONDS + 1 }, capturedAt),
    true
  );
  assert.equal(
    canReuseMeasuredPassState({ pass: true, stateValidUntil: capturedAt + SCHEDULED_CHECK_LEAD_SECONDS }, capturedAt),
    false
  );
  assert.equal(
    canReuseMeasuredPassState({ pass: true, stateValidUntil: capturedAt - 1 }, capturedAt),
    false
  );
  assert.equal(
    canReuseMeasuredPassState({ pass: false, stateValidUntil: capturedAt + 300 }, capturedAt),
    false
  );
});

test("isFreshMeasurementSnapshot() requires a newly-created PASS snapshot", () => {
  const capturedAt = 1_700_000_100;

  assert.equal(
    isFreshMeasurementSnapshot(
      { pass: true, stateCreatedAt: capturedAt, stateValidUntil: capturedAt + 180 },
      capturedAt
    ),
    true
  );
  assert.equal(
    isFreshMeasurementSnapshot(
      { pass: true, stateCreatedAt: capturedAt - 30, stateValidUntil: capturedAt + 180 },
      capturedAt
    ),
    false
  );
  assert.equal(
    isFreshMeasurementSnapshot(
      { pass: true, stateCreatedAt: capturedAt, stateValidUntil: capturedAt },
      capturedAt
    ),
    false
  );
});
