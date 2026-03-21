import { loadPresenceState, savePresenceState } from "../state/presenceState";
import { validateBindingSyncConfiguration } from "../linkTrust";
import { markBindingMismatchForRecovery, markBindingSyncExhausted, markBindingVerified, measure, proveMeasured } from "../service";
import type { MeasureResult } from "../service";
import type { PresenceState, ServiceBinding } from "../types/index";
import {
  loadLinkedBindingSyncJobs,
  upsertLinkedBindingSyncJob,
  removeLinkedBindingSyncJob,
  recordLinkedBindingSyncFailure,
  hasRemainingLinkedBindingSyncAttempts,
} from "./queue";

export interface LinkedBindingSyncError {
  bindingId: string;
  message: string;
}

export type LinkedBindingProofSubmissionStatus = "verified" | "recovery_required" | "skipped";

export interface LinkedBindingProofSubmissionResult {
  bindingId: string;
  status: LinkedBindingProofSubmissionStatus;
  nonce?: string;
  verifyResponse?: any;
}

export interface LinkedBindingSyncResult {
  attempted: number;
  verified: number;
  recoveryRequired: number;
  skipped: number;
  errors: LinkedBindingSyncError[];
}

export async function syncLinkedBindings(params: {
  measurement?: MeasureResult | null;
} = {}): Promise<LinkedBindingSyncResult> {
  const measured = await getMeasurement(params.measurement);
  const state = measured?.state ?? (await loadPresenceState());
  const currentBindings = measured && state
    ? state.serviceBindings.filter((binding) => (
      !isShadowedLegacyUnsyncableBinding(binding, state.serviceBindings)
      && isSyncableBinding(binding, measured.pass)
    ))
    : [];

  const result = await flushQueuedLinkedBindingSyncs({
    skipBindingIds: currentBindings.map((binding) => binding.bindingId),
  });

  if (!measured || !state) {
    return result;
  }

  for (const binding of currentBindings) {
    result.attempted += 1;
    try {
      const outcome = await executeBindingSync(binding, measured, state);
      applyOutcome(result, outcome.status);
      await removeLinkedBindingSyncJob(binding.bindingId);
    } catch (error) {
      const message = toErrorMessage(error);
      if (isTrustFailure(error)) {
        await markBindingSyncExhausted(binding.bindingId);
        result.errors.push({ bindingId: binding.bindingId, message });
        continue;
      }
      const job = await upsertLinkedBindingSyncJob({ binding, measurement: measured });
      const exhausted = await recordLinkedBindingSyncFailure(binding.bindingId, message);
      if (job && exhausted) {
        await markBindingSyncExhausted(binding.bindingId);
      }
      result.errors.push({ bindingId: binding.bindingId, message });
    }
  }

  return result;
}

export async function flushQueuedLinkedBindingSyncs(params: {
  skipBindingIds?: string[];
} = {}): Promise<LinkedBindingSyncResult> {
  const jobs = await loadLinkedBindingSyncJobs();
  if (jobs.length === 0) {
    return emptyResult();
  }

  const skipBindingIds = new Set(params.skipBindingIds ?? []);
  const state = await loadPresenceState();
  const bindings = new Map(state?.serviceBindings.map((binding) => [binding.bindingId, binding]) ?? []);
  const stateBindings = state?.serviceBindings ?? [];
  const result = emptyResult();

  for (const job of jobs) {
    if (skipBindingIds.has(job.binding.bindingId)) {
      continue;
    }

    const binding = resolveBinding(bindings.get(job.binding.bindingId), job.binding);
    if (isShadowedLegacyUnsyncableBinding(binding, stateBindings)) {
      await removeLinkedBindingSyncJob(job.binding.bindingId);
      continue;
    }

    result.attempted += 1;
    if (!hasRemainingLinkedBindingSyncAttempts(job) || !isRetryableBinding(binding, job.measurement.pass)) {
      await removeLinkedBindingSyncJob(job.binding.bindingId);
      result.skipped += 1;
      continue;
    }

    try {
      const outcome = await executeBindingSync(binding, job.measurement, state);
      applyOutcome(result, outcome.status);
      await removeLinkedBindingSyncJob(binding.bindingId);
    } catch (error) {
      const message = toErrorMessage(error);
      if (isTrustFailure(error)) {
        await removeLinkedBindingSyncJob(binding.bindingId);
        await markBindingSyncExhausted(binding.bindingId);
        result.errors.push({ bindingId: binding.bindingId, message });
        continue;
      }
      const exhausted = await recordLinkedBindingSyncFailure(binding.bindingId, message);
      if (exhausted) {
        await markBindingSyncExhausted(binding.bindingId);
      }
      result.errors.push({ bindingId: binding.bindingId, message });
    }
  }

  return result;
}

export async function submitLinkedBindingProof(params: {
  binding: ServiceBinding;
  measurement?: MeasureResult | null;
  nonce?: string;
  state?: PresenceState | null;
}): Promise<LinkedBindingProofSubmissionResult> {
  const measurement = await getMeasurement(params.measurement);
  if (!measurement) {
    throw new Error("measurement unavailable");
  }

  return executeBindingSync(
    params.binding,
    measurement,
    params.state ?? measurement.state ?? (await loadPresenceState()),
    params.nonce
  );
}

async function getMeasurement(measurement?: MeasureResult | null): Promise<MeasureResult | null> {
  if (measurement) return measurement;
  const result = await measure();
  if (!result.ok) return null;
  return result.value;
}

async function executeBindingSync(
  binding: ServiceBinding,
  measurement: MeasureResult,
  stateHint?: PresenceState | null,
  providedNonce?: string
): Promise<LinkedBindingProofSubmissionResult> {
  const bindingWithSync = binding.sync ? binding : { ...binding, sync: stateHint?.serviceBindings.find((item) => item.bindingId === binding.bindingId)?.sync };

  if (!measurement.pass) {
    return {
      bindingId: bindingWithSync.bindingId,
      status: "skipped",
    };
  }

  if (!bindingWithSync.sync?.verifyUrl || (!providedNonce && !bindingWithSync.sync?.nonceUrl)) {
    return {
      bindingId: bindingWithSync.bindingId,
      status: "skipped",
    };
  }

  const trustValidation = await validateBindingSyncConfiguration({
    serviceId: bindingWithSync.serviceId,
    sync: bindingWithSync.sync,
  });
  if (!trustValidation.ok) {
    throw trustValidation.error;
  }

  const nonce = providedNonce ?? extractNonce(await requestJson(bindingWithSync.sync.nonceUrl!, {
    method: "POST",
    body: JSON.stringify({
      bindingId: bindingWithSync.bindingId,
      serviceId: bindingWithSync.serviceId,
      accountId: bindingWithSync.accountId,
    }),
  }));
  if (!nonce) {
    throw new Error("nonce endpoint returned no nonce");
  }

  const proof = await proveMeasured(measurement, {
    nonce,
    persistLocalState: false,
    bindingHint: {
      bindingId: bindingWithSync.bindingId,
      serviceId: bindingWithSync.serviceId,
      accountId: bindingWithSync.accountId,
      sync: bindingWithSync.sync,
    },
  });
  if (!proof.ok) {
    throw proof.error;
  }

  const verifyResponse = await requestJson(bindingWithSync.sync.verifyUrl, {
    method: "POST",
    headers: { "x-presence-nonce": nonce },
    body: JSON.stringify(proof.value.payload),
  });

  if (verifyResponse && verifyResponse.ok === false && verifyResponse.code === "ERR_BINDING_RECOVERY_REQUIRED") {
    await markBindingMismatchForRecovery(
      bindingWithSync.bindingId,
      verifyResponse.recovery?.reason ?? verifyResponse.message ?? "binding_mismatch"
    );
    return {
      bindingId: bindingWithSync.bindingId,
      status: "recovery_required",
      nonce,
      verifyResponse,
    };
  }

  if (!verifyResponse || verifyResponse.ok !== true) {
    throw new Error("verify endpoint returned no explicit success");
  }

  await savePresenceState(proof.value.state);
  await markBindingVerified(bindingWithSync.bindingId);
  return {
    bindingId: bindingWithSync.bindingId,
    status: "verified",
    nonce,
    verifyResponse,
  };
}

function applyOutcome(
  result: LinkedBindingSyncResult,
  outcome: LinkedBindingProofSubmissionStatus
): void {
  if (outcome === "verified") {
    result.verified += 1;
    return;
  }
  if (outcome === "recovery_required") {
    result.recoveryRequired += 1;
    return;
  }
  result.skipped += 1;
}

function resolveBinding(current: ServiceBinding | undefined, fallback: ServiceBinding): ServiceBinding {
  if (!current) return fallback;
  return {
    ...fallback,
    ...current,
    sync: current.sync ?? fallback.sync,
  };
}

function isRetryableBinding(binding: ServiceBinding, pass: boolean): boolean {
  if (binding.status === "revoked" || binding.status === "unlinked") {
    return false;
  }
  return isSyncableBinding(binding, pass);
}

function isSyncableBinding(binding: ServiceBinding, pass: boolean): boolean {
  if (binding.status === "revoked" || binding.status === "unlinked") {
    return false;
  }

  if (!binding.sync || !pass) {
    return false;
  }

  return !!binding.sync.nonceUrl && !!binding.sync.verifyUrl;
}

function isShadowedLegacyUnsyncableBinding(
  binding: ServiceBinding,
  bindings: ServiceBinding[]
): boolean {
  if (!isBindingActiveForSync(binding) || hasCompleteBindingSyncMetadata(binding)) {
    return false;
  }

  return bindings.some((candidate) => (
    candidate.bindingId !== binding.bindingId
    && isBindingActiveForSync(candidate)
    && hasCompleteBindingSyncMetadata(candidate)
    && sharesBindingShadowScope(candidate, binding)
  ));
}

function isBindingActiveForSync(binding: ServiceBinding): boolean {
  return binding.status !== "revoked" && binding.status !== "unlinked";
}

function hasCompleteBindingSyncMetadata(binding: ServiceBinding): boolean {
  return !!binding.sync?.nonceUrl && !!binding.sync?.verifyUrl;
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

const REQUEST_TIMEOUT_MS = 10_000;

async function requestJson(
  url: string,
  init: {
    method: "POST" | "GET";
    headers?: Record<string, string>;
    body?: string;
  }
): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: init.method,
      headers: {
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
      body: init.body,
      signal: controller.signal,
    });
    const raw = await response.text();
    const parsed = raw ? safeJsonParse(raw) : undefined;

    if (!response.ok) {
      if (parsed?.code === "ERR_BINDING_RECOVERY_REQUIRED") {
        return parsed;
      }
      const message = parsed?.message ?? parsed?.detail ?? `HTTP ${response.status}`;
      throw new Error(message);
    }

    return parsed;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractNonce(payload: any): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const directNonce = readNonceString(payload.nonce);
  if (directNonce) return directNonce;
  if (!payload.proofRequest || typeof payload.proofRequest !== "object" || Array.isArray(payload.proofRequest)) {
    return null;
  }
  return readNonceString(payload.proofRequest.nonce);
}

function readNonceString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.trim() !== value) return null;
  return value;
}

function safeJsonParse(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return { message: raw };
  }
}

function isTrustFailure(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ERR_SERVICE_TRUST_INVALID";
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return String(error);
}

function emptyResult(): LinkedBindingSyncResult {
  return {
    attempted: 0,
    verified: 0,
    recoveryRequired: 0,
    skipped: 0,
    errors: [],
  };
}
