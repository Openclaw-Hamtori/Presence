import { loadPresenceState } from "../state/presenceState";
import { markBindingMismatchForRecovery, markBindingVerified, measure, proveMeasured } from "../service";
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

export interface LinkedBindingSyncResult {
  attempted: number;
  verified: number;
  skipped: number;
  errors: LinkedBindingSyncError[];
}

export async function syncLinkedBindings(params: {
  measurement?: MeasureResult | null;
} = {}): Promise<LinkedBindingSyncResult> {
  const measured = await getMeasurement(params.measurement);
  const state = measured?.state ?? (await loadPresenceState());
  const currentBindings = measured && state
    ? state.serviceBindings.filter((binding) => isSyncableBinding(binding, measured.pass))
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
      applyOutcome(result, outcome);
      await removeLinkedBindingSyncJob(binding.bindingId);
    } catch (error) {
      const message = toErrorMessage(error);
      await upsertLinkedBindingSyncJob({ binding, measurement: measured });
      await recordLinkedBindingSyncFailure(binding.bindingId, message);
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
  const result = emptyResult();

  for (const job of jobs) {
    if (skipBindingIds.has(job.binding.bindingId)) {
      continue;
    }

    result.attempted += 1;
    const binding = resolveBinding(bindings.get(job.binding.bindingId), job.binding);
    if (!hasRemainingLinkedBindingSyncAttempts(job) || !isRetryableBinding(binding, job.measurement.pass)) {
      await removeLinkedBindingSyncJob(job.binding.bindingId);
      result.skipped += 1;
      continue;
    }

    try {
      const outcome = await executeBindingSync(binding, job.measurement, state);
      applyOutcome(result, outcome);
      await removeLinkedBindingSyncJob(binding.bindingId);
    } catch (error) {
      const message = toErrorMessage(error);
      await recordLinkedBindingSyncFailure(binding.bindingId, message);
      result.errors.push({ bindingId: binding.bindingId, message });
    }
  }

  return result;
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
  stateHint?: PresenceState | null
): Promise<"verified" | "skipped"> {
  const bindingWithSync = binding.sync ? binding : { ...binding, sync: stateHint?.serviceBindings.find((item) => item.bindingId === binding.bindingId)?.sync };

  if (!measurement.pass) {
    return "skipped";
  }

  if (!bindingWithSync.sync?.nonceUrl || !bindingWithSync.sync?.verifyUrl) {
    return "skipped";
  }

  const nonceResponse = await requestJson(bindingWithSync.sync.nonceUrl, {
    method: "POST",
    body: JSON.stringify({
      bindingId: bindingWithSync.bindingId,
      serviceId: bindingWithSync.serviceId,
      accountId: bindingWithSync.accountId,
    }),
  });
  const nonce = extractNonce(nonceResponse);
  if (!nonce) {
    throw new Error("nonce endpoint returned no nonce");
  }

  const proof = await proveMeasured(measurement, {
    nonce,
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
    return "verified";
  }

  if (!verifyResponse || verifyResponse.ok !== true) {
    throw new Error("verify endpoint returned no explicit success");
  }

  await markBindingVerified(bindingWithSync.bindingId);
  return "verified";
}

function applyOutcome(
  result: LinkedBindingSyncResult,
  outcome: "verified" | "skipped"
): void {
  if (outcome === "verified") {
    result.verified += 1;
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
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.nonce === "string") return payload.nonce;
  if (typeof payload.value === "string") return payload.value;
  if (payload.nonce && typeof payload.nonce.value === "string") return payload.nonce.value;
  return null;
}

function safeJsonParse(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return { message: raw };
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyResult(): LinkedBindingSyncResult {
  return {
    attempted: 0,
    verified: 0,
    skipped: 0,
    errors: [],
  };
}
