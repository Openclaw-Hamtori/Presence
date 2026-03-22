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
  PendingProofRequest,
} from "../types/index";
import {
  normalizeLinkSessionStatus,
  normalizePresenceSnapshotSource,
} from "../types/index";

const STORAGE_KEY = "@presence:state:v2";
const LEGACY_STORAGE_KEY = "@presence:state:v1";
const STATE_VALIDITY_SECONDS = 72 * 60 * 60;
const SCHEDULED_CHECK_LEAD_SECONDS = 30 * 60;
const FAILED_RETRY_SECONDS = 30 * 60;

export async function loadPresenceState(): Promise<PresenceState | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PresenceState;
      const normalized = withComputedStatus(parsed);
      if (JSON.stringify(normalized) !== JSON.stringify(parsed)) {
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
      }
      return normalized;
    }

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
      pendingProofRequests: [],
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
  serviceBindings?: ServiceBinding[];
  pendingProofRequests?: PendingProofRequest[];
  linkedDevice?: PresenceState["linkedDevice"];
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

  const preservedBindings = params.binding
    ? touchBindingsForMeasurement([params.binding], { capturedAt: now })
    : touchBindingsForMeasurement(params.serviceBindings ?? [], { capturedAt: now });

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
    linkedDevice: params.linkedDevice
      ? {
          ...params.linkedDevice,
          iss: params.iss,
          platform: "ios",
        }
      : {
          iss: params.iss,
          platform: "ios",
          linkedAt: now,
        },
    activeLinkSession: params.linkSession,
    serviceBindings: preservedBindings,
    pendingProofRequests: normalizePendingProofRequests(params.pendingProofRequests),
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
    (item) => (
      item.linkedDeviceIss === binding.linkedDeviceIss
      && item.serviceId === binding.serviceId
      && item.accountId === binding.accountId
      && isActiveBinding(item)
    )
  );
  const existing = existingById ?? existingByLogicalKey;

  const nextStatus = resolveBindingStatus(existing, binding.status, options);
  const bindings = state.serviceBindings.filter((item) => {
    if (item.bindingId === binding.bindingId) return false;
    if (
      isActiveBinding(item) &&
      item.linkedDeviceIss === binding.linkedDeviceIss &&
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
    sync: mergeBindingSyncMetadata(existing?.sync, binding.sync),
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

export function replacePendingProofRequests(
  state: PresenceState,
  requests: PendingProofRequest[]
): PresenceState {
  return withComputedStatus({
    ...state,
    pendingProofRequests: normalizePendingProofRequests(requests),
  });
}

export function upsertPendingProofRequest(
  state: PresenceState,
  request: PendingProofRequest
): PresenceState {
  const next = (state.pendingProofRequests ?? [])
    .filter((existing) => existing.requestId !== request.requestId)
    .concat(request);
  return replacePendingProofRequests(state, next);
}

export function removePendingProofRequest(
  state: PresenceState,
  requestId: string
): PresenceState {
  return replacePendingProofRequests(
    state,
    (state.pendingProofRequests ?? []).filter((request) => request.requestId !== requestId)
  );
}

export function getActivePendingProofRequests(state: PresenceState): PendingProofRequest[] {
  return normalizePendingProofRequests(state.pendingProofRequests)
    .filter((request) => request.status === "pending");
}

export function isCheckDue(state: PresenceState): boolean {
  const now = Math.floor(Date.now() / 1000);
  if (state.pass) {
    const remaining = state.stateValidUntil - now;
    return remaining > 0 && remaining <= SCHEDULED_CHECK_LEAD_SECONDS;
  }
  const status = computeStateStatus(state);
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
  const activeLinkSession = state.activeLinkSession
    ? {
        ...state.activeLinkSession,
        status: normalizeLinkSessionStatus(state.activeLinkSession.status) ?? "pending",
      }
    : undefined;
  const lastSnapshotSource = normalizePresenceSnapshotSource(state.lastSnapshot.source);
  const normalizedBaseState = (
    activeLinkSession === state.activeLinkSession
    && lastSnapshotSource === state.lastSnapshot.source
  )
    ? state
    : {
        ...state,
        activeLinkSession,
        lastSnapshot: {
          ...state.lastSnapshot,
          source: lastSnapshotSource,
        },
      };
  const pendingProofRequests = normalizePendingProofRequests(normalizedBaseState.pendingProofRequests);
  const serviceBindings = suppressShadowedLegacyUnsyncableBindings(normalizedBaseState.serviceBindings);

  if (!normalizedBaseState.activeLinkSession || normalizedBaseState.activeLinkSession.expiresAt > now) {
    return serviceBindings === normalizedBaseState.serviceBindings
      && pendingProofRequests === normalizedBaseState.pendingProofRequests
      ? normalizedBaseState
      : {
          ...normalizedBaseState,
          serviceBindings,
          pendingProofRequests,
        };
  }

  return {
    ...normalizedBaseState,
    serviceBindings,
    pendingProofRequests,
    activeLinkSession: {
      ...normalizedBaseState.activeLinkSession,
      status: "expired",
    },
  };
}

export function isActiveBinding(binding: ServiceBinding): boolean {
  return binding.status !== "unlinked" && binding.status !== "revoked";
}

export function suppressShadowedLegacyUnsyncableBindings(bindings: ServiceBinding[]): ServiceBinding[] {
  if (bindings.length < 2) return bindings;

  const shadowedBindingIds = getShadowedLegacyUnsyncableBindingIds(bindings);
  if (shadowedBindingIds.size === 0) {
    return bindings;
  }

  return bindings.filter((binding) => !shadowedBindingIds.has(binding.bindingId));
}

export function getShadowedLegacyUnsyncableBindingIds(bindings: ServiceBinding[]): Set<string> {
  const shadowedBindingIds = new Set<string>();

  for (const binding of bindings) {
    if (isShadowedLegacyUnsyncableBinding(binding, bindings)) {
      shadowedBindingIds.add(binding.bindingId);
    }
  }

  return shadowedBindingIds;
}

export function isShadowedLegacyUnsyncableBinding(
  binding: ServiceBinding,
  bindings: ServiceBinding[]
): boolean {
  if (!isActiveBinding(binding) || hasRequiredBindingSyncMetadata(binding.sync)) {
    return false;
  }

  return bindings.some((candidate) => (
    candidate.bindingId !== binding.bindingId
    && isActiveBinding(candidate)
    && hasRequiredBindingSyncMetadata(candidate.sync)
    && sharesBindingShadowScope(candidate, binding)
  ));
}

export function hasActiveServiceBindings(bindings: ServiceBinding[]): boolean {
  return bindings.some((binding) => isActiveBinding(binding));
}

export function hasSyncableServiceBindings(bindings: ServiceBinding[]): boolean {
  return bindings.some((binding) => isActiveBinding(binding) && hasRequiredBindingSyncMetadata(binding.sync));
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

function sharesBindingShadowScope(a: ServiceBinding, b: ServiceBinding): boolean {
  if (a.linkedDeviceIss !== b.linkedDeviceIss || a.serviceId !== b.serviceId) {
    return false;
  }

  if (a.accountId && b.accountId) {
    return a.accountId === b.accountId;
  }

  return true;
}

function normalizeOptionalSyncValue(value?: string): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeBindingSyncMetadata(
  sync: ServiceBinding["sync"] | undefined | null
): ServiceBinding["sync"] | undefined {
  if (!sync) return undefined;

  const normalized = {
    serviceDomain: normalizeOptionalSyncValue(sync.serviceDomain),
    nonceUrl: normalizeOptionalSyncValue(sync.nonceUrl),
    verifyUrl: normalizeOptionalSyncValue(sync.verifyUrl),
    statusUrl: normalizeOptionalSyncValue(sync.statusUrl),
    pendingRequestsUrl: normalizeOptionalSyncValue(sync.pendingRequestsUrl),
  };

  return normalized.serviceDomain || normalized.nonceUrl || normalized.verifyUrl || normalized.statusUrl || normalized.pendingRequestsUrl
    ? normalized
    : undefined;
}

export function hasRequiredBindingSyncMetadata(
  sync: ServiceBinding["sync"] | undefined | null
): boolean {
  const normalized = normalizeBindingSyncMetadata(sync);
  return !!normalized?.nonceUrl && !!normalized?.verifyUrl;
}

export function mergeBindingSyncMetadata(
  existingSync: ServiceBinding["sync"] | undefined,
  incomingSync: ServiceBinding["sync"] | undefined
): ServiceBinding["sync"] | undefined {
  const normalizedExisting = normalizeBindingSyncMetadata(existingSync);
  const normalizedIncoming = normalizeBindingSyncMetadata(incomingSync);

  if (!normalizedExisting) return normalizedIncoming;
  if (!normalizedIncoming) return normalizedExisting;
  return {
    ...normalizedExisting,
    ...normalizedIncoming,
  };
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

function normalizePendingProofRequests(
  requests: PendingProofRequest[] | undefined
): PendingProofRequest[] {
  if (!requests || requests.length === 0) {
    return [];
  }

  const now = Math.floor(Date.now() / 1000);
  return requests
    .map((request) => (
      request.status === "pending" && request.expiresAt <= now
        ? { ...request, status: "expired" as const }
        : request
    ))
    .sort((a, b) => b.requestedAt - a.requestedAt);
}
