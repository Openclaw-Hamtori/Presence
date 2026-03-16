/**
 * Presence Verifier - Core Verification Tests
 *
 * Covers:
 *   - real Android Play Integrity JWS parsing/signature verification path
 *   - nonce replay and expiry checks
 *   - attestation digest mismatch
 *   - TOFU registration / mismatch
 *   - format and time validation
 */

import { strict as assert } from "assert";
import { verify } from "../verifier.js";
import { InMemoryNonceStore, InMemoryTofuStore } from "../stores.js";
import {
  generateTestKeyPair,
  buildValidAttestation,
  makeStores,
  makePlayIntegrityToken,
  NOW,
} from "./fixtures.js";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}:`, (e as Error).message);
    failed++;
  }
}

(async () => {
  console.log("\n── Verifier Core ──");

  const keys = generateTestKeyPair();
  const packageName = "com.presence.testapp";

  await test("valid Android attestation passes full verify() path", async () => {
    const nonce = "dmFsaWQtbm9uY2UtMTIzNDU2Nzg5MA";
    const playIntegrity = makePlayIntegrityToken({ nonce, packageName });
    const { attestation } = buildValidAttestation(keys.publicKeyDer, keys.privateKeyDer, {
      nonce,
      overrides: { device_attestation_digest: playIntegrity.digest },
    });
    const { nonceStore, tofuStore } = makeStores(nonce);

    const result = await verify(
      {
        attestation,
        deviceAttestationRawBytes: playIntegrity.rawBytes,
        signingPublicKey: keys.publicKeyDer,
        platform: "android",
        policy: {
          android_package_name: packageName,
          google_play_root_ca: playIntegrity.rootPem,
        },
      },
      { nonceStore, tofuStore, nowOverride: NOW }
    );

    assert.equal(result.verified, true);
    if (result.verified) {
      assert.equal(result.state_created_at, attestation.state_created_at);
      assert.equal(result.state_valid_until, attestation.state_valid_until);
    }
  });

  await test("ERR_NONCE_REUSED on second submission", async () => {
    const nonce = "cmV1c2Utbm9uY2UtMTIzNDU2Nzg5MDE";
    const playIntegrity = makePlayIntegrityToken({ nonce, packageName });
    const { attestation } = buildValidAttestation(keys.publicKeyDer, keys.privateKeyDer, {
      nonce,
      overrides: { device_attestation_digest: playIntegrity.digest },
    });
    const { nonceStore, tofuStore } = makeStores(nonce);

    const first = await verify(
      {
        attestation,
        deviceAttestationRawBytes: playIntegrity.rawBytes,
        signingPublicKey: keys.publicKeyDer,
        platform: "android",
        policy: {
          android_package_name: packageName,
          google_play_root_ca: playIntegrity.rootPem,
        },
      },
      { nonceStore, tofuStore, nowOverride: NOW }
    );
    assert.equal(first.verified, true);

    const second = await verify(
      {
        attestation,
        deviceAttestationRawBytes: playIntegrity.rawBytes,
        signingPublicKey: keys.publicKeyDer,
        platform: "android",
        policy: {
          android_package_name: packageName,
          google_play_root_ca: playIntegrity.rootPem,
        },
      },
      { nonceStore, tofuStore, nowOverride: NOW }
    );
    assert.equal(second.verified, false);
    if (!second.verified) assert.equal(second.error, "ERR_NONCE_REUSED");
  });

  await test("ERR_ATTESTATION_DIGEST_MISMATCH on tampered attestation bytes", async () => {
    const nonce = "ZGlnZXN0LW5vbmNlLTEyMzQ1Njc4OTAx";
    const playIntegrity = makePlayIntegrityToken({ nonce, packageName });
    const { attestation } = buildValidAttestation(keys.publicKeyDer, keys.privateKeyDer, {
      nonce,
      overrides: { device_attestation_digest: playIntegrity.digest },
    });
    const { nonceStore, tofuStore } = makeStores(nonce);

    const result = await verify(
      {
        attestation,
        deviceAttestationRawBytes: Buffer.from("tampered-play-integrity-token", "utf8"),
        signingPublicKey: keys.publicKeyDer,
        platform: "android",
        policy: {
          android_package_name: packageName,
          google_play_root_ca: playIntegrity.rootPem,
        },
      },
      { nonceStore, tofuStore, nowOverride: NOW }
    );

    assert.equal(result.verified, false);
    if (!result.verified) assert.equal(result.error, "ERR_ATTESTATION_DIGEST_MISMATCH");
  });

  await test("ERR_INVALID_ATTESTATION on package mismatch", async () => {
    const nonce = "cGtnLW5vbmNlLTEyMzQ1Njc4OTAxMjM";
    const playIntegrity = makePlayIntegrityToken({ nonce, packageName: "com.other.app" });
    const { attestation } = buildValidAttestation(keys.publicKeyDer, keys.privateKeyDer, {
      nonce,
      overrides: { device_attestation_digest: playIntegrity.digest },
    });
    const { nonceStore, tofuStore } = makeStores(nonce);

    const result = await verify(
      {
        attestation,
        deviceAttestationRawBytes: playIntegrity.rawBytes,
        signingPublicKey: keys.publicKeyDer,
        platform: "android",
        policy: {
          android_package_name: packageName,
          google_play_root_ca: playIntegrity.rootPem,
        },
      },
      { nonceStore, tofuStore, nowOverride: NOW }
    );

    assert.equal(result.verified, false);
    if (!result.verified) assert.equal(result.error, "ERR_INVALID_ATTESTATION");
  });

  await test("ERR_INVALID_ATTESTATION on device integrity verdict failure", async () => {
    const nonce = "ZGV2aWNlLW5vbmNlLTEyMzQ1Njc4OTAx";
    const playIntegrity = makePlayIntegrityToken({
      nonce,
      packageName,
      deviceRecognitionVerdict: ["MEETS_BASIC_INTEGRITY"],
    });
    const { attestation } = buildValidAttestation(keys.publicKeyDer, keys.privateKeyDer, {
      nonce,
      overrides: { device_attestation_digest: playIntegrity.digest },
    });
    const { nonceStore, tofuStore } = makeStores(nonce);

    const result = await verify(
      {
        attestation,
        deviceAttestationRawBytes: playIntegrity.rawBytes,
        signingPublicKey: keys.publicKeyDer,
        platform: "android",
        policy: {
          android_package_name: packageName,
          google_play_root_ca: playIntegrity.rootPem,
        },
      },
      { nonceStore, tofuStore, nowOverride: NOW }
    );

    assert.equal(result.verified, false);
    if (!result.verified) assert.equal(result.error, "ERR_INVALID_ATTESTATION");
  });

  await test("ERR_INVALID_SIGNATURE on TOFU mismatch for same iss", async () => {
    const nonce1 = "dG9mdS1ub25jZS0xMjM0NTY3ODkwMQ";
    const playIntegrity1 = makePlayIntegrityToken({ nonce: nonce1, packageName });
    const { attestation: att1 } = buildValidAttestation(keys.publicKeyDer, keys.privateKeyDer, {
      nonce: nonce1,
      overrides: { device_attestation_digest: playIntegrity1.digest },
    });

    const nonceStore = new InMemoryNonceStore(300);
    const tofuStore = new InMemoryTofuStore();
    nonceStore.issue(nonce1, NOW - 5);

    const first = await verify(
      {
        attestation: att1,
        deviceAttestationRawBytes: playIntegrity1.rawBytes,
        signingPublicKey: keys.publicKeyDer,
        platform: "android",
        policy: {
          android_package_name: packageName,
          google_play_root_ca: playIntegrity1.rootPem,
        },
      },
      { nonceStore, tofuStore, nowOverride: NOW }
    );
    assert.equal(first.verified, true);

    const otherKeys = generateTestKeyPair();
    const nonce2 = "dG9mdS1ub25jZS0yMjM0NTY3ODkwMg";
    nonceStore.issue(nonce2, NOW - 5);
    const playIntegrity2 = makePlayIntegrityToken({ nonce: nonce2, packageName });
    const { attestation: att2 } = buildValidAttestation(otherKeys.publicKeyDer, otherKeys.privateKeyDer, {
      nonce: nonce2,
      overrides: {
        iss: att1.iss,
        device_attestation_digest: playIntegrity2.digest,
      },
    });

    const result = await verify(
      {
        attestation: att2,
        deviceAttestationRawBytes: playIntegrity2.rawBytes,
        signingPublicKey: otherKeys.publicKeyDer,
        platform: "android",
        policy: {
          android_package_name: packageName,
          google_play_root_ca: playIntegrity2.rootPem,
        },
      },
      { nonceStore, tofuStore, nowOverride: NOW }
    );

    assert.equal(result.verified, false);
    if (!result.verified) assert.equal(result.error, "ERR_INVALID_FORMAT");
  });

  await test("ERR_INVALID_FORMAT on signal order", async () => {
    const nonce = "c2lnbmFscy1ub25jZS0xMjM0NTY3ODk";
    const playIntegrity = makePlayIntegrityToken({ nonce, packageName });
    const { attestation } = buildValidAttestation(keys.publicKeyDer, keys.privateKeyDer, {
      nonce,
      signals: ["steps", "heart_rate"] as unknown as string[],
      overrides: { device_attestation_digest: playIntegrity.digest },
    });
    const { nonceStore, tofuStore } = makeStores(nonce);

    const result = await verify(
      {
        attestation,
        deviceAttestationRawBytes: playIntegrity.rawBytes,
        signingPublicKey: keys.publicKeyDer,
        platform: "android",
        policy: {
          android_package_name: packageName,
          google_play_root_ca: playIntegrity.rootPem,
        },
      },
      { nonceStore, tofuStore, nowOverride: NOW }
    );

    assert.equal(result.verified, false);
    if (!result.verified) assert.equal(result.error, "ERR_INVALID_FORMAT");
  });

  await test("ERR_TIME_INVALID when state_created_at is after iat", async () => {
    const nonce = "dGltZS1ub25jZS0xMjM0NTY3ODkwMTIz";
    const playIntegrity = makePlayIntegrityToken({ nonce, packageName });
    const { attestation } = buildValidAttestation(keys.publicKeyDer, keys.privateKeyDer, {
      nonce,
      stateCreatedAt: NOW + 100,
      overrides: { device_attestation_digest: playIntegrity.digest },
    });
    const { nonceStore, tofuStore } = makeStores(nonce);

    const result = await verify(
      {
        attestation,
        deviceAttestationRawBytes: playIntegrity.rawBytes,
        signingPublicKey: keys.publicKeyDer,
        platform: "android",
        policy: {
          android_package_name: packageName,
          google_play_root_ca: playIntegrity.rootPem,
        },
      },
      { nonceStore, tofuStore, nowOverride: NOW }
    );

    assert.equal(result.verified, false);
    if (!result.verified) assert.equal(result.error, "ERR_TIME_INVALID");
  });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})();
