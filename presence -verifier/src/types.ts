/**
 * Presence Verifier - Type Definitions
 * Based on Presence Signal Spec v0.4 and Verifier Spec v0.4
 */

// ─── Signal Types ────────────────────────────────────────────────────────────

export type PresenceSignal = "heart_rate" | "steps";

/** Canonical signal sets (Signal Spec v0.4 Section 3) */
export type PresenceSignals =
  | ["heart_rate"]
  | ["heart_rate", "steps"];

// ─── Presence Attestation (Signal Spec v0.4 Section 4) ───────────────────────────

export interface PresenceAttestation {
  pol_version: string;
  iss: string;                       // "presence:device:<32 hex chars>"
  iat: number;                       // unix seconds
  state_created_at: number;          // unix seconds
  state_valid_until: number;         // unix seconds
  human: boolean;
  pass: boolean;
  signals: PresenceSignals;
  nonce: string;                     // base64url
  device_attestation_digest: string; // lowercase hex, 64 chars
  signature: string;                 // base64url
}

// ─── Verifier Input ──────────────────────────────────────────────────────────

export type Platform = "ios" | "android";

export interface VerifierInput {
  /** Input A: Presence Attestation JSON (parsed) */
  attestation: PresenceAttestation;

  /** Input B: Full Device Attestation Object (raw bytes)
   *  iOS: Apple attestation_object (CBOR)
   *  Android: Play Integrity token (UTF-8 bytes)
   */
  deviceAttestationRawBytes: Uint8Array;

  /** Android only: DER-encoded SPKI public key, for TOFU registration */
  signingPublicKey?: Uint8Array;

  /** Platform hint — if omitted, inferred from attestation structure */
  platform: Platform;

  /** Optional service policy */
  policy?: ServicePolicy;
}

// ─── Service Policy (optional extension; not normative in Verifier Spec v0.4) ─

export interface ServicePolicy {
  /** Max allowed age of attestation in seconds (iat-based) */
  max_attestation_age?: number;

  /** Max allowed age of readiness state in seconds (state_created_at-based) */
  max_state_age?: number;

  /** Expected Android package name (required for Android path) */
  android_package_name?: string;

  /**
   * Optional pinned Google root / trust anchor for Play Integrity x5c chain validation.
   * If omitted, the verifier can still validate the JWS signature against the leaf cert
   * bundled in x5c, but cannot establish trust to a pinned Google root locally.
   */
  google_play_root_ca?: Uint8Array | string;

  /**
   * Escape hatch for local harnessing only.
   * If true, allows Play Integrity payload checks to proceed when x5c is absent.
   * Do not enable this in production.
   */
  allow_unverified_play_integrity?: boolean;
}

// ─── Verifier Output (Verifier Spec v0.4 Section 6) ─────────────────────────

export interface VerifierSuccess {
  verified: true;
  pol_version: string;
  iss: string;
  iat: number;
  state_created_at: number;
  state_valid_until: number;
  human: true;
  pass: true;
  signals: PresenceSignals;
  nonce: string;
}

export interface VerifierFailure {
  verified: false;
  error: PresenceErrorCode;
  detail?: string;
}

export type VerifierResult = VerifierSuccess | VerifierFailure;

// ─── Error Codes (Verifier Spec v0.4 Section 7) ─────────────────────────────

export type PresenceErrorCode =
  | "ERR_INVALID_FORMAT"
  | "ERR_UNSUPPORTED_VERSION"
  | "ERR_NONCE_INVALID"
  | "ERR_NONCE_EXPIRED"
  | "ERR_NONCE_REUSED"
  | "ERR_TIME_INVALID"
  | "ERR_STATE_EXPIRED"
  | "ERR_INVALID_ATTESTATION"
  | "ERR_ATTESTATION_DIGEST_MISMATCH"
  | "ERR_INVALID_SIGNATURE"
  | "ERR_HUMAN_FALSE"
  | "ERR_PASS_FALSE";

export class PresenceVerifierError extends Error {
  constructor(
    public readonly code: PresenceErrorCode,
    public readonly detail?: string
  ) {
    super(`${code}${detail ? ": " + detail : ""}`);
    this.name = "PresenceVerifierError";
  }
}

// ─── Nonce Store Interface ───────────────────────────────────────────────────

/** Service must provide a nonce store implementation */
export interface NonceStore {
  /**
   * Returns true if nonce was issued and not yet expired.
   * @param now - Unix seconds override for deterministic testing. Defaults to Date.now().
   */
  isValid(nonce: string, now?: number): Promise<boolean>;
  /** Returns true if nonce has already been used */
  isUsed(nonce: string): Promise<boolean>;
  /** Mark nonce as used */
  markUsed(nonce: string): Promise<void>;
}

// ─── TOFU Store Interface (Android only) ────────────────────────────────────

/**
 * TOFU store for Android signing keys.
 * SHOULD persist across service restarts.
 * SHOULD retain first accepted public key for a given iss
 * until explicit revocation or service-defined expiration.
 */
export interface TofuStore {
  /** Returns stored public key bytes for iss, or null if not registered */
  get(iss: string): Promise<Uint8Array | null>;
  /** Store first public key for iss */
  set(iss: string, publicKey: Uint8Array): Promise<void>;
}

// ─── Device Attestation Results ──────────────────────────────────────────────

export interface DeviceAttestationResult {
  /** Extracted device public key (raw bytes) */
  devicePublicKey: Uint8Array;
  /** Platform-specific verified claims */
  claims: IosClaims | AndroidClaims;
}

export interface IosClaims {
  platform: "ios";
  appId: string;     // teamId.bundleId
  counter: number;
}

export interface AndroidClaims {
  platform: "android";
  packageName: string;
  appRecognitionVerdict: string;
  deviceRecognitionVerdict: string[];
  requestNonce: string;
}
