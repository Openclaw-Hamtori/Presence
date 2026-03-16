import type { BiometricWindow, PassResult } from "../types/index";

const PASS_BPM_MIN = 40;
const PASS_BPM_MAX = 200;
const MIN_VALID_BPM_SAMPLES = 6;
const MIN_DISTINCT_10M_BUCKETS = 3;
const MIN_STEPS = 100;
const TEN_MINUTES_SECONDS = 10 * 60;

function toLocalDayKey(ts: number): string {
  const date = new Date(ts * 1000);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toTenMinuteBucket(ts: number): number {
  return Math.floor(ts / TEN_MINUTES_SECONDS);
}

export function evaluatePass(window: BiometricWindow): PassResult {
  const buckets = new Map<string, { bpmValues: number[]; tenMinuteBuckets: Set<number> }>();

  for (const sample of window.bpmSamples) {
    if (sample.bpm < PASS_BPM_MIN || sample.bpm > PASS_BPM_MAX) continue;
    const key = toLocalDayKey(sample.timestamp);
    const bucket = buckets.get(key) ?? { bpmValues: [], tenMinuteBuckets: new Set<number>() };
    bucket.bpmValues.push(sample.bpm);
    bucket.tenMinuteBuckets.add(toTenMinuteBucket(sample.timestamp));
    buckets.set(key, bucket);
  }

  for (const [key, bucket] of buckets) {
    const notFixed = new Set(bucket.bpmValues).size > 1;
    const stepsForDay = window.stepsByDay[key] ?? 0;

    if (
      bucket.bpmValues.length >= MIN_VALID_BPM_SAMPLES &&
      bucket.tenMinuteBuckets.size >= MIN_DISTINCT_10M_BUCKETS &&
      notFixed &&
      stepsForDay >= MIN_STEPS
    ) {
      return {
        pass: true,
        signals: ["heart_rate", "steps"],
        reason: "PASS within rolling 72h window using local-day BPM sample/bucket semantics",
      };
    }
  }

  return {
    pass: false,
    signals: ["heart_rate"],
    reason: "No qualifying local day within rolling 72h window",
  };
}
