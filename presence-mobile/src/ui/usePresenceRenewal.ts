/**
 * presence-mobile — usePresenceRenewal Hook
 *
 * Schedules background Presence measurement / sync.
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
 *   usePresenceRenewal(presence, runScheduledSync);  // mount once at app root
 */

import { useEffect, useRef, useCallback } from "react";
import { AppState, AppStateStatus } from "react-native";
import {
  secondsUntilNextMeasurement,
  shouldRenew,
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

type RenewalTask = () => Promise<boolean | void>;

const BACKGROUND_TIMEOUT_MS = 25_000;
const RENEWAL_RETRY_SECONDS = 5;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`renewal timed out after ${timeoutMs}ms`));
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

export function usePresenceRenewal(
  presence: UsePresenceStateResult,
  runScheduledTask: RenewalTask
): void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isRenewingRef = useRef(false);
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

  const scheduleRenewal = useCallback(async () => {
    clearTimer();

    const currentPresence = presenceRef.current;
    if (!currentPresence.state) return;

    // Keep retrying while renewal is due or verify work is queued instead of
    // relying on a single boundary timer.
    const hasPendingSyncJobs = await hasPendingLinkedBindingSyncJobs();
    const secondsUntil = currentPresence.phase === "expired"
      || shouldRenew(currentPresence.state)
      || hasPendingSyncJobs
      ? RENEWAL_RETRY_SECONDS
      : secondsUntilNextMeasurement(currentPresence.state);
    const delaySeconds = secondsUntil > 0 ? secondsUntil : RENEWAL_RETRY_SECONDS;

    await scheduleBackgroundRefresh(Math.floor(Date.now() / 1000) + delaySeconds);

    const delayMs = Math.min(delaySeconds * 1000, 24 * 60 * 60 * 1000);
    timerRef.current = setTimeout(() => {
      void tryRenewRef.current("timer");
    }, delayMs);
  }, [clearTimer]);

  const tryRenew = useCallback(async (source: "timer" | "foreground" | "background") => {
    if (isRenewingRef.current) return;

    const currentPresence = presenceRef.current;
    if (currentPresence.phase === "proving" || currentPresence.phase === "measuring") {
      if (source === "background") {
        await finishBackgroundRefresh(false);
      }
      return;
    }

    const needsMeasurementSync = !!currentPresence.state
      && (shouldRenew(currentPresence.state) || currentPresence.phase === "expired");
    const initialPendingSyncs = await hasPendingLinkedBindingSyncJobs();

    if (!needsMeasurementSync && !initialPendingSyncs) {
      if (source === "background") {
        await finishBackgroundRefresh(true);
        await scheduleRenewal();
      }
      return;
    }

    isRenewingRef.current = true;
    let success = true;
    try {
      if (needsMeasurementSync) {
        const result = await withTimeout(runScheduledTaskRef.current(), BACKGROUND_TIMEOUT_MS);
        success = result !== false;
      }

      const shouldFlushQueuedSyncs = needsMeasurementSync
        ? false
        : initialPendingSyncs;

      if (shouldFlushQueuedSyncs) {
        const result = await withTimeout(flushQueuedLinkedBindingSyncs(), BACKGROUND_TIMEOUT_MS);
        success = success && result.errors.length === 0;
      }
    } catch {
      success = false;
    } finally {
      isRenewingRef.current = false;
      if (source === "background") {
        try {
          await finishBackgroundRefresh(success);
        } catch {}
        try {
          await scheduleRenewal();
        } catch {}
      }
    }
  }, [scheduleRenewal]);

  const tryRenewRef = useRef(tryRenew);
  useEffect(() => {
    tryRenewRef.current = tryRenew;
  }, [tryRenew]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const pending = await consumePendingBackgroundRefresh();
      if (pending && !cancelled) {
        void tryRenewRef.current("background");
      }
    })();

    const unsubscribe = addBackgroundRefreshListener(() => {
      void tryRenewRef.current("background");
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
          void tryRenewRef.current("foreground");
          void scheduleRenewal();
        } else {
          clearTimer();
        }
      }
    );

    void tryRenewRef.current("foreground");
    void scheduleRenewal();

    return () => {
      subscription.remove();
      clearTimer();
    };
  }, [scheduleRenewal, clearTimer]);

  useEffect(() => {
    if (presence.state) {
      void scheduleRenewal();
    }
    return clearTimer;
  }, [presence.state?.stateValidUntil, presence.state?.nextMeasurementAt, scheduleRenewal, clearTimer, presence.state]);
}
