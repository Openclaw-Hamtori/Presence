import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { generateKeyPairSync, createSign } from "crypto";
import {
  PresenceClient,
  FileSystemLinkageStore,
  fileLinkageStorePath,
} from "../dist/index.js";
import { jcsSerialize, sha256Hex, deriveIss } from "presence-verifier";

function base64urlEncode(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function generateTestKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  return {
    privateKeyDer: privateKey,
    publicKeyDer: publicKey,
  };
}

function makeFakeDeviceAttestation() {
  const rawBytes = Buffer.from("fake-device-attestation-for-local-harness");
  return {
    rawBytes,
    digest: sha256Hex(rawBytes),
  };
}

function buildAttestation(publicKeyDer, privateKeyDer, nonce) {
  const now = Math.floor(Date.now() / 1000);
  const { digest } = makeFakeDeviceAttestation();
  const base = {
    pol_version: "1.0",
    iss: deriveIss(publicKeyDer),
    iat: now,
    state_created_at: now - 60,
    state_valid_until: now + 600,
    human: true,
    pass: true,
    signals: ["heart_rate", "steps"],
    nonce,
    device_attestation_digest: digest,
  };

  const canonical = jcsSerialize(base);
  const signer = createSign("SHA256");
  signer.update(Buffer.from(canonical, "utf8"));
  const signature = base64urlEncode(
    signer.sign({ key: privateKeyDer, format: "der", type: "pkcs8" })
  );

  return { ...base, signature };
}

function buildAndroidBody(attestation, publicKeyDer) {
  const { rawBytes } = makeFakeDeviceAttestation();
  return {
    platform: "android",
    attestation,
    device_attestation: base64urlEncode(rawBytes),
    signing_public_key: base64urlEncode(publicKeyDer),
  };
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), "presence-linked-auth-"));
  const storePath = fileLinkageStorePath(root);
  const store = new FileSystemLinkageStore(storePath);
  const client = new PresenceClient({
    silent: true,
    serviceId: "demo-service",
    linkageStore: store,
    bindingPolicy: { allowReplacementOnMismatch: true },
  });

  const deviceA = generateTestKeyPair();
  const deviceB = generateTestKeyPair();

  const { session, nonce } = await client.createLinkSession({
    serviceId: "demo-service",
    accountId: "acct-local-1",
    metadata: { harness: true },
  });

  const realAndroidProof = buildAndroidBody(
    buildAttestation(deviceA.publicKeyDer, deviceA.privateKeyDer, nonce),
    deviceA.publicKeyDer
  );

  const realVerify = await client.verify(realAndroidProof, nonce);

  const originalVerify = client.verify.bind(client);
  client.verify = async (_body, expectedNonce) => ({
    verified: true,
    pol_version: "1.0",
    iss: deriveIss(deviceA.publicKeyDer),
    iat: Math.floor(Date.now() / 1000),
    state_created_at: Math.floor(Date.now() / 1000) - 60,
    state_valid_until: Math.floor(Date.now() / 1000) + 600,
    human: true,
    pass: true,
    signals: ["heart_rate", "steps"],
    nonce: expectedNonce,
  });

  const completion = await client.completeLinkSession({
    sessionId: session.id,
    body: realAndroidProof,
  });

  const reauthRequest = await client.createLinkedProofRequest({
    accountId: "acct-local-1",
  });
  if (!reauthRequest.ok) {
    throw new Error(`expected linked proof request for acct-local-1, got ${reauthRequest.state}`);
  }
  const reauthNonce = reauthRequest.nonce.value;
  const linkedVerify = await client.verifyLinkedAccount(realAndroidProof, {
    accountId: "acct-local-1",
    nonce: reauthNonce,
  });

  client.verify = async (_body, expectedNonce) => ({
    verified: true,
    pol_version: "1.0",
    iss: deriveIss(deviceB.publicKeyDer),
    iat: Math.floor(Date.now() / 1000),
    state_created_at: Math.floor(Date.now() / 1000) - 60,
    state_valid_until: Math.floor(Date.now() / 1000) + 600,
    human: true,
    pass: true,
    signals: ["heart_rate", "steps"],
    nonce: expectedNonce,
  });

  const mismatchRequest = await client.createLinkedProofRequest({
    accountId: "acct-local-1",
  });
  if (!mismatchRequest.ok) {
    throw new Error(`expected mismatch proof request for acct-local-1, got ${mismatchRequest.state}`);
  }
  const mismatchNonce = mismatchRequest.nonce.value;
  const mismatch = await client.verifyLinkedAccount(realAndroidProof, {
    accountId: "acct-local-1",
    nonce: mismatchNonce,
  });

  client.verify = originalVerify;

  const auditEvents = await client.listAuditEvents({
    serviceId: "demo-service",
    accountId: "acct-local-1",
  });

  console.log(JSON.stringify({
    realVerify,
    completion: {
      verified: completion.verification.verified,
      sessionStatus: completion.session.status,
      bindingId: completion.binding?.bindingId,
      deviceIss: completion.binding?.deviceIss,
    },
    linkedVerify: linkedVerify.verified
      ? {
          verified: true,
          bindingStatus: linkedVerify.binding.status,
          deviceIss: linkedVerify.binding.deviceIss,
        }
      : linkedVerify,
    mismatch: mismatch.verified
      ? mismatch
      : {
          verified: false,
          error: mismatch.error,
          recoveryAction: mismatch.recoveryAction,
          expectedDeviceIss: mismatch.expectedDeviceIss,
          actualDeviceIss: mismatch.actualDeviceIss,
          recoverySessionId: mismatch.recoverySession?.id,
          bindingStatus: mismatch.binding?.status,
        },
    auditEventTypes: auditEvents.map((event) => event.type),
    storePath,
  }, null, 2));

  // keep the temp store around for inspection on success
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
