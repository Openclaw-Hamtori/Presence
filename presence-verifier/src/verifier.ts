/**
 * Presence Verifier - Core Verification Logic
 * Implements Verifier Spec v0.4 — 14 Steps (normative order)
 * + 2 optional service policy steps (attestation age, state age)
 *
 * Transport layer is excluded per scope decision.
 * Callers are responsible for:
 *   - Deserializing Input A (Presence Attestation JSON → PresenceAttestation)
 *   - Providing Input B (raw device attestation bytes)
 *   - Providing NonceStore and TofuStore implementations
 */

import type {
  VerifierInput,
  VerifierResult,
  VerifierSuccess,
  NonceStore,
  TofuStore,
} from "./types.js";
import { PresenceVerifierError } from "./types.js";
import { getSigningInput, verifyES256, deriveIss } from "./crypto.js";
import {
  verifyAppleAttestation,
  verifyPlayIntegrityToken,
  resolveTofuPublicKey,
  verifyAttestationDigest,
} from "./attestation.js";

// ─── Supported Versions ───────────────────────────────────────────────────────

const SUPPORTED_VERSIONS = new Set(["1.0"]);

// ─── Time Constants ───────────────────────────────────────────────────────────

const CLOCK_DRIFT_TOLERANCE_SECONDS = 300; // +5 minutes (Signal Spec v0.4)
const STATE_MAX_DURATION_SECONDS = 259200;  // 72 hours (Signal Spec v0.4 Section 2)
const NONCE_MIN_BASE64URL_LENGTH = 22;      // 16 bytes entropy minimum

// ─── Main Entry Point ─────────────────────────────────────────────────────────

export interface VerifierContext {
  nonceStore: NonceStore;
  tofuStore?: TofuStore;       // Required for Android path
  expectedAppId?: string;      // Required for iOS path (teamId.bundleId)
  /**
   * Apple App Attestation Root CA certificate (DER bytes or PEM string).
   * Required for iOS path in production to verify the certificate chain.
   * Obtain from: https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem
   * If omitted, cert chain validation is skipped (development mode only).
   */
  appleRootCA?: Uint8Array | string;
  /** Override current time (unix seconds) — for testing only */
  nowOverride?: number;
}

/**
 * verify() — Core Presence Attestation verification.
 *
 * Implements Verifier Spec v0.4 steps 1–14 in normative order,
 * plus 2 optional service policy checks after step 7.
 * Steps MUST NOT be reordered. Each step throws PresenceVerifierError on failure.
 *
 * Returns VerifierSuccess on full verification pass.
 * Returns VerifierFailure on any step failure (never throws to caller).
 */
export async function verify(
  input: VerifierInput,
  ctx: VerifierContext
): Promise<VerifierResult> {
  try {
    const result = await verifyInternal(input, ctx);
    return result;
  } catch (err) {
    if (err instanceof PresenceVerifierError) {
      return { verified: false, error: err.code, detail: err.detail };
    }
    // Unexpected error — treat as format error, do not leak internals
    return { verified: false, error: "ERR_INVALID_FORMAT", detail: "internal verification error" };
  }
}

// ─── Internal: 14-Step Verification (+ 2 optional policy steps) ──────────────

async function verifyInternal(
  input: VerifierInput,
  ctx: VerifierContext
): Promise<VerifierResult> {
  const { attestation, deviceAttestationRawBytes, signingPublicKey, platform, policy } = input;
  const now = ctx.nowOverride ?? Math.floor(Date.now() / 1000);

  // ── Step 1: Parse & Validate Format ───────────────────────────────────────
  validateFormat(attestation);

  // ── Step 2: Validate pol_version ──────────────────────────────────────────
  if (!SUPPORTED_VERSIONS.has(attestation.pol_version)) {
    throw new PresenceVerifierError(
      "ERR_UNSUPPORTED_VERSION",
      `unsupported version: ${attestation.pol_version}`
    );
  }

  // ── Step 3: Validate nonce format ─────────────────────────────────────────
  validateNonceFormat(attestation.nonce);

  // ── Step 4: Validate nonce freshness ──────────────────────────────────────
  const nonceValid = await ctx.nonceStore.isValid(attestation.nonce, now);
  if (!nonceValid) {
    throw new PresenceVerifierError("ERR_NONCE_EXPIRED", "nonce expired or not issued by service");
  }

  // ── Step 5: Validate nonce uniqueness ─────────────────────────────────────
  const nonceUsed = await ctx.nonceStore.isUsed(attestation.nonce);
  if (nonceUsed) {
    throw new PresenceVerifierError("ERR_NONCE_REUSED", "nonce has already been used");
  }

  // ── Step 6: Validate logical time constraints ─────────────────────────────
  validateLogicalTimeConstraints(attestation, now);

  // ── Step 7: Validate clock drift ──────────────────────────────────────────
  if (attestation.iat > now + CLOCK_DRIFT_TOLERANCE_SECONDS) {
    throw new PresenceVerifierError(
      "ERR_TIME_INVALID",
      `iat ${attestation.iat} exceeds now + 5m (${now + CLOCK_DRIFT_TOLERANCE_SECONDS})`
    );
  }

  // ── Policy ext A: Attestation freshness check (optional, not in spec steps) ─
  if (policy?.max_attestation_age != null) {
    const attestationAge = now - attestation.iat;
    if (attestationAge > policy.max_attestation_age) {
      throw new PresenceVerifierError(
        "ERR_TIME_INVALID",
        `attestation age ${attestationAge}s exceeds max ${policy.max_attestation_age}s`
      );
    }
  }

  // ── Policy ext B: State freshness check (optional, not in spec steps) ────────
  if (policy?.max_state_age != null) {
    const stateAge = now - attestation.state_created_at;
    if (stateAge > policy.max_state_age) {
      throw new PresenceVerifierError(
        "ERR_STATE_EXPIRED",
        `state age ${stateAge}s exceeds max ${policy.max_state_age}s`
      );
    }
  }

  // ── Step 8: Validate full device attestation ──────────────────────────────
  // ── Step 9: Verify device_attestation_digest ──────────────────────────────
  // ── Step 10: Extract device public key ────────────────────────────────────
  //
  // Steps 8–10 are handled together per platform path.
  // digest verification (Step 9) runs first, regardless of platform.
  verifyAttestationDigest(deviceAttestationRawBytes, attestation.device_attestation_digest);

  let devicePublicKeyDer: Uint8Array;

  if (platform === "ios") {
    // iOS: App Attest cert chain verification (Steps 8–10 iOS path)
    //
    // The Presence iOS protocol uses two distinct Secure Enclave keys:
    //   - App Attest key (DCAppAttestService): device genuineness proof
    //   - Secure Enclave signing key (react-native-device-crypto): payload signing
    //
    // Step 8: Verify App Attest cert chain → proves device is genuine Apple hardware
    // Step 9: digest already verified above (verifyAttestationDigest)
    // Step 10: signing key provided explicitly in transport (signing_public_key field)
    //
    // The iss in the attestation is derived from the signing key (not the App Attest key).
    const appId = ctx.expectedAppId;
    if (!appId) {
      throw new PresenceVerifierError("ERR_INVALID_FORMAT", "expectedAppId required for iOS path");
    }
    // Verify App Attest cert chain (device genuineness)
    await verifyAppleAttestation(deviceAttestationRawBytes, appId, ctx.appleRootCA);

    // Step 10: signing key from transport
    if (!signingPublicKey) {
      throw new PresenceVerifierError(
        "ERR_INVALID_FORMAT",
        "signingPublicKey required for iOS path (Secure Enclave signing key, DER-encoded SPKI)"
      );
    }

    // Verify iss is consistent with signing public key (same as Android path)
    const derivedIss = deriveIss(signingPublicKey);
    if (derivedIss !== attestation.iss) {
      throw new PresenceVerifierError(
        "ERR_INVALID_FORMAT",
        `iss mismatch: derived ${derivedIss}, attestation has ${attestation.iss}`
      );
    }

    devicePublicKeyDer = signingPublicKey;

  } else {
    // Android: Play Integrity verdict + TOFU key resolution
    if (!signingPublicKey) {
      throw new PresenceVerifierError(
        "ERR_INVALID_FORMAT",
        "signingPublicKey required for Android path (Android Appendix v0.1 Section 4.3)"
      );
    }
    if (!ctx.tofuStore) {
      throw new PresenceVerifierError("ERR_INVALID_FORMAT", "tofuStore required for Android path");
    }

    // Verify iss is consistent with provided public key
    const derivedIss = deriveIss(signingPublicKey);
    if (derivedIss !== attestation.iss) {
      throw new PresenceVerifierError(
        "ERR_INVALID_FORMAT",
        `iss mismatch: derived ${derivedIss}, attestation has ${attestation.iss}`
      );
    }

    // Play Integrity verdict verification (Step 8 Android path)
    // TOFU registration happens AFTER Play Integrity passes.
    // policy.android_package_name is mandatory here.
    await verifyPlayIntegrityToken(
      deviceAttestationRawBytes,
      attestation.nonce,
      policy ?? {}
    );

    // TOFU key resolution (Step 10 Android path)
    devicePublicKeyDer = await resolveTofuPublicKey(
      attestation.iss,
      signingPublicKey,
      ctx.tofuStore
    );
  }

  // ── Step 11: Verify signature ─────────────────────────────────────────────
  const signingInput = getSigningInput(attestation);
  const signatureValid = verifyES256(signingInput, attestation.signature, devicePublicKeyDer);
  if (!signatureValid) {
    throw new PresenceVerifierError("ERR_INVALID_SIGNATURE", "signature verification failed");
  }

  // ── Step 12: Check human flag ─────────────────────────────────────────────
  if (attestation.human !== true) {
    throw new PresenceVerifierError("ERR_HUMAN_FALSE", "human flag is not true");
  }

  // ── Step 13: Check pass flag ──────────────────────────────────────────────
  if (attestation.pass !== true) {
    throw new PresenceVerifierError("ERR_PASS_FALSE", "pass flag is not true");
  }

  // ── Step 14: Mark nonce as used and return result ─────────────────────────
  await ctx.nonceStore.markUsed(attestation.nonce);

  const success: VerifierSuccess = {
    verified: true,
    pol_version: attestation.pol_version,
    iss: attestation.iss,
    iat: attestation.iat,
    state_created_at: attestation.state_created_at,
    state_valid_until: attestation.state_valid_until,
    human: true,
    pass: true,
    signals: attestation.signals,
    nonce: attestation.nonce,
  };

  return success;
}

// ─── Step 1: Format Validation ────────────────────────────────────────────────

function validateFormat(a: unknown): asserts a is import("./types.js").PresenceAttestation {
  if (typeof a !== "object" || a === null) {
    throw new PresenceVerifierError("ERR_INVALID_FORMAT", "attestation must be a JSON object");
  }

  const obj = a as Record<string, unknown>;

  const requiredFields = [
    "pol_version", "iss", "iat", "state_created_at", "state_valid_until",
    "human", "pass", "signals", "nonce", "device_attestation_digest", "signature"
  ] as const;

  for (const field of requiredFields) {
    if (!(field in obj)) {
      throw new PresenceVerifierError("ERR_INVALID_FORMAT", `missing required field: ${field}`);
    }
  }

  // Type checks
  if (typeof obj.pol_version !== "string") throw new PresenceVerifierError("ERR_INVALID_FORMAT", "pol_version must be string");
  if (typeof obj.iss !== "string") throw new PresenceVerifierError("ERR_INVALID_FORMAT", "iss must be string");
  if (typeof obj.iat !== "number" || !Number.isInteger(obj.iat)) throw new PresenceVerifierError("ERR_INVALID_FORMAT", "iat must be integer");
  if (typeof obj.state_created_at !== "number" || !Number.isInteger(obj.state_created_at)) throw new PresenceVerifierError("ERR_INVALID_FORMAT", "state_created_at must be integer");
  if (typeof obj.state_valid_until !== "number" || !Number.isInteger(obj.state_valid_until)) throw new PresenceVerifierError("ERR_INVALID_FORMAT", "state_valid_until must be integer");
  if (typeof obj.human !== "boolean") throw new PresenceVerifierError("ERR_INVALID_FORMAT", "human must be boolean");
  if (typeof obj.pass !== "boolean") throw new PresenceVerifierError("ERR_INVALID_FORMAT", "pass must be boolean");
  if (typeof obj.nonce !== "string") throw new PresenceVerifierError("ERR_INVALID_FORMAT", "nonce must be string");
  if (typeof obj.device_attestation_digest !== "string") throw new PresenceVerifierError("ERR_INVALID_FORMAT", "device_attestation_digest must be string");
  if (typeof obj.signature !== "string") throw new PresenceVerifierError("ERR_INVALID_FORMAT", "signature must be string");

  // iss format: "presence:device:<32 hex chars>"
  if (!/^presence:device:[0-9a-f]{32}$/.test(obj.iss as string)) {
    throw new PresenceVerifierError("ERR_INVALID_FORMAT", `iss format invalid: ${obj.iss}`);
  }

  // device_attestation_digest: lowercase hex 64 chars
  if (!/^[0-9a-f]{64}$/.test(obj.device_attestation_digest as string)) {
    throw new PresenceVerifierError("ERR_INVALID_FORMAT", "device_attestation_digest must be 64 lowercase hex chars");
  }

  // signals: ["heart_rate"] or ["heart_rate", "steps"] only (Signal Spec v0.4 Section 3)
  const signals = obj.signals;
  if (!Array.isArray(signals)) {
    throw new PresenceVerifierError("ERR_INVALID_FORMAT", "signals must be array");
  }
  if (signals.length === 1) {
    if (signals[0] !== "heart_rate") {
      throw new PresenceVerifierError(
        "ERR_INVALID_FORMAT",
        `signals[0] must be "heart_rate", got "${signals[0]}"`
      );
    }
    if (obj.pass === true) {
      throw new PresenceVerifierError("ERR_INVALID_FORMAT", "pass=true requires signals [\"heart_rate\",\"steps\"]");
    }
  } else if (signals.length === 2) {
    if (signals[0] !== "heart_rate" || signals[1] !== "steps") {
      throw new PresenceVerifierError(
        "ERR_INVALID_FORMAT",
        `signals must be ["heart_rate","steps"] in canonical order, got ${JSON.stringify(signals)}`
      );
    }
  } else {
    throw new PresenceVerifierError(
      "ERR_INVALID_FORMAT",
      `signals must have 1 or 2 elements, got ${signals.length}`
    );
  }

  if (obj.pass === true && !(signals.length === 2 && signals[0] === "heart_rate" && signals[1] === "steps")) {
    throw new PresenceVerifierError("ERR_INVALID_FORMAT", "pass=true requires canonical signals [\"heart_rate\",\"steps\"]");
  }
}

// ─── Step 3: Nonce Format Validation ─────────────────────────────────────────

function validateNonceFormat(nonce: string): void {
  // base64url characters only
  if (!/^[A-Za-z0-9_-]+$/.test(nonce)) {
    throw new PresenceVerifierError("ERR_NONCE_INVALID", "nonce must be base64url format");
  }
  // Minimum 22 chars = 16 bytes entropy
  if (nonce.length < NONCE_MIN_BASE64URL_LENGTH) {
    throw new PresenceVerifierError(
      "ERR_NONCE_INVALID",
      `nonce too short: ${nonce.length} chars, minimum ${NONCE_MIN_BASE64URL_LENGTH}`
    );
  }
}

// ─── Step 6: Logical Time Constraints ────────────────────────────────────────

function validateLogicalTimeConstraints(
  a: import("./types.js").PresenceAttestation,
  now: number
): void {
  // state_created_at <= iat
  if (a.state_created_at > a.iat) {
    throw new PresenceVerifierError(
      "ERR_TIME_INVALID",
      `state_created_at (${a.state_created_at}) must be <= iat (${a.iat})`
    );
  }

  // state_valid_until > state_created_at
  if (a.state_valid_until <= a.state_created_at) {
    throw new PresenceVerifierError(
      "ERR_TIME_INVALID",
      "state_valid_until must be > state_created_at"
    );
  }

  // state_valid_until <= state_created_at + 72h
  if (a.state_valid_until > a.state_created_at + STATE_MAX_DURATION_SECONDS) {
    throw new PresenceVerifierError(
      "ERR_TIME_INVALID",
      `state_valid_until exceeds max duration of 72h`
    );
  }

  // state_valid_until > now
  if (a.state_valid_until <= now) {
    throw new PresenceVerifierError(
      "ERR_STATE_EXPIRED",
      `state expired at ${a.state_valid_until}, now is ${now}`
    );
  }
}
