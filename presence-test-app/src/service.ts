/**
 * presence-mobile — Presence Service
 */

import { readBiometricWindow, requestHealthKitPermissions, isHealthKitAvailable } from "./health/healthkit";
import { evaluatePass } from "./health/pass";
import { ensureDeviceKey, deriveIss, signAttestation } from "./crypto/index";
import { performAppAttest } from "./attestation/appAttest";
import {
  loadPresenceState,
  savePresenceState,
  createPresenceState,
  updatePresenceSnapshot,
  recordFailedMeasurement,
  attachLinkSession,
  addOrUpdateServiceBinding,
  markBindingForRecovery,
  unlinkServiceBinding,
  computeStateStatus,
} from "./state/presenceState";
import type {
  PresenceAttestation,
  PresenceTransportPayload,
  PresenceState,
  Result,
  LinkSession,
  ServiceBinding,
  LinkFlow,
  LinkCompletionMethod,
  PresenceSignal,
  PresenceBindingSync,
} from "./types/index";
import { ok, err } from "./types/index";

export interface ProveOptions {
  nonce: string;
  forceRefresh?: boolean;
  flow?: LinkFlow;
  linkSession?: {
    id: string;
    serviceId: string;
    accountId?: string;
    expiresAt?: number;
    recoveryCode?: string;
    completion?: {
      method: LinkCompletionMethod;
      returnUrl?: string;
      fallbackCode?: string;
      sync?: PresenceBindingSync;
    };
  };
  bindingHint?: {
    bindingId: string;
    serviceId: string;
    accountId?: string;
    sync?: PresenceBindingSync;
  };
}

export interface MeasureOptions {
  forceRefresh?: boolean;
}

export interface MeasureResult {
  state: PresenceState | null;
  isNewState: boolean;
  pass: boolean;
  signals: PresenceSignal[];
  reason: string;
  capturedAt: number;
  iss: string;
  publicKeyBase64: string;
}

export interface ProveResult {
  payload: PresenceTransportPayload;
  state: PresenceState;
  isNewState: boolean;
}

export async function measure(options: MeasureOptions = {}): Promise<Result<MeasureResult>> {
  const { forceRefresh = false } = options;

  if (isHealthKitAvailable()) {
    const permissionResult = await requestHealthKitPermissions();
    if (!permissionResult.ok) {
      return permissionResult;
    }
  }

  const keyResult = await ensureDeviceKey();
  if (!keyResult.ok) return keyResult;
  const publicKeyBase64 = keyResult.value;
  const iss = deriveIss(publicKeyBase64);

  const bioResult = await readBiometricWindow();
  if (!bioResult.ok) return bioResult;
  const biometricWindow = bioResult.value;

  const passResult = evaluatePass(biometricWindow);
  const capturedAt = Math.floor(Date.now() / 1000);
  let state = await loadPresenceState();
  let isNewState = false;

  if (!passResult.pass) {
    if (state && state.iss === iss) {
      state = recordFailedMeasurement(state, {
        signals: passResult.signals,
        reason: passResult.reason,
        capturedAt,
      });
      await savePresenceState(state);
    }

    return ok({
      state,
      isNewState: false,
      pass: false,
      signals: passResult.signals,
      reason: passResult.reason,
      capturedAt,
      iss,
      publicKeyBase64,
    });
  }

  const existingState = state && state.iss === iss ? state : null;
  const currentStatus = existingState ? computeStateStatus(existingState) : null;
  const shouldPreserveValidity = !!existingState && existingState.pass && !forceRefresh && currentStatus !== "expired";

  if (existingState && shouldPreserveValidity) {
    state = updatePresenceSnapshot(existingState, {
      pass: true,
      signals: passResult.signals,
      capturedAt,
      reason: passResult.reason,
      source: "measurement",
      stateCreatedAt: existingState.stateCreatedAt,
      stateValidUntil: existingState.stateValidUntil,
    });
    isNewState = false;
  } else {
    state = createPresenceState({
      iss,
      pass: true,
      signals: passResult.signals,
      capturedAt,
      reason: passResult.reason,
    });
    isNewState = true;
  }

  await savePresenceState(state);

  return ok({
    state,
    isNewState,
    pass: true,
    signals: passResult.signals,
    reason: passResult.reason,
    capturedAt,
    iss,
    publicKeyBase64,
  });
}

export async function proveMeasured(measurement: MeasureResult, options: ProveOptions): Promise<Result<ProveResult>> {
  const { nonce, linkSession: linkSessionHint, bindingHint } = options;
  const flow = options.flow ?? (linkSessionHint ? "initial_link" : bindingHint ? "reauth" : undefined);

  if (!nonce) return err("ERR_NONCE_MISSING", "nonce is required");
  if (!measurement.pass || !measurement.state) {
    return err("ERR_PASS_FALSE", measurement.reason);
  }

  let state: PresenceState = measurement.state;
  const persistedState = await loadPresenceState();
  if (persistedState && persistedState.iss === measurement.iss) {
    state = persistedState;
  }

  const isNewState = measurement.isNewState;

  if (linkSessionHint) {
    state = attachLinkSession(state, {
      id: linkSessionHint.id,
      serviceId: linkSessionHint.serviceId,
      accountId: linkSessionHint.accountId,
      status: flow === "recovery" || flow === "relink" ? "recovery_pending" : "pending",
      createdAt: Math.floor(Date.now() / 1000),
      expiresAt: linkSessionHint.expiresAt ?? Math.floor(Date.now() / 1000) + 300,
      lastNonce: nonce,
      flow,
      recoveryCode: linkSessionHint.recoveryCode,
      completion: linkSessionHint.completion,
    });
  }

  if (bindingHint) {
    state = addOrUpdateServiceBinding(state, {
      bindingId: bindingHint.bindingId,
      serviceId: bindingHint.serviceId,
      accountId: bindingHint.accountId,
      linkedDeviceIss: measurement.iss,
      linkedAt: state.linkedDevice.linkedAt,
      lastVerifiedAt: Math.floor(Date.now() / 1000),
      status: flow === "recovery" || flow === "relink" ? "recovery_pending" : "linked",
      sync: bindingHint.sync ?? linkSessionHint?.completion?.sync,
    }, {
      allowLinkedRecoveryExit: flow === "reauth",
    });
  } else if (linkSessionHint?.accountId) {
    state = addOrUpdateServiceBinding(state, {
      bindingId: `local_${linkSessionHint.serviceId}_${linkSessionHint.accountId}`,
      serviceId: linkSessionHint.serviceId,
      accountId: linkSessionHint.accountId,
      linkedDeviceIss: measurement.iss,
      linkedAt: state.linkedDevice.linkedAt,
      lastVerifiedAt: Math.floor(Date.now() / 1000),
      status: flow === "recovery" || flow === "relink" ? "recovery_pending" : "linked",
      sync: linkSessionHint.completion?.sync,
    });
  }

  if (bindingHint && (flow === "recovery" || flow === "relink")) {
    state = markBindingForRecovery(state, {
      bindingId: bindingHint.bindingId,
      recoveryReason: flow,
      status: "recovery_pending",
    });
  }

  const attestResult = await performAppAttest(nonce);
  if (!attestResult.ok) return attestResult;
  const { attestationBase64url, attestationDigest } = attestResult.value;

  const now = Math.floor(Date.now() / 1000);
  const payloadWithoutSig: Omit<PresenceAttestation, "signature"> = {
    pol_version: "1.0",
    iss: measurement.iss,
    iat: now,
    state_created_at: state.stateCreatedAt,
    state_valid_until: state.stateValidUntil,
    human: true,
    pass: true,
    signals: measurement.signals,
    nonce,
    device_attestation_digest: attestationDigest,
  };

  const signResult = await signAttestation(payloadWithoutSig);
  if (!signResult.ok) return signResult;

  const attestation: PresenceAttestation = { ...payloadWithoutSig, signature: signResult.value };

  state = updatePresenceSnapshot(state, {
    pass: true,
    signals: measurement.signals,
    attestedAt: now,
    capturedAt: measurement.capturedAt,
    reason: measurement.reason,
    source: "proof",
    stateCreatedAt: state.stateCreatedAt,
    stateValidUntil: state.stateValidUntil,
  });
  await savePresenceState(state);

  return ok({
    payload: {
      attestation,
      device_attestation: attestationBase64url,
      signing_public_key: measurement.publicKeyBase64,
      platform: "ios",
      link_context: {
        service_id: linkSessionHint?.serviceId ?? bindingHint?.serviceId,
        link_session_id: linkSessionHint?.id,
        binding_id: bindingHint?.bindingId,
        flow,
        recovery_code: linkSessionHint?.recoveryCode,
        completion: linkSessionHint?.completion
          ? {
              method: linkSessionHint.completion.method,
              return_url: linkSessionHint.completion.returnUrl,
              code: linkSessionHint.completion.fallbackCode,
            }
          : undefined,
      },
    },
    state,
    isNewState,
  });
}

export async function prove(options: ProveOptions): Promise<Result<ProveResult>> {
  const measured = await measure({ forceRefresh: options.forceRefresh });
  if (!measured.ok) return measured;
  if (!measured.value.pass) {
    return err("ERR_PASS_FALSE", measured.value.reason);
  }

  return proveMeasured(measured.value, options);
}

export async function markBindingMismatchForRecovery(bindingId: string, recoveryReason = "binding_mismatch"): Promise<PresenceState | null> {
  const state = await loadPresenceState();
  if (!state) return null;
  const next = markBindingForRecovery(state, { bindingId, recoveryReason, status: "recovery_pending" });
  await savePresenceState(next);
  return next;
}

export async function locallyUnlinkBinding(bindingId: string): Promise<PresenceState | null> {
  const state = await loadPresenceState();
  if (!state) return null;
  const next = unlinkServiceBinding(state, bindingId);
  await savePresenceState(next);
  return next;
}
