/**
 * presence-mobile — usePresenceBackgroundSync Hook
 *
 * Schedules best-effort background Presence measurement / linked proof catch-up.
 *
 * Strategy:
 *   - On app foreground: check if state needs a scheduled measurement
 *   - When the next measurement time arrives: trigger the provided sync task
 *   - Mirror the same schedule into iOS BGTaskScheduler when available
 *
 * JS timers remain best-effort, but iOS can also wake the app in background
 * through the native PresenceBackgroundRefresh module.
 *
 * Usage:
 *   const presence = usePresenceState();
 *   usePresenceBackgroundSync(presence, runScheduledSync);  // mount once at app root
 */

import { useEffect, useRef, useCallback } from "react";
import { AppState, AppStateStatus } from "react-native";
import {
  computeStateStatus,
  secondsUntilNextMeasurement,
  isCheckDue,
} from "../state/presenceState";
import type { UsePresenceStateResult } from "./usePresenceState";
import {
  addBackgroundRefreshListener,
  consumePendingBackgroundRefresh,
  finishBackgroundRefresh,
  scheduleBackgroundRefresh,
} from "../backgroundRefresh";
import {
  flushQueuedLinkedBindingSyncs,
} from "../sync/linkedBindings";
import { hasPendingLinkedBindingSyncJobs } from "../sync/queue";

type ScheduledTask = () => Promise<boolean | void>;

const BACKGROUND_TIMEOUT_MS = 25_000;
const SCHEDULE_RETRY_SECONDS = 5;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`scheduled Presence task timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export function usePresenceBackgroundSync(
  presence: UsePresenceStateResult,
  runScheduledTask: ScheduledTask
): void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isBackgroundSyncRunningRef = useRef(false);
  const presenceRef = useRef(presence);
  const runScheduledTaskRef = useRef(runScheduledTask);

  useEffect(() => {
    presenceRef.current = presence;
  }, [presence]);

  useEffect(() => {
    runScheduledTaskRef.current = runScheduledTask;
  }, [runScheduledTask]);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const scheduleNextCheck = useCallback(async () => {
    clearTimer();

    const currentPresence = presenceRef.current;
    if (!currentPresence.state) return;
    const currentStatus = computeStateStatus(currentPresence.state);

    // Keep retrying while a scheduled check is due or verify work is queued
    // instead of relying on a single boundary timer.
    const hasPendingSyncJobs = await hasPendingLinkedBindingSyncJobs();
    const secondsUntil = currentStatus === "expired"
      || isCheckDue(currentPresence.state)
      || hasPendingSyncJobs
      ? SCHEDULE_RETRY_SECONDS
      : secondsUntilNextMeasurement(currentPresence.state);
    const delaySeconds = secondsUntil > 0 ? secondsUntil : SCHEDULE_RETRY_SECONDS;

    await scheduleBackgroundRefresh(Math.floor(Date.now() / 1000) + delaySeconds);

    const delayMs = Math.min(delaySeconds * 1000, 24 * 60 * 60 * 1000);
    timerRef.current = setTimeout(() => {
      void runCheckIfDueRef.current("timer");
    }, delayMs);
  }, [clearTimer]);

  const runCheckIfDue = useCallback(async (source: "timer" | "foreground" | "background") => {
    if (isBackgroundSyncRunningRef.current) return;

    const currentPresence = presenceRef.current;
    if (currentPresence.phase === "proving" || currentPresence.phase === "measuring") {
      if (source === "background") {
        await finishBackgroundRefresh(false);
      }
      return;
    }

    const currentStatus = currentPresence.state ? computeStateStatus(currentPresence.state) : null;
    const needsMeasurementCheck = !!currentPresence.state
      && (isCheckDue(currentPresence.state) || currentStatus === "expired");
    const initialPendingSyncs = await hasPendingLinkedBindingSyncJobs();

    if (!needsMeasurementCheck && !initialPendingSyncs) {
      if (source === "background") {
        await finishBackgroundRefresh(true);
        await scheduleNextCheck();
      }
      return;
    }

    isBackgroundSyncRunningRef.current = true;
    let success = true;
    try {
      if (needsMeasurementCheck) {
        const result = await withTimeout(runScheduledTaskRef.current(), BACKGROUND_TIMEOUT_MS);
        success = result !== false;
      }

      const shouldFlushQueuedSyncs = needsMeasurementCheck
        ? false
        : initialPendingSyncs;

      if (shouldFlushQueuedSyncs) {
        const result = await withTimeout(flushQueuedLinkedBindingSyncs(), BACKGROUND_TIMEOUT_MS);
        success = success && result.errors.length === 0;
      }
    } catch {
      success = false;
    } finally {
      isBackgroundSyncRunningRef.current = false;
      if (source === "background") {
        try {
          await finishBackgroundRefresh(success);
        } catch {}
        try {
          await scheduleNextCheck();
        } catch {}
      }
    }
  }, [scheduleNextCheck]);

  const runCheckIfDueRef = useRef(runCheckIfDue);
  useEffect(() => {
    runCheckIfDueRef.current = runCheckIfDue;
  }, [runCheckIfDue]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const pending = await consumePendingBackgroundRefresh();
      if (pending && !cancelled) {
        void runCheckIfDueRef.current("background");
      }
    })();

    const unsubscribe = addBackgroundRefreshListener(() => {
      void runCheckIfDueRef.current("background");
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener(
      "change",
      (nextState: AppStateStatus) => {
        if (nextState === "active") {
          void runCheckIfDueRef.current("foreground");
          void scheduleNextCheck();
        } else {
          clearTimer();
        }
      }
    );

    void runCheckIfDueRef.current("foreground");
    void scheduleNextCheck();

    return () => {
      subscription.remove();
      clearTimer();
    };
  }, [scheduleNextCheck, clearTimer]);

  useEffect(() => {
    if (presence.state) {
      void scheduleNextCheck();
    }
    return clearTimer;
  }, [presence.state?.stateValidUntil, presence.state?.nextMeasurementAt, scheduleNextCheck, clearTimer, presence.state]);
}
