import test from "node:test";
import assert from "node:assert/strict";

import { evaluatePass } from "./pass.ts";

function ts(day, time) {
  return Math.floor(new Date(`${day}T${time}:00+09:00`).getTime() / 1000);
}

function windowFor(day, bpmSamples, steps = 0) {
  return {
    bpmSamples: bpmSamples.map((sample) => ({ bpm: sample.bpm, timestamp: ts(day, sample.time) })),
    stepsByDay: steps > 0 ? { [day]: steps } : {},
    windowStart: ts(day, "00:00"),
    windowEnd: ts(day, "23:59"),
  };
}

test("passes when a local day has 6 valid BPM samples across 3 distinct 10-minute buckets and enough steps", () => {
  const result = evaluatePass(windowFor(
    "2026-03-10",
    [
      { bpm: 61, time: "08:00" },
      { bpm: 64, time: "08:07" },
      { bpm: 66, time: "08:12" },
      { bpm: 69, time: "08:18" },
      { bpm: 72, time: "08:25" },
      { bpm: 75, time: "08:29" },
    ],
    150
  ));

  assert.equal(result.pass, true);
  assert.deepEqual(result.signals, ["heart_rate", "steps"]);
});

test("fails when 6 valid samples are concentrated into fewer than 3 distinct 10-minute buckets", () => {
  const result = evaluatePass(windowFor(
    "2026-03-10",
    [
      { bpm: 61, time: "08:00" },
      { bpm: 64, time: "08:03" },
      { bpm: 66, time: "08:07" },
      { bpm: 69, time: "08:12" },
      { bpm: 72, time: "08:15" },
      { bpm: 75, time: "08:18" },
    ],
    150
  ));

  assert.equal(result.pass, false);
});

test("fails when BPM values are completely fixed even if count, bucket spread, and steps pass", () => {
  const result = evaluatePass(windowFor(
    "2026-03-10",
    [
      { bpm: 70, time: "08:00" },
      { bpm: 70, time: "08:07" },
      { bpm: 70, time: "08:12" },
      { bpm: 70, time: "08:18" },
      { bpm: 70, time: "08:25" },
      { bpm: 70, time: "08:29" },
    ],
    150
  ));

  assert.equal(result.pass, false);
});
