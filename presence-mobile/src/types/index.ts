/**
 * presence-mobile — Core Types
 * Aligned with Presence Signal Spec v0.4
 */

export interface PresenceAttestation {
  pol_version: "1.0";
  iss: string;
  iat: number;
  state_created_at: number;
  state_valid_until: number;
  human: boolean;
  pass: boolean;
  signals: PresenceSignal[];
  nonce: string;
  device_attestation_digest: string;
  signature: string;
}

export type PresenceSignal = "heart_rate" | "steps";

export interface BpmSample {
  bpm: number;
  timestamp: number;
  /**
   * Raw HealthKit sample span in seconds.
   * PASS evaluation does not use duration coverage for qualification anymore;
   * this remains optional source metadata only.
   */
  durationSeconds?: number;
}

export interface StepSample {
  count: number;
  startTime: number;
  endTime: number;
}

export interface BiometricWindow {
  bpmSamples: BpmSample[];
  /**
   * Local-calendar-day step totals keyed by YYYY-MM-DD in the device user's timezone.
   */
  stepsByDay: Record<string, number>;
  windowStart: number;
  windowEnd: number;
}

export interface PresenceBindingSync {
  /**
   * Domain that owns the Presence well-known metadata for these service URLs.
   * When sync URLs are present, the app validates them against
   * `https://{serviceDomain}/.well-known/presence.json` before use.
   */
  serviceDomain?: string;
  nonceUrl?: string;
  verifyUrl?: string;
  statusUrl?: string;
}

/**
 * Internal local state status.
 * `expired` and `needs_renewal` remain available for scheduling/debug logic,
 * but product UI should generally collapse them into PASS / FAIL.
 */
export type PresenceStateStatus =
  | "uninitialized"
  | "ready"
  | "expired"
  | "needs_renewal"
  | "recovery_pending"
  | "not_ready";
export type LinkFlow = "initial_link" | "reauth" | "relink" | "recovery";
export type LinkCompletionMethod = "qr" | "deeplink" | "manual_code";

export interface LinkedDevice {
  iss: string;
  platform: "ios" | "android";
  linkedAt: number;
  revokedAt?: number;
  recoveryStartedAt?: number;
}

export interface LinkSession {
  id: string;
  serviceId: string;
  accountId?: string;
  status: "pending" | "linked" | "expired" | "revoked" | "recovery_pending";
  createdAt: number;
  expiresAt: number;
  lastNonce?: string;
  flow?: LinkFlow;
  recoveryCode?: string;
  completion?: {
    method: LinkCompletionMethod;
    returnUrl?: string;
    fallbackCode?: string;
    sync?: PresenceBindingSync;
  };
}

export interface ServiceBinding {
  bindingId: string;
  serviceId: string;
  accountId?: string;
  linkedDeviceIss: string;
  linkedAt: number;
  lastVerifiedAt?: number;
  status: "linked" | "revoked" | "unlinked" | "reauth_required" | "recovery_pending";
  revokedAt?: number;
  recoveryStartedAt?: number;
  recoveryReason?: string;
  lastMeasuredAt?: number;
  lastFailedAt?: number;
  lastFailureReason?: string;
  sync?: PresenceBindingSync;
}

export interface PresenceSnapshot {
  capturedAt: number;
  attestedAt?: number;
  pass: boolean;
  signals: PresenceSignal[];
  stateCreatedAt: number;
  stateValidUntil: number;
  reason?: string;
  source?: "measurement" | "proof";
}

export interface PresenceState {
  status: PresenceStateStatus;
  iss: string;
  stateCreatedAt: number;
  stateValidUntil: number;
  pass: boolean;
  lastSignals: PresenceSignal[];
  lastMeasuredAt?: number;
  lastPassedAt?: number;
  lastFailedAt?: number;
  nextMeasurementAt?: number;
  lastMeasurementReason?: string;
  platform: "ios";
  linkedDevice: LinkedDevice;
  activeLinkSession?: LinkSession;
  serviceBindings: ServiceBinding[];
  lastSnapshot: PresenceSnapshot;
}

export interface PassResult {
  pass: boolean;
  signals: PresenceSignal[];
  reason: string;
}

export interface PresenceTransportPayload {
  attestation: PresenceAttestation;
  device_attestation: string;
  signing_public_key: string;
  platform: "ios" | "android";
  link_context?: {
    service_id?: string;
    link_session_id?: string;
    binding_id?: string;
    flow?: LinkFlow;
    recovery_code?: string;
    completion?: {
      method?: LinkCompletionMethod;
      return_url?: string;
      code?: string;
    };
  };
}

export type PresenceMobileErrorCode =
  | "ERR_HEALTHKIT_UNAVAILABLE"
  | "ERR_HEALTHKIT_PERMISSION_DENIED"
  | "ERR_NO_BPM_DATA"
  | "ERR_BPM_INSUFFICIENT"
  | "ERR_STEPS_UNAVAILABLE"
  | "ERR_SECURE_ENCLAVE_UNAVAILABLE"
  | "ERR_KEY_GENERATION_FAILED"
  | "ERR_APP_ATTEST_FAILED"
  | "ERR_SIGNING_FAILED"
  | "ERR_STATE_EXPIRED"
  | "ERR_NONCE_MISSING"
  | "ERR_PASS_FALSE"
  | "ERR_SERVICE_TRUST_INVALID";

export class PresenceMobileError extends Error {
  constructor(
    public readonly code: PresenceMobileErrorCode,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "PresenceMobileError";
  }
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: PresenceMobileError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err(code: PresenceMobileErrorCode, message: string, cause?: unknown): Result<never> {
  return { ok: false, error: new PresenceMobileError(code, message, cause) };
}
