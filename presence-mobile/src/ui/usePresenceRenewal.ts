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

// ─── Types ────────────────────────────────────────────────────────────────────

type RenewalTask = () => Promise<boolean | void>;

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function usePresenceRenewal(
  presence: UsePresenceStateResult,
  runScheduledTask: RenewalTask
): void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isRenewingRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const tryRenew = useCallback(async (source: "timer" | "foreground" | "background") => {
    if (isRenewingRef.current) return;
    if (presence.phase === "proving" || presence.phase === "measuring") return;
    const needsMeasurementSync = !!presence.state && (shouldRenew(presence.state) || presence.phase === "expired");
    const hasPendingSyncs = await hasPendingLinkedBindingSyncJobs();

    if (!needsMeasurementSync && !hasPendingSyncs) {
      if (source === "background") {
        await finishBackgroundRefresh(true);
      }
      return;
    }

    isRenewingRef.current = true;
    let success = true;
    try {
      if (needsMeasurementSync) {
        const result = await runScheduledTask();
        success = result !== false;
      } else {
        const result = await flushQueuedLinkedBindingSyncs();
        success = result.errors.length === 0;
      }
    } catch {
      success = false;
    } finally {
      if (source === "background") {
        await finishBackgroundRefresh(success);
      }
      isRenewingRef.current = false;
    }
  }, [presence, runScheduledTask]);

  const scheduleRenewal = useCallback(() => {
    clearTimer();
    if (!presence.state) return;

    if (shouldRenew(presence.state) || presence.phase === "expired") {
      void tryRenew("foreground");
      return;
    }

    const secondsUntil = secondsUntilNextMeasurement(presence.state);
    if (secondsUntil <= 0) {
      void tryRenew("foreground");
      return;
    }

    void scheduleBackgroundRefresh(Math.floor(Date.now() / 1000) + secondsUntil);

    const delayMs = Math.min(secondsUntil * 1000, 24 * 60 * 60 * 1000);
    timerRef.current = setTimeout(() => {
      void tryRenew("timer");
    }, delayMs);
  }, [presence.state, presence.phase, tryRenew, clearTimer]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const pending = await consumePendingBackgroundRefresh();
      if (pending && !cancelled) {
        void tryRenew("background");
      }
    })();

    const unsubscribe = addBackgroundRefreshListener(() => {
      void tryRenew("background");
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [tryRenew]);

  // ── AppState foreground listener ──────────────────────────────────────────
  useEffect(() => {
    const subscription = AppState.addEventListener(
      "change",
      (nextState: AppStateStatus) => {
        if (nextState === "active") {
          void tryRenew("foreground");
          scheduleRenewal();
        } else {
          clearTimer();
        }
      }
    );

    void tryRenew("foreground");
    scheduleRenewal();

    return () => {
      subscription.remove();
      clearTimer();
    };
  }, [scheduleRenewal, clearTimer]);

  // ── Re-schedule when state changes ───────────────────────────────────────
  useEffect(() => {
    if (presence.state) {
      scheduleRenewal();
    }
    return clearTimer;
  }, [presence.state?.stateValidUntil, presence.state?.nextMeasurementAt, scheduleRenewal, clearTimer]);
}
