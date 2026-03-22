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
   * Sync URLs must already be absolute at this boundary; backend-relative
   * paths are rejected until the backend rewrites them for public/mobile use.
   */
  serviceDomain?: string;
  nonceUrl?: string;
  verifyUrl?: string;
  statusUrl?: string;
  pendingRequestsUrl?: string;
}

/**
 * Internal local state status used by scheduling/debug logic.
 * Product UI should present PASS / FAIL / recovery instead of these raw values.
 */
export type PresenceStateStatus =
  | "uninitialized"
  | "ready"
  | "expired"
  | "check_due"
  | "recovery_pending"
  | "not_ready";
/**
 * Wire-level linkage flow names.
 * `reauth` remains the backend/mobile transport label for "service requested
 * PASS from an already-linked account"; product copy should describe that as
 * proof on demand, not as a separate renewal-era product mode.
 */
export type LinkFlow = "initial_link" | "reauth" | "relink" | "recovery";
export type LinkCompletionMethod = "qr" | "deeplink" | "manual_code";
/**
 * Canonical local/mobile session status names.
 * Backend/sdk uses `consumed` after completion; older mobile state may still
 * contain the legacy `linked` alias, which should be normalized to `consumed`.
 */
export type LinkSessionStatus = "pending" | "consumed" | "expired" | "revoked" | "recovery_pending";
export type PendingProofRequestStatus = "pending" | "verified" | "recovery_required" | "expired" | "cancelled";
/**
 * Canonical local/mobile snapshot source names.
 * Backend/sdk authoritative snapshots use `local_measurement` and
 * `verified_proof`; app-local state stores those as `measurement` and `proof`.
 */
export type PresenceSnapshotSource = "measurement" | "proof";

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
  status: LinkSessionStatus;
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
  /**
   * Local/mobile name for the linked device identifier.
   * Backend/sdk payloads serialize this same value as `deviceIss`.
   */
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

export interface PendingProofRequest {
  requestId: string;
  serviceId: string;
  accountId?: string;
  bindingId: string;
  deviceIss?: string;
  nonce: string;
  requestedAt: number;
  expiresAt: number;
  status: PendingProofRequestStatus;
  respondUrl: string;
  statusUrl?: string;
  unlinkUrl?: string;
  serviceDomain?: string;
}

export interface PresenceSnapshot {
  capturedAt: number;
  attestedAt?: number;
  pass: boolean;
  signals: PresenceSignal[];
  stateCreatedAt: number;
  stateValidUntil: number;
  reason?: string;
  source?: PresenceSnapshotSource;
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
  pendingProofRequests?: PendingProofRequest[];
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

export function normalizeLinkSessionStatus(status?: LinkSessionStatus | "linked"): LinkSessionStatus | undefined {
  if (!status) return undefined;
  return status === "linked" ? "consumed" : status;
}

export function normalizePresenceSnapshotSource(
  source?: PresenceSnapshotSource | "local_measurement" | "verified_proof"
): PresenceSnapshotSource | undefined {
  if (!source) return undefined;
  if (source === "local_measurement") return "measurement";
  if (source === "verified_proof") return "proof";
  return source;
}
