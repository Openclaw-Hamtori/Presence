import {
  loadPresenceState,
  savePresenceState,
  replacePendingProofRequests,
  removePendingProofRequest,
  upsertPendingProofRequest,
} from "../state/presenceState";
import { validateBindingSyncConfiguration } from "../linkTrust";
import { markBindingMismatchForRecovery, markBindingVerified, measure, proveMeasured } from "../service";
import type { MeasureResult } from "../service";
import type { PendingProofRequest, PresenceState, ServiceBinding } from "../types/index";

interface PendingProofRequestDescriptor {
  requestId: string;
  serviceId: string;
  accountId: string;
  bindingId: string;
  deviceIss: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  status: PendingProofRequest["status"];
  endpoints?: {
    respond?: { path?: string };
    status?: { path?: string };
    unlink?: { path?: string };
  };
}

interface PendingProofRequestListResponse {
  ok: true;
  proofRequests: PendingProofRequestDescriptor[];
}

export interface PendingProofRequestSyncError {
  bindingId: string;
  message: string;
}

export interface PendingProofRequestSyncResult {
  requests: PendingProofRequest[];
  errors: PendingProofRequestSyncError[];
}

export interface PendingProofRequestSubmissionResult {
  requestId: string;
  bindingId: string;
  status: "verified" | "recovery_required" | "skipped";
  verifyResponse?: unknown;
}

export async function syncPendingProofRequests(params: {
  state?: PresenceState | null;
  bindings?: ServiceBinding[];
} = {}): Promise<PendingProofRequestSyncResult> {
  const state = params.state ?? (await loadPresenceState());
  if (!state) {
    return { requests: [], errors: [] };
  }

  const bindings = (params.bindings ?? state.serviceBindings)
    .filter((binding) => binding.status === "linked" && !!binding.sync?.pendingRequestsUrl);
  const fetchedRequests: PendingProofRequest[] = [];
  const queriedBindingIds = new Set<string>();
  const errors: PendingProofRequestSyncError[] = [];

  for (const binding of bindings) {
    queriedBindingIds.add(binding.bindingId);
    try {
      const trustValidation = await validateBindingSyncConfiguration({
        serviceId: binding.serviceId,
        sync: binding.sync,
      });
      if (!trustValidation.ok) {
        throw trustValidation.error;
      }

      const response = await requestJson<PendingProofRequestListResponse>(binding.sync!.pendingRequestsUrl!, {
        method: "GET",
      });
      const requests = (response.proofRequests ?? [])
        .filter((request) => request.bindingId === binding.bindingId)
        .map((request) => toPendingProofRequest(request, binding));
      fetchedRequests.push(...requests);
    } catch (error) {
      errors.push({
        bindingId: binding.bindingId,
        message: toErrorMessage(error),
      });
    }
  }

  const untouchedRequests = (state.pendingProofRequests ?? [])
    .filter((request) => !queriedBindingIds.has(request.bindingId));
  const nextRequests = dedupePendingProofRequests([...untouchedRequests, ...fetchedRequests]);
  const nextState = replacePendingProofRequests(state, nextRequests);
  if (JSON.stringify(nextState.pendingProofRequests ?? []) !== JSON.stringify(state.pendingProofRequests ?? [])) {
    await savePresenceState(nextState);
  }
  return { requests: nextState.pendingProofRequests ?? [], errors };
}

export async function submitPendingProofRequest(params: {
  request: PendingProofRequest;
  binding: ServiceBinding;
  measurement?: MeasureResult | null;
  state?: PresenceState | null;
}): Promise<PendingProofRequestSubmissionResult> {
  const measurement = await getMeasurement(params.measurement);
  if (!measurement) {
    throw new Error("measurement unavailable");
  }

  if (!measurement.pass) {
    return {
      requestId: params.request.requestId,
      bindingId: params.binding.bindingId,
      status: "skipped",
    };
  }

  if (params.request.status !== "pending") {
    throw new Error(`pending proof request is ${params.request.status}`);
  }

  if (!isAbsoluteUrl(params.request.respondUrl)) {
    throw new Error("pending proof request respond URL must be absolute");
  }

  const proof = await proveMeasured(measurement, {
    nonce: params.request.nonce,
    persistLocalState: false,
    flow: "reauth",
    bindingHint: {
      bindingId: params.binding.bindingId,
      serviceId: params.binding.serviceId,
      accountId: params.binding.accountId,
      sync: params.binding.sync,
    },
  });
  if (!proof.ok) {
    throw proof.error;
  }

  const verifyResponse = await requestJson<any>(params.request.respondUrl, {
    method: "POST",
    body: JSON.stringify(proof.value.payload),
  });

  const currentState = params.state ?? proof.value.state ?? (await loadPresenceState());
  if (!currentState) {
    throw new Error("presence state unavailable");
  }

  if (verifyResponse && verifyResponse.ok === false && verifyResponse.code === "ERR_BINDING_RECOVERY_REQUIRED") {
    await markBindingMismatchForRecovery(
      params.binding.bindingId,
      verifyResponse.recovery?.reason ?? verifyResponse.message ?? "binding_recovery_required"
    );
    const recoveryState = await loadPresenceState();
    if (recoveryState) {
      const nextState = upsertPendingProofRequest(recoveryState, {
        ...params.request,
        status: "recovery_required",
      });
      await savePresenceState(nextState);
    }
    return {
      requestId: params.request.requestId,
      bindingId: params.binding.bindingId,
      status: "recovery_required",
      verifyResponse,
    };
  }

  if (!verifyResponse || verifyResponse.ok !== true) {
    throw new Error("pending proof request respond endpoint returned no explicit success");
  }

  const verifiedState = removePendingProofRequest(currentState, params.request.requestId);
  await savePresenceState(verifiedState);
  await markBindingVerified(params.binding.bindingId);
  return {
    requestId: params.request.requestId,
    bindingId: params.binding.bindingId,
    status: "verified",
    verifyResponse,
  };
}

async function getMeasurement(measurement?: MeasureResult | null): Promise<MeasureResult | null> {
  if (measurement) return measurement;
  const result = await measure();
  return result.ok ? result.value : null;
}

function toPendingProofRequest(
  request: PendingProofRequestDescriptor,
  binding: ServiceBinding
): PendingProofRequest {
  return {
    requestId: request.requestId,
    serviceId: request.serviceId,
    accountId: request.accountId,
    bindingId: request.bindingId,
    deviceIss: request.deviceIss,
    nonce: request.nonce,
    requestedAt: request.issuedAt,
    expiresAt: request.expiresAt,
    status: request.status,
    respondUrl: String(request.endpoints?.respond?.path ?? ""),
    statusUrl: request.endpoints?.status?.path,
    unlinkUrl: request.endpoints?.unlink?.path,
    serviceDomain: binding.sync?.serviceDomain,
  };
}

function dedupePendingProofRequests(requests: PendingProofRequest[]): PendingProofRequest[] {
  const byId = new Map<string, PendingProofRequest>();
  for (const request of requests) {
    const existing = byId.get(request.requestId);
    if (!existing || request.requestedAt >= existing.requestedAt) {
      byId.set(request.requestId, request);
    }
  }
  return [...byId.values()].sort((a, b) => b.requestedAt - a.requestedAt);
}

function isAbsoluteUrl(value?: string): boolean {
  if (!value) return false;
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const raw = await response.text();
  const parsed = raw ? JSON.parse(raw) : null;
  if (!response.ok) {
    throw new Error(parsed?.message ?? `request failed (${response.status})`);
  }
  return parsed as T;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
