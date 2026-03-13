/**
 * Presence Verifier - Crypto Utilities
 * JCS canonical serialization (RFC 8785), SHA-256, ECDSA P-256 verify
 */

import { createHash, createVerify, createPublicKey } from "crypto";
import type { PresenceAttestation } from "./types.js";

// ─── JCS Canonical Serialization (RFC 8785) ──────────────────────────────────

/**
 * RFC 8785 compliant JSON Canonicalization Scheme (JCS).
 *
 * Rules per spec:
 *   1. UTF-8 encoding
 *   2. Object keys sorted by Unicode code point (recursive)
 *   3. No insignificant whitespace
 *   4. Numbers: finite only; integers as integers; no -0
 *   5. Strings: Unicode escape sequences for control chars (\uXXXX)
 *   6. null, true, false as literals
 *   7. Arrays: order preserved
 *
 * This implementation is self-contained to avoid canonicalization
 * discrepancies across library versions — critical for signature compatibility.
 *
 * Reference: https://www.rfc-editor.org/rfc/rfc8785
 */
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
    return serializeString(value);
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
  // -0 → 0 per RFC 8785 Section 3.2.2.3
  if (Object.is(n, -0)) return "0";

  // Integer check: if n is a safe integer, emit without decimal
  // RFC 8785 uses ES JSON.stringify number semantics
  return JSON.stringify(n);
}

function serializeString(s: string): string {
  // Use JSON.stringify for correct Unicode escaping of control characters
  // JSON.stringify produces compliant RFC 8785 string encoding
  return JSON.stringify(s);
}

function serializeObject(obj: Record<string, unknown>): string {
  // Sort keys by Unicode code point order (RFC 8785 Section 3.2.3)
  const sortedKeys = Object.keys(obj).sort((a, b) => {
    // Compare by UTF-16 code unit sequence (matches JS string comparison)
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const diff = a.charCodeAt(i) - b.charCodeAt(i);
      if (diff !== 0) return diff;
    }
    return a.length - b.length;
  });

  const pairs = sortedKeys.map(
    (key) => serializeString(key) + ":" + serializeValue(obj[key])
  );

  return "{" + pairs.join(",") + "}";
}

/**
 * Produce the canonical signing input from a Presence Attestation.
 * Excludes `signature` field per Signal Spec v0.4 Section 4.
 */
export function getSigningInput(attestation: PresenceAttestation): Buffer {
  const { signature: _sig, ...withoutSig } = attestation;
  const canonical = jcsSerialize(withoutSig);
  return Buffer.from(canonical, "utf8");
}

// ─── SHA-256 Digest ───────────────────────────────────────────────────────────

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex").toLowerCase();
}

export function sha256Bytes(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

// ─── ECDSA P-256 Signature Verification ──────────────────────────────────────

/**
 * Verify ES256 (ECDSA P-256 + SHA-256) signature.
 *
 * @param signingInput - canonical payload bytes (JCS-serialized)
 * @param signatureBase64url - base64url-encoded DER signature
 * @param publicKeyDer - DER-encoded SubjectPublicKeyInfo (SPKI)
 */
export function verifyES256(
  signingInput: Buffer,
  signatureBase64url: string,
  publicKeyDer: Uint8Array
): boolean {
  try {
    const sigBytes = base64urlDecode(signatureBase64url);
    const pubKey = createPublicKey({
      key: Buffer.from(publicKeyDer),
      format: "der",
      type: "spki",
    });
    const verify = createVerify("SHA256");
    verify.update(signingInput);
    return verify.verify(pubKey, sigBytes);
  } catch {
    return false;
  }
}

// ─── Base64url ────────────────────────────────────────────────────────────────

export function base64urlDecode(input: string): Buffer {
  // Normalize base64url → base64
  const base64 = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(input.length + ((4 - (input.length % 4)) % 4), "=");
  return Buffer.from(base64, "base64");
}

export function base64urlEncode(input: Buffer | Uint8Array): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

// ─── iss Derivation (Signal Spec v0.4 Section 8) ─────────────────────────────

/**
 * Derive iss from DER-encoded SPKI public key bytes.
 * iss = "presence:device:" + hex(SHA-256(pubkey_bytes))[0:32]
 */
export function deriveIss(publicKeyDer: Uint8Array): string {
  const digest = sha256Bytes(publicKeyDer);
  const hexFull = Buffer.from(digest).toString("hex");
  return `presence:device:${hexFull.slice(0, 32)}`;
}
