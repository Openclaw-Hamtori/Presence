/**
 * presence-mobile — usePresenceState Hook
 *
 * React hook that manages Presence state lifecycle:
 *   - Load persisted state on mount
 *   - Expose prove() with loading/error states
 *   - Keep internal timing logic out of the product-facing model
 *   - Drive onboarding flow
 */

import { useState, useEffect, useCallback } from "react";
import { prove, measure } from "../service";
import type { ProveOptions, MeasureOptions, MeasureResult } from "../service";
import {
  loadPresenceState,
  computeStateStatus,
} from "../state/presenceState";
import { requestHealthKitPermissions, isHealthKitAvailable } from "../health/healthkit";
import type {
  PresenceState,
  PresenceTransportPayload,
  PresenceMobileError,
} from "../types/index";
import { PresenceMobileError as PresenceMobileErrorClass } from "../types/index";

// ─── Types ────────────────────────────────────────────────────────────────────

export type PresenceHookPhase =
  | "loading"           // initial load
  | "needs_healthkit"   // HealthKit permission required
  | "ready"             // has valid state
  | "not_ready"         // latest measurement failed
  | "recovery_pending"  // linked account needs recovery / relink
  | "uninitialized"     // no state yet (first launch)
  | "measuring"         // measure() in progress
  | "proving"           // prove() in progress
  | "error";            // terminal error

export interface UsePresenceStateResult {
  phase: PresenceHookPhase;
  state: PresenceState | null;
  error: PresenceMobileError | null;
  /** Read 72h health data and update local PASS/FAIL state */
  measure: (options?: MeasureOptions) => Promise<MeasureResult | null>;
  /** Call with service nonce or full prove options to generate proof */
  prove: (nonceOrOptions: string | ProveOptions) => Promise<PresenceTransportPayload | null>;
  /** Reload state from persistence after external updates */
  refresh: () => Promise<PresenceState | null>;
  /** Request HealthKit permissions */
  requestPermissions: () => Promise<boolean>;
  /** Reset error state */
  clearError: () => void;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function usePresenceState(): UsePresenceStateResult {
  const [phase, setPhase] = useState<PresenceHookPhase>("loading");
  const [state, setState] = useState<PresenceState | null>(null);
  const [error, setError] = useState<PresenceMobileError | null>(null);

  const phaseFromState = useCallback(
    (nextState: PresenceState | null, fallback: PresenceHookPhase = "uninitialized"): PresenceHookPhase => {
      if (!nextState) return fallback;
      const status = computeStateStatus(nextState);
      if (status === "recovery_pending") return "recovery_pending";
      if (status === "not_ready" || status === "expired") return "not_ready";
      return "ready";
    },
    []
  );

  // ── Load persisted state on mount ─────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const persisted = await loadPresenceState();
      if (cancelled) return;

      if (!persisted) {
        setPhase("uninitialized");
        return;
      }

      setState(persisted);
      setPhase(phaseFromState(persisted));
    })();
    return () => { cancelled = true; };
  }, [phaseFromState]);

  useEffect(() => {
    if (!state) return;
    if (phase === "loading" || phase === "measuring" || phase === "proving" || phase === "error") {
      return;
    }

    const syncPhase = () => {
      setPhase((current) => {
        if (current === "loading" || current === "measuring" || current === "proving" || current === "error") {
          return current;
        }
        return phaseFromState(state, current);
      });
    };

    syncPhase();
    const interval = setInterval(syncPhase, 1000);
    return () => clearInterval(interval);
  }, [state, phase, phaseFromState]);

  // ── Request HealthKit permissions ─────────────────────────────────────────
  const requestPermissions = useCallback(async (): Promise<boolean> => {
    if (!isHealthKitAvailable()) {
      setError(new PresenceMobileErrorClass(
        "ERR_HEALTHKIT_UNAVAILABLE",
        "HealthKit is not available on this device"
      ));
      setPhase("error");
      return false;
    }

    const result = await requestHealthKitPermissions();
    if (!result.ok) {
      setError(result.error);
      setPhase("error");
      return false;
    }
    return true;
  }, []);

  const refresh = useCallback(async (): Promise<PresenceState | null> => {
    const persisted = await loadPresenceState();
    setState(persisted);
    setError(null);
    setPhase(phaseFromState(persisted));
    return persisted;
  }, [phaseFromState]);

  // ── Measure ───────────────────────────────────────────────────────────────
  const runMeasure = useCallback(async (options: MeasureOptions = {}): Promise<MeasureResult | null> => {
    setPhase("measuring");
    setError(null);

    const result = await measure(options);

    if (!result.ok) {
      setError(result.error);
      setPhase("error");
      return null;
    }

    const persisted = await loadPresenceState();
    const nextState = persisted ?? result.value.state;

    setState(nextState);
    if (!result.value.pass) {
      setError(new PresenceMobileErrorClass("ERR_PASS_FALSE", result.value.reason));
    }
    setPhase(phaseFromState(nextState, result.value.pass ? "ready" : "not_ready"));

    return { ...result.value, state: nextState };
  }, [phaseFromState]);

  // ── Prove ─────────────────────────────────────────────────────────────────
  const runProve = useCallback(async (nonceOrOptions: string | ProveOptions): Promise<PresenceTransportPayload | null> => {
    setPhase("proving");
    setError(null);

    const result = await prove(typeof nonceOrOptions === "string" ? { nonce: nonceOrOptions } : nonceOrOptions);

    if (!result.ok) {
      if (result.error.code === "ERR_PASS_FALSE") {
        const persisted = await loadPresenceState();
        setState(persisted);
        setError(result.error);
        setPhase(phaseFromState(persisted, "not_ready"));
        return null;
      }

      setError(result.error);
      setPhase("error");
      return null;
    }

    const persisted = await loadPresenceState();
    const nextState = persisted ?? result.value.state;

    setState(nextState);
    setPhase(phaseFromState(nextState, "ready"));

    return result.value.payload;
  }, [phaseFromState]);

  return {
    phase,
    state,
    error,
    measure: runMeasure,
    prove: runProve,
    refresh,
    requestPermissions,
    clearError: () => {
      setError(null);
      setPhase(phaseFromState(state));
    },
  };
}
