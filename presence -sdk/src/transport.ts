/**
 * presence-sdk — Transport Parsing
 *
 * Converts raw HTTP request body (JSON) into VerifierInput for presence-verifier.
 *
 * iOS (Verifier Spec v0.4):
 * {
 *   "platform": "ios",
 *   "attestation": { ...Presence Attestation... },
 *   "device_attestation": "<base64url Apple attestation_object CBOR bytes>",
 *   "signing_public_key": "<DER-encoded SPKI of Secure Enclave signing key, base64url>"
 * }
 *
 * Android (Appendix v0.1 Section 4.3):
 * {
 *   "platform": "android",
 *   "attestation": { ...Presence Attestation... },
 *   "device_attestation": "<base64url Play Integrity token bytes>",
 *   "signing_public_key": "<DER-encoded SPKI, base64url without padding>"
 * }
 *
 * Platform:
 *   - Explicit top-level "platform" is the recommended transport contract.
 *   - Legacy fallback still exists for backward compatibility when omitted.
 */

import type { RawPresenceRequestBody, ParsedPresenceRequest } from "./types.js";
import { base64urlDecode } from "./nonce.js";

// ─── Parse ────────────────────────────────────────────────────────────────────

/**
 * Parse and validate the raw HTTP request body into a ParsedPresenceRequest.
 *
 * @param body - Parsed JSON object from request body
 * @throws Error with descriptive message on any format violation
 */
export function parsePresenceRequest(body: unknown): ParsedPresenceRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ParseError("request body must be a JSON object");
  }

  const raw = body as Record<string, unknown>;

  // ── attestation ─────────────────────────────────────────────────────────────
  if (!("attestation" in raw)) {
    throw new ParseError("missing required field: attestation");
  }
  if (typeof raw.attestation !== "object" || raw.attestation === null) {
    throw new ParseError("attestation must be a JSON object");
  }

  // ── device_attestation ──────────────────────────────────────────────────────
  if (!("device_attestation" in raw)) {
    throw new ParseError("missing required field: device_attestation");
  }
  if (typeof raw.device_attestation !== "string" || raw.device_attestation.length === 0) {
    throw new ParseError("device_attestation must be a non-empty base64url string");
  }

  let deviceAttestationRawBytes: Uint8Array;
  try {
    deviceAttestationRawBytes = new Uint8Array(
      base64urlDecode(raw.device_attestation)
    );
  } catch {
    throw new ParseError("device_attestation is not valid base64url");
  }

  // ── signing_public_key ──────────────────────────────────────────────────────
  let signingPublicKey: Uint8Array | undefined;

  if ("signing_public_key" in raw) {
    if (typeof raw.signing_public_key !== "string" || raw.signing_public_key.length === 0) {
      throw new ParseError("signing_public_key must be a non-empty base64url string");
    }
    try {
      signingPublicKey = new Uint8Array(base64urlDecode(raw.signing_public_key));
    } catch {
      throw new ParseError("signing_public_key is not valid base64url");
    }

    // Minimum size check: DER SPKI for P-256 is 91 bytes
    if (signingPublicKey.length < 91) {
      throw new ParseError(
        "signing_public_key too short to be a valid DER-encoded P-256 SPKI public key"
      );
    }
  }

  // ── platform resolution ─────────────────────────────────────────────────────
  // Prefer explicit field; legacy inference remains for backward compatibility.
  let platform: import("presence-verifier").Platform;
  let platformExplicit = false;
  const rawPlatform = "platform" in raw ? raw.platform : undefined;

  if (rawPlatform === "ios" || rawPlatform === "android") {
    platform = rawPlatform;
    platformExplicit = true;
  } else if (rawPlatform !== undefined) {
    throw new ParseError(`invalid platform value: ${String(rawPlatform)}`);
  } else {
    // Legacy inference:
    // - signing_public_key present  => android
    // - signing_public_key absent   => ios
    platform = signingPublicKey !== undefined ? "android" : "ios";
  }

  return {
    attestation: raw.attestation as import("presence-verifier").PresenceAttestation,
    deviceAttestationRawBytes,
    signingPublicKey,
    platform,
    platformExplicit,
  };
}

// ─── Parse Error ──────────────────────────────────────────────────────────────

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PresenceParseError";
  }
}
