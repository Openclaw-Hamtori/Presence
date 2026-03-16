/**
 * presence-mobile — App Attest Module (iOS)
 *
 * Apple App Attest flow:
 *   1. Generate key (DCAppAttestService.generateKey)
 *   2. Attest key with challenge (server nonce digest)
 *   3. On subsequent calls: assert (assertion = sign with attested key)
 *
 * Verifier Spec v0.4 Step 10–11 (iOS path):
 *   - Verifier validates attestation certificate chain against Apple root
 *   - Verifier checks device_attestation_digest in payload
 *
 * NOTE: DCAppAttestService is a native iOS API.
 * In React Native, this is bridged via a native module.
 * This module defines the JS interface and expected native bridge contract.
 */

import { NativeModules, Platform } from "react-native";
import { computeAttestationDigest, sha256Hex, base64urlToUint8Array } from "../crypto/index";
import type { Result } from "../types/index";
import { ok, err } from "../types/index";

// ─── Native Module Contract ───────────────────────────────────────────────────

/**
 * PresenceAttestNative: expected native module interface.
 *
 * iOS implementation must:
 *   - generateAttestKey(): calls DCAppAttestService.generateKey()
 *   - attestKey(keyId, challengeHash): calls DCAppAttestService.attest(keyId, clientData)
 *     where clientData = SHA-256(challenge bytes)
 *
 * All return values MUST be base64url-encoded (no padding, - and _ instead of + and /).
 */
interface PresenceAttestNativeModule {
  isSupported(): Promise<boolean>;
  generateAttestKey(): Promise<string>;           // returns keyId (opaque string)
  attestKey(keyId: string, challengeHash: string): Promise<string>; // returns base64url attestation object bytes
}

function getNativeModule(): PresenceAttestNativeModule | null {
  if (Platform.OS !== "ios") return null;
  return (NativeModules.PresenceAttest as PresenceAttestNativeModule) ?? null;
}

// ─── App Attest Availability ──────────────────────────────────────────────────

export async function isAppAttestSupported(): Promise<boolean> {
  const native = getNativeModule();
  if (!native) return false;
  try {
    return await native.isSupported();
  } catch {
    return false;
  }
}

// ─── Full Attestation Flow ────────────────────────────────────────────────────

export interface AppAttestResult {
  /** base64url-encoded full App Attest object (CBOR bytes) — send to verifier */
  attestationBase64url: string;
  /** SHA-256 hex of attestation bytes — embed in PresenceAttestation payload */
  attestationDigest: string;
}

/**
 * Perform App Attest key generation + attestation.
 *
 * Challenge: service-provided nonce (base64url).
 * clientData for DCAppAttestService = SHA-256(nonce bytes).
 *
 * Called once during onboarding (or after key invalidation).
 * Result is cached — attestation object is re-sent with each verification request.
 */
export async function performAppAttest(
  nonce: string
): Promise<Result<AppAttestResult>> {
  const native = getNativeModule();
  if (!native) {
    return err("ERR_APP_ATTEST_FAILED", "App Attest native module not available");
  }

  try {
    // Step 1: Generate attestation key
    const keyId = await native.generateAttestKey();

    // Step 2: clientData = SHA-256(nonce bytes)
    const nonceBytes = base64urlToUint8Array(nonce);
    const clientDataHash = sha256Hex(nonceBytes);

    // Step 3: Attest key — returns base64url attestation object bytes
    const attestationBase64url = await native.attestKey(keyId, clientDataHash);

    // Decode to bytes for digest computation only
    const attestationBytes = base64urlToUint8Array(attestationBase64url);
    const attestationDigest = computeAttestationDigest(attestationBytes);

    return ok({ attestationBase64url, attestationDigest });
  } catch (e) {
    return err("ERR_APP_ATTEST_FAILED", `App Attest failed: ${e}`, e);
  }
}
