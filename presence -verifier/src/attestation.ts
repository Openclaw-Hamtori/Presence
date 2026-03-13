/**
 * Presence Verifier - Device Attestation Handlers
 *
 * iOS:     Apple App Attest (CBOR attestation_object)
 * Android: Google Play Integrity (Classic request, JWT token)
 *
 * Based on Verifier Spec v0.4 Steps 8–10 and Android Appendix v0.1
 */

import { createHash, createVerify, X509Certificate as NodeX509Certificate } from "crypto";
import { decodeFirst as cborDecodeFirst } from "cbor";
import { X509Certificate, X509ChainBuilder, cryptoProvider } from "@peculiar/x509";
import { webcrypto } from "crypto";
import type {
  DeviceAttestationResult,
  IosClaims,
  AndroidClaims,
  ServicePolicy,
  TofuStore,
} from "./types.js";
import { PresenceVerifierError } from "./types.js";
import { sha256Hex } from "./crypto.js";

// Set up @peculiar/x509 crypto provider (Node.js 18+ webcrypto).
// Double cast required: Node's webcrypto type differs from @peculiar/x509's Crypto expectation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
cryptoProvider.set(webcrypto as any);

// ─── iOS: Apple App Attest ────────────────────────────────────────────────────

/**
 * Apple App Attest AAGUID values (16 bytes each, ASCII-encoded).
 * Production: "appattest\x00\x00\x00\x00\x00\x00\x00" (9 chars + 7 nulls)
 * Development: "appattestdevelop" (16 chars)
 */
const AAGUID_PRODUCTION  = Buffer.from("appattest\x00\x00\x00\x00\x00\x00\x00"); // 16 bytes
const AAGUID_DEVELOPMENT = Buffer.from("appattestdevelop");                       // 16 bytes

/**
 * Verify Apple App Attest attestation_object.
 *
 * Implements Apple's server-side attestation verification:
 *   Reference: https://developer.apple.com/documentation/devicecheck/validating_apps_that_connect_to_your_server
 *
 * Steps verified:
 *   1. CBOR decode: extract fmt, attStmt.x5c, authData
 *   2. fmt must equal "apple-appattest"
 *   3. x5c must contain ≥ 2 certificates
 *   4. Certificate chain: leaf → intermediate [→ Apple root CA if provided]
 *   5. rpIdHash in authData = SHA-256(expectedAppId)
 *   6. AAGUID = "appattest" + NUL (production) or "appattestdevelop" (development)
 *   7. counter reported (typically 0 at first attestation)
 *   8. authData flags indicate attested credential data is present
 *   9. credential ID length and COSE key section are structurally present
 *
 * Note on nonce verification:
 *   The Presence protocol caches the App Attest attestation after onboarding and
 *   re-sends it with each request. Per-request freshness is guaranteed by the outer
 *   PresenceAttestation.nonce and the Secure Enclave ES256 signature (Step 11).
 *   The clientDataHash embedded in authData refers to the onboarding nonce and is
 *   not re-checked on subsequent requests.
 *
 * Note on device public key:
 *   The App Attest key (DCAppAttestService) and the Secure Enclave signing key
 *   (react-native-device-crypto) are distinct. The signing key is provided in the
 *   transport's signing_public_key field and used by verifier.ts for Step 11.
 *   This function returns only the verified claims (not the key).
 *
 * @param rawAttestationBytes  CBOR attestation_object bytes from DCAppAttestService
 * @param expectedAppId        "teamId.bundleId" (e.g. "TEAMID1234.com.example.polapp")
 * @param appleRootCA          Apple App Attestation Root CA (DER bytes or PEM string).
 *                             Obtain from: https://www.apple.com/certificateauthority/
 *                                          Apple_App_Attestation_Root_CA.pem
 *                             If omitted, root CA verification is skipped (dev mode only).
 */
export async function verifyAppleAttestation(
  rawAttestationBytes: Uint8Array,
  expectedAppId: string,
  appleRootCA?: Uint8Array | string
): Promise<DeviceAttestationResult> {

  // ── Step 1: CBOR decode ──────────────────────────────────────────────────
  type AttestationObject = {
    fmt: unknown;
    attStmt: { x5c?: unknown[]; sig?: unknown; receipt?: unknown };
    authData: unknown;
  };

  let ao: AttestationObject;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ao = await cborDecodeFirst(Buffer.from(rawAttestationBytes)) as AttestationObject;
  } catch (e) {
    throw new PresenceVerifierError("ERR_INVALID_ATTESTATION", `CBOR decode failed: ${e}`);
  }

  if (typeof ao !== "object" || ao === null) {
    throw new PresenceVerifierError("ERR_INVALID_ATTESTATION", "attestation_object is not a CBOR map");
  }

  const { fmt, attStmt, authData } = ao;

  // ── Step 2: Verify format ────────────────────────────────────────────────
  if (fmt !== "apple-appattest") {
    throw new PresenceVerifierError(
      "ERR_INVALID_ATTESTATION",
      `expected fmt "apple-appattest", got "${String(fmt)}"`
    );
  }

  // ── Step 3: Validate certificate array ──────────────────────────────────
  if (!attStmt || typeof attStmt !== "object") {
    throw new PresenceVerifierError("ERR_INVALID_ATTESTATION", "attStmt missing or invalid");
  }

  const x5c = attStmt.x5c;
  if (!Array.isArray(x5c) || x5c.length < 2) {
    throw new PresenceVerifierError(
      "ERR_INVALID_ATTESTATION",
      "attStmt.x5c must be an array of ≥ 2 DER-encoded certificates"
    );
  }

  // ── Step 4: Parse and verify certificate chain ───────────────────────────
  let credCert: X509Certificate;
  let intermediateCert: X509Certificate;
  try {
    credCert         = new X509Certificate(x5c[0] as ArrayBuffer);
    intermediateCert = new X509Certificate(x5c[1] as ArrayBuffer);
  } catch (e) {
    throw new PresenceVerifierError("ERR_INVALID_ATTESTATION", `certificate parse failed: ${e}`);
  }

  if (appleRootCA) {
    let rootCert: X509Certificate;
    try {
      rootCert = new X509Certificate(
        typeof appleRootCA === "string" ? appleRootCA : (appleRootCA as unknown as ArrayBuffer)
      );
    } catch (e) {
      throw new PresenceVerifierError("ERR_INVALID_ATTESTATION", `Apple root CA parse failed: ${e}`);
    }

    let chain: X509Certificate[];
    try {
      chain = await new X509ChainBuilder({ certificates: [intermediateCert, rootCert] })
        .build(credCert);
    } catch (e) {
      throw new PresenceVerifierError("ERR_INVALID_ATTESTATION", `cert chain validation failed: ${e}`);
    }

    if (!chain || chain.length < 3) {
      throw new PresenceVerifierError(
        "ERR_INVALID_ATTESTATION",
        "cert chain incomplete: expected leaf → intermediate → Apple root CA"
      );
    }
  } else {
    try {
      await new X509ChainBuilder({ certificates: [intermediateCert] }).build(credCert);
    } catch {
      // Non-fatal without root CA — partial chain only.
    }
  }

  // ── Step 5–9: Parse and validate authData ────────────────────────────────
  const authDataBuf = Buffer.isBuffer(authData)
    ? authData as Buffer
    : Buffer.from(authData as Uint8Array);

  if (authDataBuf.length < 55) {
    throw new PresenceVerifierError(
      "ERR_INVALID_ATTESTATION",
      `authData too short: ${authDataBuf.length} bytes (minimum 55)`
    );
  }

  const rpIdHash  = authDataBuf.subarray(0, 32);
  const flags     = authDataBuf[32];
  const counter   = authDataBuf.readUInt32BE(33);
  const aaguidBuf = authDataBuf.subarray(37, 53);
  const credIdLen = authDataBuf.readUInt16BE(53);
  const credIdStart = 55;
  const credIdEnd = credIdStart + credIdLen;

  if ((flags & 0x40) === 0) {
    throw new PresenceVerifierError(
      "ERR_INVALID_ATTESTATION",
      "authData flags missing attested credential data bit"
    );
  }

  if (credIdEnd > authDataBuf.length) {
    throw new PresenceVerifierError(
      "ERR_INVALID_ATTESTATION",
      `credential ID overruns authData: credIdLen=${credIdLen}, authData=${authDataBuf.length}`
    );
  }

  if (credIdEnd === authDataBuf.length) {
    throw new PresenceVerifierError(
      "ERR_INVALID_ATTESTATION",
      "authData missing COSE public key after credential ID"
    );
  }

  // ── Step 6: Verify AAGUID ────────────────────────────────────────────────
  if (!aaguidBuf.equals(AAGUID_PRODUCTION) && !aaguidBuf.equals(AAGUID_DEVELOPMENT)) {
    throw new PresenceVerifierError(
      "ERR_INVALID_ATTESTATION",
      `unexpected AAGUID: ${aaguidBuf.toString("hex")} ` +
      `(expected "appattest\\x00×7" for production or "appattestdevelop" for development)`
    );
  }

  // ── Step 7: Verify appId hash ────────────────────────────────────────────
  const expectedRpIdHash = createHash("sha256").update(expectedAppId, "utf8").digest();
  if (!expectedRpIdHash.equals(rpIdHash)) {
    throw new PresenceVerifierError(
      "ERR_INVALID_ATTESTATION",
      `rpIdHash mismatch: authData[0:32] does not match SHA-256("${expectedAppId}")`
    );
  }

  const claims: IosClaims = { platform: "ios", appId: expectedAppId, counter };

  return { devicePublicKey: new Uint8Array(0), claims };
}

// ─── Android: Google Play Integrity ──────────────────────────────────────────

type JwtHeader = {
  alg?: unknown;
  x5c?: unknown;
  typ?: unknown;
};

type PlayIntegrityDecodedToken = {
  requestDetails?: {
    requestPackageName?: unknown;
    nonce?: unknown;
    timestampMillis?: unknown;
  };
  appIntegrity?: {
    appRecognitionVerdict?: unknown;
    packageName?: unknown;
  };
  deviceIntegrity?: {
    deviceRecognitionVerdict?: unknown;
  };
};

/**
 * Verify Google Play Integrity token (Classic request).
 *
 * What this now does locally:
 *   1. Parse compact JWS format
 *   2. Validate protected header shape
 *   3. Verify JWS signature against x5c leaf certificate if present
 *   4. Optionally validate x5c chain when Google root CA is supplied
 *   5. Validate nonce, package name, and integrity verdicts
 *
 * Remaining production requirement:
 *   - You still need real Play Integrity tokens issued by Google.
 *   - For strong production trust, supply Google root CA / pinned trust material.
 */
export async function verifyPlayIntegrityToken(
  rawTokenBytes: Uint8Array,
  expectedNonce: string,
  policy: ServicePolicy
): Promise<AndroidClaims> {
  const tokenString = Buffer.from(rawTokenBytes).toString("utf8").trim();
  const { signingInput, signature, header, payload } = parseCompactJwt(tokenString);

  if (header.alg !== "RS256") {
    throw new PresenceVerifierError(
      "ERR_INVALID_ATTESTATION",
      `unsupported Play Integrity JWS alg: ${String(header.alg)}`
    );
  }

  const x5c = Array.isArray(header.x5c) ? header.x5c : [];
  if (x5c.length > 0) {
    await verifyJwtSignatureWithX5c(signingInput, signature, x5c, policy.google_play_root_ca);
  } else if (policy.allow_unverified_play_integrity !== true) {
    throw new PresenceVerifierError(
      "ERR_INVALID_ATTESTATION",
      "Play Integrity JWS missing x5c certificate chain"
    );
  }

  const requestDetails = payload.requestDetails;
  const appIntegrity = payload.appIntegrity;
  const deviceIntegrity = payload.deviceIntegrity;

  const requestNonce = ensureString(
    requestDetails?.nonce,
    "Play Integrity requestDetails.nonce missing or invalid"
  );

  if (requestNonce !== expectedNonce) {
    throw new PresenceVerifierError(
      "ERR_INVALID_ATTESTATION",
      "Play Integrity nonce mismatch"
    );
  }

  const requestPackageName = ensureString(
    requestDetails?.requestPackageName,
    "Play Integrity requestDetails.requestPackageName missing or invalid"
  );

  const packageName = typeof appIntegrity?.packageName === "string"
    ? appIntegrity.packageName
    : requestPackageName;

  if (!policy.android_package_name) {
    throw new PresenceVerifierError(
      "ERR_INVALID_FORMAT",
      "policy.android_package_name required for Android path"
    );
  }

  if (packageName !== policy.android_package_name || requestPackageName !== policy.android_package_name) {
    throw new PresenceVerifierError(
      "ERR_INVALID_ATTESTATION",
      `Play Integrity package mismatch: expected ${policy.android_package_name}, got request=${requestPackageName}, app=${packageName}`
    );
  }

  const appRecognitionVerdict = ensureString(
    appIntegrity?.appRecognitionVerdict,
    "Play Integrity appRecognitionVerdict missing or invalid"
  );

  if (appRecognitionVerdict !== "PLAY_RECOGNIZED") {
    throw new PresenceVerifierError(
      "ERR_INVALID_ATTESTATION",
      `unexpected appRecognitionVerdict: ${appRecognitionVerdict}`
    );
  }

  const deviceRecognitionVerdict = ensureStringArray(
    deviceIntegrity?.deviceRecognitionVerdict,
    "Play Integrity deviceRecognitionVerdict missing or invalid"
  );

  if (!deviceRecognitionVerdict.includes("MEETS_DEVICE_INTEGRITY")) {
    throw new PresenceVerifierError(
      "ERR_INVALID_ATTESTATION",
      `deviceRecognitionVerdict does not include MEETS_DEVICE_INTEGRITY: ${JSON.stringify(deviceRecognitionVerdict)}`
    );
  }

  return {
    platform: "android",
    packageName,
    appRecognitionVerdict,
    deviceRecognitionVerdict,
    requestNonce,
  };
}

/**
 * Android TOFU key registration and verification.
 * Android Appendix v0.1 Section 5.3
 *
 * Order MUST be:
 *   1. Play Integrity verdict verified (caller responsibility)
 *   2. TOFU registration / verification  ← this function
 *   3. Signature verification            ← caller proceeds after this
 */
export async function resolveTofuPublicKey(
  iss: string,
  signingPublicKeyDer: Uint8Array,
  tofuStore: TofuStore
): Promise<Uint8Array> {
  const stored = await tofuStore.get(iss);

  if (stored === null) {
    await tofuStore.set(iss, signingPublicKeyDer);
    return signingPublicKeyDer;
  }

  if (!buffersEqual(stored, signingPublicKeyDer)) {
    throw new PresenceVerifierError(
      "ERR_INVALID_SIGNATURE",
      "signing public key does not match registered key for iss"
    );
  }

  return stored;
}

// ─── Shared: device_attestation_digest verification ──────────────────────────

/**
 * Verifier Spec v0.4 Step 9
 * Compute SHA-256 of raw attestation bytes and compare with digest field.
 */
export function verifyAttestationDigest(
  rawAttestationBytes: Uint8Array,
  expectedDigest: string
): void {
  const computed = sha256Hex(rawAttestationBytes);
  if (computed !== expectedDigest.toLowerCase()) {
    throw new PresenceVerifierError(
      "ERR_ATTESTATION_DIGEST_MISMATCH",
      `expected ${expectedDigest}, got ${computed}`
    );
  }
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function parseCompactJwt(token: string): {
  signingInput: Buffer;
  signature: Buffer;
  header: JwtHeader;
  payload: PlayIntegrityDecodedToken;
} {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new PresenceVerifierError("ERR_INVALID_ATTESTATION", "Play Integrity token is not compact JWS");
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  let header: JwtHeader;
  let payload: PlayIntegrityDecodedToken;
  try {
    header = JSON.parse(base64urlToUtf8(headerB64)) as JwtHeader;
    payload = JSON.parse(base64urlToUtf8(payloadB64)) as PlayIntegrityDecodedToken;
  } catch (e) {
    throw new PresenceVerifierError("ERR_INVALID_ATTESTATION", `Play Integrity JWS decode failed: ${e}`);
  }

  const signature = base64urlToBuffer(signatureB64);
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, "ascii");

  return { signingInput, signature, header, payload };
}

async function verifyJwtSignatureWithX5c(
  signingInput: Buffer,
  signature: Buffer,
  x5c: unknown[],
  rootCA?: Uint8Array | string
): Promise<void> {
  if (x5c.length === 0) {
    throw new PresenceVerifierError("ERR_INVALID_ATTESTATION", "x5c certificate chain is empty");
  }

  const certs = x5c.map((entry, idx) => {
    if (typeof entry !== "string") {
      throw new PresenceVerifierError(
        "ERR_INVALID_ATTESTATION",
        `x5c[${idx}] must be a base64 DER certificate string`
      );
    }
    const der = Buffer.from(entry, "base64");
    return new X509Certificate(der);
  });

  const leaf = certs[0];

  const verify = createVerify("RSA-SHA256");
  verify.update(signingInput);
  verify.end();

  const leafPublicKey = new NodeX509Certificate(Buffer.from(x5c[0] as string, "base64")).publicKey;
  if (!verify.verify(leafPublicKey, signature)) {
    throw new PresenceVerifierError("ERR_INVALID_ATTESTATION", "Play Integrity JWS signature invalid");
  }

  if (rootCA) {
    let rootCert: X509Certificate;
    try {
      rootCert = new X509Certificate(
        typeof rootCA === "string" ? rootCA : (rootCA as unknown as ArrayBuffer)
      );
    } catch (e) {
      throw new PresenceVerifierError("ERR_INVALID_ATTESTATION", `Google root CA parse failed: ${e}`);
    }

    const intermediates = certs.slice(1);
    try {
      await new X509ChainBuilder({ certificates: [...intermediates, rootCert] }).build(leaf);
    } catch (e) {
      throw new PresenceVerifierError("ERR_INVALID_ATTESTATION", `Play Integrity cert chain validation failed: ${e}`);
    }
  }
}

function base64urlToUtf8(input: string): string {
  return base64urlToBuffer(input).toString("utf8");
}

function base64urlToBuffer(input: string): Buffer {
  const base64 = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(input.length + ((4 - (input.length % 4)) % 4), "=");
  return Buffer.from(base64, "base64");
}

function ensureString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PresenceVerifierError("ERR_INVALID_ATTESTATION", message);
  }
  return value;
}

function ensureStringArray(value: unknown, message: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new PresenceVerifierError("ERR_INVALID_ATTESTATION", message);
  }
  return value as string[];
}

function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return a.every((byte, i) => byte === b[i]);
}
