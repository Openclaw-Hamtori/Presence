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

// ─── Constants ────────────────────────────────────────────────────────────────

const KEY_ALIAS = "pol_device_key_v1";

// ─── Key Generation ───────────────────────────────────────────────────────────

/**
 * Generate or retrieve ECDSA P-256 key in Secure Enclave.
 * Idempotent — returns existing key if already generated.
 * Returns DER-encoded SubjectPublicKeyInfo as base64url (no padding).
 *
 * NOTE: react-native-device-crypto returns standard base64 (with +/= chars).
 * We normalise to base64url here so the rest of the pipeline is consistent.
 */
export async function ensureDeviceKey(): Promise<Result<string>> {
  try {
    // getOrCreateAsymmetricKey is idempotent: creates key if absent, returns public key either way
    const publicKey = await DeviceCrypto.getOrCreateAsymmetricKey(KEY_ALIAS, {
      accessLevel: AccessLevel.ALWAYS,
      invalidateOnNewBiometry: false,
    });
    // Normalise: standard base64 → base64url (idempotent if already base64url)
    // Also strip all whitespace (react-native-device-crypto may include \n line breaks)
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
    const canonicalBytes = new TextEncoder().encode(canonical);
    const canonicalBase64url = uint8ArrayToBase64url(canonicalBytes);

    console.log("[PresenceCrypto] signAttestation canonical", canonical);
    console.log("[PresenceCrypto] signAttestation canonicalBytes", canonicalBytes.length);
    console.log("[PresenceCrypto] signAttestation canonicalBase64urlLength", canonicalBase64url.length);

    const signatureBase64url = await DeviceCrypto.sign(
      KEY_ALIAS,
      canonicalBase64url,
      { biometryTitle: "", biometrySubTitle: "", biometryDescription: "" }
    );

    console.log("[PresenceCrypto] signAttestation signatureBase64urlLength", signatureBase64url.length);
    console.log("[PresenceCrypto] signAttestation signatureBytes", base64urlToUint8Array(signatureBase64url).length);

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

// ─── SHA-256 (pure JS, Hermes-compatible) ─────────────────────────────────────
//
// Hermes does not expose SubtleCrypto. Pure JS implementation.
// Returns lowercase hex string.

export function sha256Hex(data: Uint8Array): string {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
    0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const msgLen = data.length;
  const bitLen = msgLen * 8;

  const padded: number[] = [...data, 0x80];
  while ((padded.length % 64) !== 56) padded.push(0);
  for (let i = 7; i >= 0; i--) {
    padded.push((bitLen / Math.pow(2, i * 8)) & 0xff);
  }

  const rotr = (n: number, x: number) => (x >>> n) | (x << (32 - n));

  for (let i = 0; i < padded.length; i += 64) {
    const w: number[] = [];
    for (let j = 0; j < 16; j++) {
      w[j] = ((padded[i + j * 4] << 24) | (padded[i + j * 4 + 1] << 16) |
               (padded[i + j * 4 + 2] << 8) | padded[i + j * 4 + 3]) >>> 0;
    }
    for (let j = 16; j < 64; j++) {
      const s0 = rotr(7, w[j-15]) ^ rotr(18, w[j-15]) ^ (w[j-15] >>> 3);
      const s1 = rotr(17, w[j-2]) ^ rotr(19, w[j-2]) ^ (w[j-2] >>> 10);
      w[j] = (w[j-16] + s0 + w[j-7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = [h0, h1, h2, h3, h4, h5, h6, h7];

    for (let j = 0; j < 64; j++) {
      const S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[j] + w[j]) >>> 0;
      const S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0+a)>>>0; h1 = (h1+b)>>>0; h2 = (h2+c)>>>0; h3 = (h3+d)>>>0;
    h4 = (h4+e)>>>0; h5 = (h5+f)>>>0; h6 = (h6+g)>>>0; h7 = (h7+h)>>>0;
  }

  return [h0,h1,h2,h3,h4,h5,h6,h7]
    .map((n) => n.toString(16).padStart(8, "0"))
    .join("");
}

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
