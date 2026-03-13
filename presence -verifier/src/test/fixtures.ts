/**
 * Presence Verifier - Test Fixtures
 *
 * Shared helpers for building valid PresenceAttestation objects in tests.
 * Uses real ECDSA P-256 key generation (Node.js crypto) for signature vectors.
 */

import { generateKeyPairSync, createSign, createPrivateKey } from "crypto";
import { jcsSerialize, sha256Hex, base64urlEncode, deriveIss } from "../crypto.js";
import { InMemoryNonceStore, InMemoryTofuStore } from "../stores.js";
import type { PresenceAttestation } from "../types.js";

// ─── Key Generation ───────────────────────────────────────────────────────────

export function generateTestKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  return {
    privateKeyDer: privateKey as unknown as Buffer,
    publicKeyDer: publicKey as unknown as Buffer,
  };
}

// ─── Signature ────────────────────────────────────────────────────────────────

export function signAttestation(
  attestationWithoutSig: Omit<PresenceAttestation, "signature">,
  privateKeyDer: Buffer
): string {
  const canonical = jcsSerialize(attestationWithoutSig);
  const signer = createSign("SHA256");
  signer.update(Buffer.from(canonical, "utf8"));
  const sigDer = signer.sign({
    key: privateKeyDer,
    format: "der",
    type: "pkcs8",
  });
  return base64urlEncode(sigDer);
}

// ─── Fake Device Attestation ──────────────────────────────────────────────────

/** Returns fake raw bytes + matching digest for testing digest verification */
export function makeFakeDeviceAttestation(): {
  rawBytes: Uint8Array;
  digest: string;
} {
  const rawBytes = Buffer.from("fake-device-attestation-object-for-testing");
  const digest = sha256Hex(rawBytes);
  return { rawBytes, digest };
}

const PLAY_INTEGRITY_TEST_CERT_B64 = "MIIDJzCCAg+gAwIBAgIUG5izAZzMAzh8RsEEOZPgV8Dof/4wDQYJKoZIhvcNAQELBQAwIzEhMB8GA1UEAwwYUGxheSBJbnRlZ3JpdHkgVGVzdCBSb290MB4XDTI2MDMxMDEyMDcyM1oXDTI3MDMxMDEyMDcyM1owIzEhMB8GA1UEAwwYUGxheSBJbnRlZ3JpdHkgVGVzdCBSb290MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2eju6Yq5F8SNw/Nl6uDCAAjI0h2uw5YydlPwRMhEDgZk0+R801gDr16poXLdMoIOhp3WeFxkT9xaWGf5W4S03EP2c7KiP2uVuLFx8DCBAEfNAhRzBlm0wTL4Q0Vr9LfDozUYpZ7DAbpdwWcZvvp4a3MlyZ92N40zOz16pkSvYvglAoRZAgf8wM0a4UTpeGEejHSt134SyOXb9hibKnQoZYiUyg+sGN4ieAnHdibKhnasAU9tRUR2kE+dzhfGc/tc1hFn0xZhajz5AChsDtqPrEww0HXkxsbPBOk6np0Xqd/KTQjYuhlalrJ30kSKg1vD/+VijPajD3z8zN6lTi2HsQIDAQABo1MwUTAdBgNVHQ4EFgQUyoNfHHHzmMRGgbB1orRIKkD5VbUwHwYDVR0jBBgwFoAUyoNfHHHzmMRGgbB1orRIKkD5VbUwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAQwqbCf5g5afedq3xs1cco+HCC6/j9ada/ouNZEZ082weveeAlUZtIlTHnXm0I+sCPcKf4agS++KIT3/E2luduS7BEFiXHKExiXsWvv1NWJJsYGlwKKgaYYwvgZ76y69QdGiwyG+jqYrt+KYMw0KpQQ67UijuIh1JdcnP5iLxI5C/m91Gz/ymUOj7k9Az4YFHsLDqN3neZq2pAZi+kCgOVSo708pz+V+cT7Ww5mZI9k+KwNRGMBmVgU0Ba/cLtBJyAwX9UDWOraB5IPsigb3yOQsF9AWPHk+GWdc/bEkyaPE8Z2XjzzK1VGHSu/ACprY8zzCylTUk16SJc517FmAOag==";
const PLAY_INTEGRITY_TEST_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDZ6O7pirkXxI3D
82Xq4MIACMjSHa7DljJ2U/BEyEQOBmTT5HzTWAOvXqmhct0ygg6GndZ4XGRP3FpY
Z/lbhLTcQ/ZzsqI/a5W4sXHwMIEAR80CFHMGWbTBMvhDRWv0t8OjNRilnsMBul3B
Zxm++nhrcyXJn3Y3jTM7PXqmRK9i+CUChFkCB/zAzRrhROl4YR6MdK3XfhLI5dv2
GJsqdChliJTKD6wY3iJ4Ccd2JsqGdqwBT21FRHaQT53OF8Zz+1zWEWfTFmFqPPkA
KGwO2o+sTDDQdeTGxs8E6TqenRep38pNCNi6GVqWsnfSRIqDW8P/5WKM9qMPfPzM
3qVOLYexAgMBAAECggEACkQSiVcbPDbq1NnxKb0X9qdzSo7Sbm1ziCaRMbRbnGuJ
sX/Yr548YjUr+aqvKBN/erER6w6zPR3s9bBES573ZE8hW7cFNMatQYu+ienHEgvP
6TKsbpaoUNfFYWnyWY+UvGoidJ8Dod+1Tgi86kXjiXBdzd9g0uIokThmwFGJD7j5
vvk1eowMwtB8tAsoP2xyR9IBCWUB3IIdK+wwuiWIspQKh3trkFGZQCT+ypY0MymY
FeFZ3a40y8zIYI/pc3tl3cSWgnMN6k8cS03+J8VM2U/3qFUx1xV294tlu8efmQ7R
4zWau7QGyAlTZzeYncYqb76DWfcnZHGi0tDmIFf0rwKBgQD6EOwIc7oI87e8UKmA
pyOXQVnEc9G0hNh5E0Ngyc+dCr8sMfpQw6iu+Rc6bJbhw8oC1dVV2LlrF/Es87Wy
umzPS8UYqjimTUNCNFCxyQiVX8TLDTp3VZThbROyKcV7Q2uPwqMOkPQ2ZrUFfXC2
sFmcVW/kA+6P23J5b6IjvWynxwKBgQDfFKv4MFFow5Gy7aY0qDkIvjV/brKGMCed
LBmJncVZo0avJx2vmJru76ZmGhqkx/+Dh09+hrJj0MqMGn5u0NO3cKPC8oKTvWnu
UJtzphaUeFK/vfAVvIoanXvLxMi840oSKJmdxpQ/qya+RyWDMz/Tg73pnytd/AeW
xTF7sygExwKBgQCkoUNjhRzzC9Doz4noQyExUTrSFRX4bIU/oKj5LaPbVdnqNLUB
Ou7w0tiyBA+JbqauGy0qKVZY5RhIaeIzWnyMNOv7gwVspu0ixuJhSWK3RKeArqLR
MaykhHU1FD8JGafUq2VCD7hXoGKIzL7J52v3emABk30ZhHXm8NGkCe9gvQKBgBV+
3W9F4KJSrfhq0+ghCZXhFjCYTxWFEFwhwrgy/rA7fnUkNMUV1GAPsZ4HB+g26VUY
Nb3AZvIdTVcgumwdLTlw3ibLzW9FAi8Xj1MefvCBg5+8QqUljL0xzZr99EXXNOz5
AoxkdSaJbGtLWb8BsjXEbQlU8A3XWjfZ+oGr6sBDAoGBAPOOxeeYhh+TPn4ugYCA
nANL6j6jypaqT5SiOPiI/Sv19yab85gAzlcP3QNIe4PbY4C3pdbxMjms1wu/Knc2
UrmBR3222kgkUNA73U+iR4i6wfanWDHglJ4ZBCbAa4pIVC76/JIEdAZHmGoajR1g
RNq+vqyq2Py7v1qvtVYs7pCw
-----END PRIVATE KEY-----`;

export function makePlayIntegrityToken(opts: {
  nonce: string;
  packageName: string;
  appRecognitionVerdict?: string;
  deviceRecognitionVerdict?: string[];
}): { rawBytes: Uint8Array; digest: string; rootPem: string } {
  const header = {
    alg: "RS256",
    typ: "JWT",
    x5c: [PLAY_INTEGRITY_TEST_CERT_B64],
  };

  const payload = {
    requestDetails: {
      requestPackageName: opts.packageName,
      nonce: opts.nonce,
      timestampMillis: String(NOW * 1000),
    },
    appIntegrity: {
      appRecognitionVerdict: opts.appRecognitionVerdict ?? "PLAY_RECOGNIZED",
      packageName: opts.packageName,
    },
    deviceIntegrity: {
      deviceRecognitionVerdict: opts.deviceRecognitionVerdict ?? ["MEETS_DEVICE_INTEGRITY"],
    },
  };

  const headerB64 = base64urlEncode(Buffer.from(JSON.stringify(header), "utf8"));
  const payloadB64 = base64urlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
  const signingInput = `${headerB64}.${payloadB64}`;

  const signer = createSign("RSA-SHA256");
  signer.update(Buffer.from(signingInput, "ascii"));
  signer.end();
  const signature = signer.sign(createPrivateKey(PLAY_INTEGRITY_TEST_KEY_PEM));

  const token = `${signingInput}.${base64urlEncode(signature)}`;
  const rawBytes = Buffer.from(token, "utf8");
  return {
    rawBytes,
    digest: sha256Hex(rawBytes),
    rootPem: `-----BEGIN CERTIFICATE-----\n${PLAY_INTEGRITY_TEST_CERT_B64.match(/.{1,64}/g)?.join("\n")}\n-----END CERTIFICATE-----\n`,
  };
}

// ─── Time Helpers ─────────────────────────────────────────────────────────────

export const NOW = 1_741_300_000; // fixed test epoch (unix seconds)
export const STATE_CREATED = NOW - 3600;         // 1h ago
export const STATE_VALID_UNTIL = NOW + 68400;    // 19h from now (within 72h)

// ─── Valid Attestation Builder ────────────────────────────────────────────────

export interface BuildAttestationOptions {
  now?: number;
  stateCreatedAt?: number;
  stateValidUntil?: number;
  signals?: string[];
  nonce?: string;
  human?: boolean;
  pass?: boolean;
  overrides?: Partial<PresenceAttestation>;
}

export function buildValidAttestation(
  publicKeyDer: Buffer,
  privateKeyDer: Buffer,
  opts: BuildAttestationOptions = {}
): { attestation: PresenceAttestation; deviceAttestation: ReturnType<typeof makeFakeDeviceAttestation> } {
  const deviceAttestation = makeFakeDeviceAttestation();
  const iss = deriveIss(publicKeyDer);
  const nonce = opts.nonce ?? "dGVzdC1ub25jZS0xMjM0NTY"; // "test-nonce-123456" base64url

  const base: Omit<PresenceAttestation, "signature"> = {
    pol_version: "1.0",
    iss,
    iat: opts.now ?? NOW,
    state_created_at: opts.stateCreatedAt ?? STATE_CREATED,
    state_valid_until: opts.stateValidUntil ?? STATE_VALID_UNTIL,
    human: opts.human ?? true,
    pass: opts.pass ?? true,
    signals: (opts.signals as PresenceAttestation["signals"]) ?? ["heart_rate", "steps"],
    nonce,
    device_attestation_digest: deviceAttestation.digest,
    ...opts.overrides,
  } as Omit<PresenceAttestation, "signature">;

  const signature = signAttestation(base, privateKeyDer);
  const attestation: PresenceAttestation = { ...base, signature };

  return { attestation, deviceAttestation };
}

// ─── Store Helpers ────────────────────────────────────────────────────────────

export function makeStores(nonce: string, nowOverride = NOW) {
  const nonceStore = new InMemoryNonceStore(300);
  nonceStore.issue(nonce, nowOverride - 10); // issued 10s ago
  const tofuStore = new InMemoryTofuStore();
  return { nonceStore, tofuStore };
}
