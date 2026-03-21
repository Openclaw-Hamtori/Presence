// INTENTIONAL_FORK: test app records detailed linked-sync diagnostics and stricter debug guardrails.

import {
  getShadowedLegacyUnsyncableBindingIds,
  hasActiveServiceBindings,
  isShadowedLegacyUnsyncableBinding,
  loadPresenceState,
  savePresenceState,
} from "../state/presenceState";
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
  diagnostics: string[];
}

export async function syncLinkedBindings(params: {
  measurement?: MeasureResult | null;
} = {}): Promise<LinkedBindingSyncResult> {
  const measured = await getMeasurement(params.measurement);
  const state = measured?.state ?? (await loadPresenceState());
  const { currentBindings, diagnostics: selectionDiagnostics } = measured && state
    ? selectCurrentBindings(state.serviceBindings, measured.pass)
    : { currentBindings: [], diagnostics: [] };

  const result = await flushQueuedLinkedBindingSyncs({
    skipBindingIds: currentBindings.map((binding) => binding.bindingId),
  });
  if (selectionDiagnostics.length > 0) {
    result.diagnostics = [...selectionDiagnostics, ...result.diagnostics];
  }

  if (!measured || !state) {
    return result;
  }

  result.diagnostics.push(
    `measurement:${measured.pass ? "pass" : "fail"} capturedAt=${measured.capturedAt} stateValidUntil=${measured.state?.stateValidUntil ?? "-"}`
  );

  if (measured.pass && hasActiveServiceBindings(state.serviceBindings) && currentBindings.length === 0 && result.attempted === 0) {
    result.diagnostics.push("sync_selection_failure:pass_with_active_bindings_attempted=0");
    result.errors.push({
      bindingId: "active-bindings",
      message: "PASS measured with active bindings but no binding sync attempt was made",
    });
    return result;
  }

  for (const binding of currentBindings) {
    result.attempted += 1;
    try {
      result.diagnostics.push(`attempt:${binding.bindingId}:start`);
      const outcome = await executeBindingSync(binding, measured, state, result.diagnostics);
      result.diagnostics.push(`attempt:${binding.bindingId}:${outcome.status}`);
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
      result.diagnostics.push(`attempt:${binding.bindingId}:queued`);
      const outcome = await executeBindingSync(binding, job.measurement, state, result.diagnostics);
      result.diagnostics.push(`attempt:${binding.bindingId}:${outcome.status}`);
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
  diagnostics?: string[];
}): Promise<LinkedBindingProofSubmissionResult> {
  const measurement = await getMeasurement(params.measurement);
  if (!measurement) {
    throw new Error("measurement unavailable");
  }

  return executeBindingSync(
    params.binding,
    measurement,
    params.state ?? measurement.state ?? (await loadPresenceState()),
    params.diagnostics,
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
  diagnostics?: string[],
  providedNonce?: string
): Promise<LinkedBindingProofSubmissionResult> {
  const bindingWithSync = binding.sync ? binding : { ...binding, sync: stateHint?.serviceBindings.find((item) => item.bindingId === binding.bindingId)?.sync };
  pushBindingDiagnostic(
    diagnostics,
    bindingWithSync.bindingId,
    "binding_selected",
    `service=${bindingWithSync.serviceId} account=${bindingWithSync.accountId ?? "-"}`
  );

  if (!measurement.pass) {
    pushBindingDiagnostic(diagnostics, bindingWithSync.bindingId, "skipped", "pass=false");
    return {
      bindingId: bindingWithSync.bindingId,
      status: "skipped",
    };
  }

  if (!bindingWithSync.sync?.verifyUrl || (!providedNonce && !bindingWithSync.sync?.nonceUrl)) {
    const error = new Error(`sync_endpoints_missing nonce=${!!(providedNonce || bindingWithSync.sync?.nonceUrl)} verify=${!!bindingWithSync.sync?.verifyUrl}`);
    pushBindingDiagnostic(diagnostics, bindingWithSync.bindingId, "trust_error", error.message);
    throw error;
  }

  const trustValidation = await validateBindingSyncConfiguration({
    serviceId: bindingWithSync.serviceId,
    sync: bindingWithSync.sync,
  });
  if (!trustValidation.ok) {
    pushBindingDiagnostic(
      diagnostics,
      bindingWithSync.bindingId,
      "trust_error",
      toErrorMessage(trustValidation.error)
    );
    throw trustValidation.error;
  }
  pushBindingDiagnostic(diagnostics, bindingWithSync.bindingId, "trust_validation_passed");

  let resolvedNonce = providedNonce ?? "";
  try {
    if (!resolvedNonce) {
      pushBindingDiagnostic(diagnostics, bindingWithSync.bindingId, "nonce_request", bindingWithSync.sync.nonceUrl);
      const nonceResponse = await requestJson(bindingWithSync.sync.nonceUrl!, {
        method: "POST",
        body: JSON.stringify({
          bindingId: bindingWithSync.bindingId,
          serviceId: bindingWithSync.serviceId,
          accountId: bindingWithSync.accountId,
        }),
      });
      resolvedNonce = extractNonce(nonceResponse) ?? "";
      if (!resolvedNonce) {
        throw new Error("nonce endpoint returned no nonce");
      }
    } else {
      pushBindingDiagnostic(diagnostics, bindingWithSync.bindingId, "nonce_supplied");
    }
  } catch (error) {
    pushBindingDiagnostic(diagnostics, bindingWithSync.bindingId, "nonce_error", toErrorMessage(error));
    throw error;
  }
  pushBindingDiagnostic(diagnostics, bindingWithSync.bindingId, "nonce_received");

  const proof = await proveMeasured(measurement, {
    nonce: resolvedNonce,
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

  let verifyResponse: any;
  try {
    pushBindingDiagnostic(diagnostics, bindingWithSync.bindingId, "verify_call", bindingWithSync.sync.verifyUrl);
    verifyResponse = await requestJson(bindingWithSync.sync.verifyUrl, {
      method: "POST",
      headers: { "x-presence-nonce": resolvedNonce },
      body: JSON.stringify(proof.value.payload),
    });
  } catch (error) {
    pushBindingDiagnostic(diagnostics, bindingWithSync.bindingId, "verify_error", toErrorMessage(error));
    throw error;
  }

  if (verifyResponse && verifyResponse.ok === false && verifyResponse.code === "ERR_BINDING_RECOVERY_REQUIRED") {
    await markBindingMismatchForRecovery(
      bindingWithSync.bindingId,
      verifyResponse.recovery?.reason ?? verifyResponse.message ?? "binding_mismatch"
    );
    pushBindingDiagnostic(diagnostics, bindingWithSync.bindingId, "verify_recovery_required");
    return {
      bindingId: bindingWithSync.bindingId,
      status: "recovery_required",
      nonce: resolvedNonce,
      verifyResponse,
    };
  }

  if (!verifyResponse || verifyResponse.ok !== true) {
    const error = new Error("verify endpoint returned no explicit success");
    pushBindingDiagnostic(diagnostics, bindingWithSync.bindingId, "verify_error", error.message);
    throw error;
  }

  await savePresenceState(proof.value.state);
  await markBindingVerified(bindingWithSync.bindingId);
  pushBindingDiagnostic(diagnostics, bindingWithSync.bindingId, "verify_ok");
  return {
    bindingId: bindingWithSync.bindingId,
    status: "verified",
    nonce: resolvedNonce,
    verifyResponse,
  };
}

function pushBindingDiagnostic(
  diagnostics: string[] | undefined,
  bindingId: string,
  stage: string,
  detail?: string
): void {
  diagnostics?.push(`binding:${bindingId}:${stage}${detail ? ` ${detail}` : ""}`);
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
  return inspectBindingSelection(binding, pass).accepted;
}

function selectCurrentBindings(bindings: ServiceBinding[], pass: boolean): {
  currentBindings: ServiceBinding[];
  diagnostics: string[];
} {
  const currentBindings: ServiceBinding[] = [];
  const diagnostics: string[] = [];
  const shadowedBindingIds = getShadowedLegacyUnsyncableBindingIds(bindings);

  for (const binding of bindings) {
    if (shadowedBindingIds.has(binding.bindingId)) {
      continue;
    }
    const selection = inspectBindingSelection(binding, pass);
    pushBindingDiagnostic(
      diagnostics,
      binding.bindingId,
      "selection",
      [
        `result=${selection.accepted ? "accepted" : "rejected"}`,
        `markers=${selection.markers.join(",")}`,
        `status=${binding.status}`,
        `measurement.pass=${pass}`,
        `sync=${binding.sync ? "present" : "missing"}`,
      ].join(" ")
    );
    if (selection.accepted) {
      currentBindings.push(binding);
    }
  }

  return { currentBindings, diagnostics };
}

function inspectBindingSelection(binding: ServiceBinding, pass: boolean): {
  accepted: boolean;
  markers: string[];
} {
  const markers: string[] = [];

  if (binding.status === "revoked" || binding.status === "unlinked") {
    markers.push("inactive_status_not_eligible");
  }

  if (!binding.sync) {
    markers.push("missing_sync_metadata");
  } else {
    if (!binding.sync.nonceUrl) {
      markers.push("missing_nonceUrl");
    }
    if (!binding.sync.verifyUrl) {
      markers.push("missing_verifyUrl");
    }
  }

  if (!pass) {
    markers.push("pass_gated");
  }

  if (markers.length === 0) {
    return {
      accepted: true,
      markers: ["accepted"],
    };
  }

  return {
    accepted: false,
    markers,
  };
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
      throw new Error(`${url} :: ${message}`);
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
    diagnostics: [],
  };
}
