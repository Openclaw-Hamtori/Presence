/**
 * presence-mobile — HealthKit Module
 *
 * Reads BPM and step count via the PresenceHealthKit native module.
 * (PresenceHealthKitModule.swift / PresenceHealthKitModule.m)
 *
 * Data never leaves the device — only pass/fail signal is used downstream.
 *
 * PASS evaluation model:
 *   - rolling window: last 72 hours
 *   - BPM: required
 *   - steps: required for PASS
 *   - best-effort data collection
 *   - per-day matching uses the user's local calendar day, not UTC day
 */

// INTENTIONAL_FORK: test app uses tuned HealthKit query settings for rapid device validation.

import { NativeModules, Platform } from "react-native";
import type {
  BpmSample,
  StepSample,
  BiometricWindow,
  Result,
} from "../types/index";
import { ok, err } from "../types/index";

// ─── Native Module Contract ───────────────────────────────────────────────────

interface PresenceHealthKitNative {
  isAvailable(): Promise<boolean>;
  requestPermissions(): Promise<boolean>;
  getHeartRateSamples(options: {
    startDate: string;
    endDate: string;
    limit?: number;
    ascending?: boolean;
  }): Promise<Array<{ value: number; startDate: string; endDate: string }>>;
  getStepCount(options: {
    startDate: string;
    endDate: string;
  }): Promise<{ value: number; startDate: string; endDate: string }>;
}

function getNativeModule(): PresenceHealthKitNative | null {
  if (Platform.OS !== "ios") return null;
  return (NativeModules.PresenceHealthKit as PresenceHealthKitNative) ?? null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SAMPLING_WINDOW_MINUTES = 72 * 60;
const MIN_BPM_SAMPLES = 3;
const BPM_RANGE = { min: 40, max: 200 } as const;

function toLocalDayKey(ts: number): string {
  const date = new Date(ts * 1000);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfLocalDay(ts: number): Date {
  const date = new Date(ts * 1000);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function addLocalDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

// ─── Availability ─────────────────────────────────────────────────────────────

export function isHealthKitAvailable(): boolean {
  return Platform.OS === "ios" && getNativeModule() !== null;
}

// ─── Permissions ──────────────────────────────────────────────────────────────

export async function requestHealthKitPermissions(): Promise<Result<void>> {
  const native = getNativeModule();
  if (!native) {
    return err("ERR_HEALTHKIT_UNAVAILABLE", "HealthKit native module not available");
  }

  const available = await native.isAvailable();
  if (!available) {
    return err("ERR_HEALTHKIT_UNAVAILABLE", "HealthKit is not available on this device");
  }

  try {
    await native.requestPermissions();
    // iOS silently accepts or denies — always resolves here.
    // Actual denial surfaces as empty data in readRecentBpm().
    return ok(undefined);
  } catch (e) {
    return err("ERR_HEALTHKIT_PERMISSION_DENIED", `Permission request failed: ${e}`, e);
  }
}

// ─── BPM Samples ─────────────────────────────────────────────────────────────

export async function readRecentBpm(
  windowMinutes = SAMPLING_WINDOW_MINUTES
): Promise<Result<BpmSample[]>> {
  const native = getNativeModule();
  if (!native) {
    return err("ERR_HEALTHKIT_UNAVAILABLE", "HealthKit native module not available");
  }

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - windowMinutes * 60 * 1000);

  try {
    const raw = await native.getHeartRateSamples({
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      limit: 2000,
      ascending: true,
    });

    if (!raw || raw.length === 0) {
      return err("ERR_NO_BPM_DATA", "No heart rate data in window");
    }

    const samples: BpmSample[] = raw
      .filter((r) => r.value >= BPM_RANGE.min && r.value <= BPM_RANGE.max)
      .map((r) => ({
        bpm: r.value,
        timestamp: Math.floor(new Date(r.endDate).getTime() / 1000),
        durationSeconds: Math.max(
          1,
          Math.floor((new Date(r.endDate).getTime() - new Date(r.startDate).getTime()) / 1000)
        ),
      }));

    if (samples.length < MIN_BPM_SAMPLES) {
      return err(
        "ERR_BPM_INSUFFICIENT",
        `Only ${samples.length} valid BPM samples (minimum ${MIN_BPM_SAMPLES})`
      );
    }

    return ok(samples);
  } catch (e) {
    return err("ERR_NO_BPM_DATA", `Heart rate read failed: ${e}`, e);
  }
}

// ─── Step Count ───────────────────────────────────────────────────────────────

/**
 * Read total step count for an arbitrary time range.
 * Used internally to query per-day step counts.
 */
export async function readRecentSteps(
  windowMinutes = SAMPLING_WINDOW_MINUTES
): Promise<Result<StepSample>> {
  const native = getNativeModule();
  if (!native) {
    return err("ERR_STEPS_UNAVAILABLE", "HealthKit native module not available");
  }

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - windowMinutes * 60 * 1000);

  try {
    const result = await native.getStepCount({
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
    });

    return ok({
      count: result.value,
      startTime: Math.floor(startDate.getTime() / 1000),
      endTime: Math.floor(endDate.getTime() / 1000),
    });
  } catch (e) {
    return err(
      "ERR_STEPS_UNAVAILABLE",
      `Step count unavailable: ${e instanceof Error ? e.message : "no data"}`
    );
  }
}

// ─── Per-Day Step Counts ───────────────────────────────────────────────────────

/**
 * Query HealthKit step counts for each local calendar day that falls within the window.
 * Returns a map of { YYYY-MM-DD -> stepCount } in the device user's local timezone.
 * Days with no data or query failure are omitted (non-fatal per-day).
 */
async function readStepsByDay(
  windowStartSec: number,
  windowEndSec: number
): Promise<Record<string, number>> {
  const native = getNativeModule();
  if (!native) return {};

  let dayStart = startOfLocalDay(windowStartSec);
  const finalDayStart = startOfLocalDay(windowEndSec);
  const stepsByDay: Record<string, number> = {};

  while (dayStart.getTime() <= finalDayStart.getTime()) {
    const nextDayStart = addLocalDays(dayStart, 1);
    const dayStartSec = Math.max(Math.floor(dayStart.getTime() / 1000), windowStartSec);
    const dayEndSec = Math.min(Math.floor(nextDayStart.getTime() / 1000), windowEndSec);

    if (dayEndSec > dayStartSec) {
      try {
        const result = await native.getStepCount({
          startDate: new Date(dayStartSec * 1000).toISOString(),
          endDate: new Date(dayEndSec * 1000).toISOString(),
        });
        if (result.value > 0) {
          stepsByDay[toLocalDayKey(dayStartSec)] = result.value;
        }
      } catch {
        // non-fatal: skip this day
      }
    }

    dayStart = nextDayStart;
  }

  return stepsByDay;
}

// ─── Biometric Window ─────────────────────────────────────────────────────────

/**
 * Read full biometric window: BPM (required) + per-day steps (optional).
 * Steps failure is non-fatal — returns window with empty stepsByDay.
 *
 * Steps are queried per local calendar day so that pass.ts can check whether the
 * same user-local day has both sufficient BPM data and sufficient steps.
 */
export async function readBiometricWindow(): Promise<Result<BiometricWindow>> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - SAMPLING_WINDOW_MINUTES * 60;

  const bpmResult = await readRecentBpm();
  if (!bpmResult.ok) return bpmResult;

  const stepsByDay = await readStepsByDay(windowStart, now);

  return ok({
    bpmSamples: bpmResult.value,
    stepsByDay,
    windowStart,
    windowEnd: now,
  });
}
