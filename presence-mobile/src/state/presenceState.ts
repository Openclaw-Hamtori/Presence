/**
 * presence-mobile — Presence State Manager
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import type {
  PresenceState,
  PresenceStateStatus,
  PresenceSignal,
  ServiceBinding,
  LinkSession,
  PresenceSnapshot,
} from "../types/index";

const STORAGE_KEY = "@presence:state:v2";
const LEGACY_STORAGE_KEY = "@presence:state:v1";
const STATE_VALIDITY_SECONDS = 72 * 60 * 60;
const SCHEDULED_CHECK_LEAD_SECONDS = 30 * 60;
const FAILED_RETRY_SECONDS = 30 * 60;

export async function loadPresenceState(): Promise<PresenceState | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) return withComputedStatus(JSON.parse(raw) as PresenceState);

    const legacyRaw = await AsyncStorage.getItem(LEGACY_STORAGE_KEY);
    if (!legacyRaw) return null;

    const legacy = JSON.parse(legacyRaw) as {
      iss: string;
      stateCreatedAt: number;
      stateValidUntil: number;
      pass: boolean;
      lastSignals: PresenceSignal[];
      platform: "ios";
    };

    const migrated: PresenceState = withComputedStatus({
      status: "ready",
      iss: legacy.iss,
      stateCreatedAt: legacy.stateCreatedAt,
      stateValidUntil: legacy.stateValidUntil,
      pass: legacy.pass,
      lastSignals: legacy.lastSignals,
      lastMeasuredAt: legacy.stateCreatedAt,
      lastPassedAt: legacy.pass ? legacy.stateCreatedAt : undefined,
      lastFailedAt: legacy.pass ? undefined : legacy.stateCreatedAt,
      nextMeasurementAt: computeNextMeasurementAt({
        capturedAt: legacy.stateCreatedAt,
        pass: legacy.pass,
        stateValidUntil: legacy.stateValidUntil,
      }),
      lastMeasurementReason: legacy.pass ? "migrated_legacy_state" : "legacy_state_not_ready",
      platform: legacy.platform,
      linkedDevice: {
        iss: legacy.iss,
        platform: legacy.platform,
        linkedAt: legacy.stateCreatedAt,
      },
      serviceBindings: [],
      lastSnapshot: {
        capturedAt: legacy.stateCreatedAt,
        pass: legacy.pass,
        signals: legacy.lastSignals,
        stateCreatedAt: legacy.stateCreatedAt,
        stateValidUntil: legacy.stateValidUntil,
        reason: legacy.pass ? "migrated_legacy_state" : "legacy_state_not_ready",
        source: "measurement",
      },
    });

    await savePresenceState(migrated);
    await AsyncStorage.removeItem(LEGACY_STORAGE_KEY);
    return migrated;
  } catch {
    return null;
  }
}

export async function savePresenceState(state: PresenceState): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(withComputedStatus(state)));
}

export async function clearPresenceState(): Promise<void> {
  await AsyncStorage.multiRemove([STORAGE_KEY, LEGACY_STORAGE_KEY]);
}

/**
 * Internal timing status. Product-facing UI should generally collapse raw
 * scheduler states into PASS / FAIL while handling recovery separately.
 */
export function computeStateStatus(state: PresenceState): PresenceStateStatus {
  const now = Math.floor(Date.now() / 1000);
  const remaining = state.stateValidUntil - now;

  if (!state.pass) return "not_ready";
  if (remaining <= 0) return "expired";
  if (state.serviceBindings.some((binding) => binding.status === "recovery_pending" || binding.status === "reauth_required")) {
    return "recovery_pending";
  }
  if (remaining <= SCHEDULED_CHECK_LEAD_SECONDS) return "check_due";
  return "ready";
}

export function isStateUsable(state: PresenceState): boolean {
  const status = computeStateStatus(state);
  return status === "ready" || status === "check_due" || status === "recovery_pending";
}

export function createPresenceState(params: {
  iss: string;
  pass: boolean;
  signals: PresenceSignal[];
  linkSession?: LinkSession;
  binding?: ServiceBinding;
  capturedAt?: number;
  reason?: string;
}): PresenceState {
  const now = params.capturedAt ?? Math.floor(Date.now() / 1000);
  const stateValidUntil = params.pass ? now + STATE_VALIDITY_SECONDS : now;
  const snapshot: PresenceSnapshot = {
    capturedAt: now,
    pass: params.pass,
    signals: params.signals,
    stateCreatedAt: now,
    stateValidUntil,
    reason: params.reason,
    source: "measurement",
  };

  return withComputedStatus({
    status: "ready",
    iss: params.iss,
    stateCreatedAt: now,
    stateValidUntil,
    pass: params.pass,
    lastSignals: params.signals,
    lastMeasuredAt: now,
    lastPassedAt: params.pass ? now : undefined,
    lastFailedAt: params.pass ? undefined : now,
    nextMeasurementAt: computeNextMeasurementAt({
      capturedAt: now,
      pass: params.pass,
      stateValidUntil,
    }),
    lastMeasurementReason: params.reason,
    platform: "ios",
    linkedDevice: {
      iss: params.iss,
      platform: "ios",
      linkedAt: now,
    },
    activeLinkSession: params.linkSession,
    serviceBindings: params.binding ? touchBindingsForMeasurement([params.binding], { capturedAt: now }) : [],
    lastSnapshot: snapshot,
  });
}

export function updatePresenceSnapshot(
  state: PresenceState,
  params: {
    pass: boolean;
    signals: PresenceSignal[];
    attestedAt?: number;
    stateCreatedAt?: number;
    stateValidUntil?: number;
    capturedAt?: number;
    reason?: string;
    source?: "measurement" | "proof";
  }
): PresenceState {
  const capturedAt = params.capturedAt ?? Math.floor(Date.now() / 1000);
  const stateCreatedAt = params.stateCreatedAt ?? state.stateCreatedAt;
  const stateValidUntil = params.stateValidUntil ?? state.stateValidUntil;

  return withComputedStatus({
    ...state,
    pass: params.pass,
    lastSignals: params.signals,
    stateCreatedAt,
    stateValidUntil,
    lastMeasuredAt: capturedAt,
    lastPassedAt: params.pass ? capturedAt : state.lastPassedAt,
    lastFailedAt: params.pass ? state.lastFailedAt : capturedAt,
    nextMeasurementAt: computeNextMeasurementAt({
      capturedAt,
      pass: params.pass,
      stateValidUntil,
    }),
    lastMeasurementReason: params.reason,
    serviceBindings: touchBindingsForMeasurement(state.serviceBindings, {
      capturedAt,
      failureReason: params.pass ? undefined : params.reason,
    }),
    lastSnapshot: {
      capturedAt,
      attestedAt: params.attestedAt,
      pass: params.pass,
      signals: params.signals,
      stateCreatedAt,
      stateValidUntil,
      reason: params.reason,
      source: params.source ?? (params.attestedAt ? "proof" : "measurement"),
    },
  });
}

export function addOrUpdateServiceBinding(
  state: PresenceState,
  binding: ServiceBinding,
  options?: { allowLinkedRecoveryExit?: boolean }
): PresenceState {
  const existingById = state.serviceBindings.find((item) => item.bindingId === binding.bindingId);
  const existingByLogicalKey = state.serviceBindings.find(
    (item) => item.serviceId === binding.serviceId && item.accountId === binding.accountId && isActiveBinding(item)
  );
  const existing = existingById ?? existingByLogicalKey;

  const nextStatus = resolveBindingStatus(existing, binding.status, options);
  const bindings = state.serviceBindings.filter((item) => {
    if (item.bindingId === binding.bindingId) return false;
    if (
      isActiveBinding(item) &&
      item.serviceId === binding.serviceId &&
      item.accountId === binding.accountId
    ) {
      return false;
    }
    return true;
  });

  bindings.push({
    ...existing,
    ...binding,
    bindingId: binding.bindingId,
    status: nextStatus,
    sync: binding.sync ?? existing?.sync,
    recoveryStartedAt: nextStatus === "recovery_pending" || nextStatus === "reauth_required"
      ? binding.recoveryStartedAt ?? existing?.recoveryStartedAt
      : undefined,
    recoveryReason: nextStatus === "recovery_pending" || nextStatus === "reauth_required"
      ? binding.recoveryReason ?? existing?.recoveryReason
      : undefined,
  });
  return withComputedStatus({ ...state, serviceBindings: bindings });
}

export function markBindingForRecovery(
  state: PresenceState,
  params: { bindingId: string; recoveryReason: string; status?: "reauth_required" | "recovery_pending" }
): PresenceState {
  const now = Math.floor(Date.now() / 1000);
  return withComputedStatus({
    ...state,
    linkedDevice: { ...state.linkedDevice, recoveryStartedAt: now },
    serviceBindings: state.serviceBindings.map((binding) =>
      binding.bindingId === params.bindingId
        ? {
            ...binding,
            status: params.status ?? "recovery_pending",
            recoveryStartedAt: now,
            recoveryReason: params.recoveryReason,
          }
        : binding
    ),
  });
}

export function unlinkServiceBinding(state: PresenceState, bindingId: string): PresenceState {
  return withComputedStatus({
    ...state,
    serviceBindings: state.serviceBindings.map((binding) =>
      binding.bindingId === bindingId
        ? { ...binding, status: "unlinked", recoveryReason: undefined }
        : binding
    ),
  });
}

export function markBindingLinked(state: PresenceState, bindingId: string): PresenceState {
  return withComputedStatus({
    ...state,
    serviceBindings: state.serviceBindings.map((binding) =>
      binding.bindingId === bindingId
        ? {
            ...binding,
            status: "linked",
            recoveryStartedAt: undefined,
            recoveryReason: undefined,
            lastVerifiedAt: Math.floor(Date.now() / 1000),
          }
        : binding
    ),
  });
}

export function attachLinkSession(state: PresenceState, session: LinkSession): PresenceState {
  return withComputedStatus({ ...state, activeLinkSession: session });
}

export function isCheckDue(state: PresenceState): boolean {
  const now = Math.floor(Date.now() / 1000);
  const status = computeStateStatus(state);
  if (status === "check_due" || status === "expired") return true;
  if (status === "not_ready") {
    return (state.nextMeasurementAt ?? now) <= now;
  }
  return false;
}

export function secondsUntilNextMeasurement(state: PresenceState): number {
  const now = Math.floor(Date.now() / 1000);
  if (!state.pass) {
    return Math.max(0, (state.nextMeasurementAt ?? now) - now);
  }

  const scheduledCheckStart = state.stateValidUntil - SCHEDULED_CHECK_LEAD_SECONDS;
  return Math.max(0, scheduledCheckStart - now);
}

export function recordFailedMeasurement(
  state: PresenceState,
  params: {
    signals: PresenceSignal[];
    reason: string;
    capturedAt?: number;
  }
): PresenceState {
  const capturedAt = params.capturedAt ?? Math.floor(Date.now() / 1000);
  return updatePresenceSnapshot(state, {
    pass: false,
    signals: params.signals,
    capturedAt,
    reason: params.reason,
    source: "measurement",
    stateCreatedAt: state.stateCreatedAt,
    stateValidUntil: capturedAt,
  });
}

function withComputedStatus(state: PresenceState): PresenceState {
  const normalized = normalizeState(state);
  return { ...normalized, status: computeStateStatus(normalized) };
}

function normalizeState(state: PresenceState): PresenceState {
  const now = Math.floor(Date.now() / 1000);
  if (!state.activeLinkSession || state.activeLinkSession.expiresAt > now) {
    return state;
  }

  return {
    ...state,
    activeLinkSession: {
      ...state.activeLinkSession,
      status: "expired",
    },
  };
}

function isActiveBinding(binding: ServiceBinding): boolean {
  return binding.status !== "unlinked" && binding.status !== "revoked";
}

function resolveBindingStatus(
  existing: ServiceBinding | undefined,
  incomingStatus: ServiceBinding["status"],
  options?: { allowLinkedRecoveryExit?: boolean }
): ServiceBinding["status"] {
  if (!existing) return incomingStatus;
  if (
    (existing.status === "recovery_pending" || existing.status === "reauth_required") &&
    incomingStatus === "linked" &&
    !options?.allowLinkedRecoveryExit
  ) {
    return existing.status;
  }
  return incomingStatus;
}

function computeNextMeasurementAt(params: {
  capturedAt: number;
  pass: boolean;
  stateValidUntil: number;
}): number {
  if (!params.pass) {
    return params.capturedAt + FAILED_RETRY_SECONDS;
  }

  return Math.max(params.capturedAt, params.stateValidUntil - SCHEDULED_CHECK_LEAD_SECONDS);
}

function touchBindingsForMeasurement(
  bindings: ServiceBinding[],
  params: {
    capturedAt: number;
    failureReason?: string;
  }
): ServiceBinding[] {
  return bindings.map((binding) => ({
    ...binding,
    lastMeasuredAt: params.capturedAt,
    lastFailedAt: params.failureReason ? params.capturedAt : undefined,
    lastFailureReason: params.failureReason,
  }));
}
