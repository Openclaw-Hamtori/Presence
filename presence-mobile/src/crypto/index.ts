/**
 * presence-mobile — Crypto Module
 *
 * Key generation:     ECDSA P-256 via react-native-device-crypto (Secure Enclave on iOS)
 * Signing:            ES256 (ECDSA P-256 + SHA-256)
 * Canonicalization:   JCS (RFC 8785) — mirrors presence-verifier/src/crypto.ts exactly
 * iss derivation:     "presence:device:" + hex(SHA-256(DER pubkey))[0:32]
 *                     Signal Spec v0.4 Section 8: first 16 bytes = 32 hex chars
 * Digest:             SHA-256(appAttestBytes) → hex
 */

import DeviceCrypto, { AccessLevel, KeyTypes } from "react-native-device-crypto";

// React Native globals not typed by default in this lib configuration
declare const TextEncoder: new () => { encode(str: string): Uint8Array };
declare const btoa: (str: string) => string;
declare const atob: (str: string) => string;
import type { PresenceAttestation, Result } from "../types/index";
import { ok, err } from "../types/index";
import { sha256Hex } from "./sha256";

// ─── Constants ────────────────────────────────────────────────────────────────

const KEY_ALIAS = "pol_device_key_v1";

// ─── Key Generation ───────────────────────────────────────────────────────────

/**
 * Generate or retrieve ECDSA P-256 key in Secure Enclave.
 * Idempotent — returns existing key if already generated.
 * Returns DER-encoded SubjectPublicKeyInfo as base64url.
 */
export async function ensureDeviceKey(): Promise<Result<string>> {
  try {
    // getOrCreateAsymmetricKey is idempotent: creates key if absent, returns public key either way
    const publicKey = await DeviceCrypto.getOrCreateAsymmetricKey(KEY_ALIAS, {
      accessLevel: AccessLevel.ALWAYS,
      invalidateOnNewBiometry: false,
    });
    // Strip PEM envelope if present, then normalise: standard base64 → base64url
    const pemStripped = publicKey
      .replace(/-----[^-\r\n]+-----/g, "")
      .replace(/\s/g, "");
    const publicKeyBase64url = pemStripped
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
    return ok(publicKeyBase64url);
  } catch (e) {
    return err("ERR_KEY_GENERATION_FAILED", `Key generation failed: ${e}`, e);
  }
}

export async function deleteDeviceKey(): Promise<void> {
  try {
    await DeviceCrypto.deleteKey(KEY_ALIAS);
  } catch {
    // best-effort
  }
}

// ─── iss Derivation ───────────────────────────────────────────────────────────

/**
 * Signal Spec v0.4 Section 8:
 *   iss = "presence:device:" + hex(SHA-256(DER public key))[0:32]
 *         = first 16 bytes of SHA-256 hash, as 32 lowercase hex chars
 *
 * This MUST match presence-verifier/src/crypto.ts deriveIss() exactly.
 */
export function deriveIss(publicKeyBase64url: string): string {
  const derBytes = base64urlToUint8Array(publicKeyBase64url);
  const fullHex = sha256Hex(derBytes);
  return `presence:device:${fullHex.slice(0, 32)}`; // first 16 bytes = 32 hex chars
}

// ─── Device Attestation Digest ────────────────────────────────────────────────

/**
 * Signal Spec v0.4 Section 4:
 *   device_attestation_digest = SHA-256(appAttestBytes) as lowercase hex
 */
export function computeAttestationDigest(appAttestBytes: Uint8Array): string {
  return sha256Hex(appAttestBytes);
}

// ─── Signing ──────────────────────────────────────────────────────────────────

/**
 * Sign a Presence attestation payload using ES256.
 *
 * Signal Spec v0.4 Section 4:
 *   1. Remove `signature` field from payload
 *   2. JCS-canonicalize (RFC 8785)
 *   3. Sign canonical UTF-8 bytes with ECDSA P-256 / SHA-256
 *   4. Return base64url-encoded signature
 */
export async function signAttestation(
  payload: Omit<PresenceAttestation, "signature">
): Promise<Result<string>> {
  try {
    const canonical = jcsSerialize(payload);

    const signatureBase64 = await DeviceCrypto.sign(
      KEY_ALIAS,
      canonical,
      { biometryTitle: "", biometrySubTitle: "", biometryDescription: "" }
    );

    const signatureBase64url = signatureBase64
      .replace(/\s/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");

    return ok(signatureBase64url);
  } catch (e) {
    return err("ERR_SIGNING_FAILED", `Signing failed: ${e}`, e);
  }
}

// ─── JCS (RFC 8785) ───────────────────────────────────────────────────────────
//
// Mirrors presence-verifier/src/crypto.ts jcsSerialize() exactly.
// Any divergence here will cause signature verification failures.
//
// Rules:
//   - Recursive key sort by UTF-16 code unit sequence
//   - -0 → 0
//   - Non-finite numbers throw
//   - String escaping via JSON.stringify (compliant Unicode)
//   - Arrays preserve order

export function jcsSerialize(value: unknown): string {
  return serializeValue(value);
}

function serializeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";

  if (typeof value === "number") {
    return serializeNumber(value);
  }

  if (typeof value === "string") {
    return JSON.stringify(value); // correct Unicode + control char escaping
  }

  if (Array.isArray(value)) {
    return "[" + value.map(serializeValue).join(",") + "]";
  }

  if (typeof value === "object") {
    return serializeObject(value as Record<string, unknown>);
  }

  throw new TypeError(`JCS: unsupported type ${typeof value}`);
}

function serializeNumber(n: number): string {
  if (!isFinite(n)) {
    throw new TypeError(`JCS: non-finite number ${n} is not allowed`);
  }
  if (Object.is(n, -0)) return "0"; // RFC 8785 Section 3.2.2.3
  return JSON.stringify(n);         // ES JSON.stringify number semantics
}

function serializeObject(obj: Record<string, unknown>): string {
  // Sort keys by UTF-16 code unit sequence (RFC 8785 Section 3.2.3)
  const sortedKeys = Object.keys(obj).sort((a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const diff = a.charCodeAt(i) - b.charCodeAt(i);
      if (diff !== 0) return diff;
    }
    return a.length - b.length;
  });

  const pairs = sortedKeys.map(
    (key) => JSON.stringify(key) + ":" + serializeValue(obj[key])
  );

  return "{" + pairs.join(",") + "}";
}

// sha256Hex now lives in ./sha256.ts to keep a single source of truth
// between mobile and test-app for long-form vector validation.

export { sha256Hex };

// ─── Base64url helpers ────────────────────────────────────────────────────────

export function uint8ArrayToBase64url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export function base64urlToUint8Array(input: string): Uint8Array {
  const normalized = input.replace(/\s/g, "").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  if (!/^[A-Za-z0-9\-_]*$/.test(normalized)) {
    throw new Error("invalid base64url string: contains illegal characters");
  }
  if (normalized.length % 4 === 1) {
    throw new Error(
      `invalid base64url string: length ${normalized.length} (mod 4 = 1) can never be valid base64url; input may be a plain string instead of base64url`
    );
  }
  const base64 = normalized
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const binary = atob(base64);
  return new Uint8Array([...binary].map((c) => c.charCodeAt(0)));
}
