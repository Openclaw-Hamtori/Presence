/**
 * presence-sdk — Integration Tests
 */

import { strict as assert } from "assert";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { generateKeyPairSync, createSign } from "crypto";
import {
  jcsSerialize,
  sha256Hex,
  deriveIss,
  InMemoryNonceStore,
} from "presence-verifier";
import { PresenceClient } from "../client.js";
import { createCompletionSessionResponse, createLinkedProofRequestResponse, createRecoveryResponse } from "../api.js";
import { InMemoryLinkageStore, FileSystemLinkageStore, LinkageStoreCorruptionError, fileLinkageStorePath } from "../linkage.js";
import { parsePresenceRequest, ParseError } from "../transport.js";
import { createNonce, generateNonce } from "../nonce.js";
import type { PresenceAttestation, ManagedNonceStore } from "../types.js";

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

const NOW = Math.floor(Date.now() / 1000);
const STATE_CREATED = NOW - 3600;
const STATE_VALID_UNTIL = NOW + 68400;

function base64urlEncode(buf: Buffer): string {
  return buf.toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function generateTestKeyPair() {
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

function makeFakeDeviceAttestation() {
  const rawBytes = Buffer.from("fake-device-attestation-for-sdk-integration-test");
  const digest = sha256Hex(rawBytes);
  return { rawBytes, digest };
}

function buildAttestation(
  publicKeyDer: Buffer,
  privateKeyDer: Buffer,
  nonce: string,
  overrides: Partial<Omit<PresenceAttestation, "signature">> = {}
): PresenceAttestation {
  const { digest } = makeFakeDeviceAttestation();
  const iss = deriveIss(publicKeyDer);

  const base: Omit<PresenceAttestation, "signature"> = {
    pol_version: "1.0",
    iss,
    iat: NOW,
    state_created_at: STATE_CREATED,
    state_valid_until: STATE_VALID_UNTIL,
    human: true,
    pass: true,
    signals: ["heart_rate", "steps"],
    nonce,
    device_attestation_digest: digest,
    ...overrides,
  } as Omit<PresenceAttestation, "signature">;

  const canonical = jcsSerialize(base);
  const signer = createSign("SHA256");
  signer.update(Buffer.from(canonical, "utf8"));
  const sigDer = signer.sign({ key: privateKeyDer, format: "der", type: "pkcs8" });
  const signature = base64urlEncode(sigDer);

  return { ...base, signature };
}

function buildAndroidBody(
  attestation: PresenceAttestation,
  publicKeyDer: Buffer,
  deviceBytesOverride?: Buffer,
  includePlatform = false
) {
  const { rawBytes } = makeFakeDeviceAttestation();
  return {
    ...(includePlatform ? { platform: "android" as const } : {}),
    attestation,
    device_attestation: base64urlEncode(deviceBytesOverride ?? rawBytes),
    signing_public_key: base64urlEncode(publicKeyDer),
  };
}

(async () => {
  console.log("\n── presence-sdk Integration ──");

  const keys = generateTestKeyPair();

  await test("generateNonce() returns valid base64url, correct TTL", async () => {
    const nonce = generateNonce();
    assert.ok(/^[A-Za-z0-9_-]+$/.test(nonce.value));
    assert.ok(nonce.value.length >= 22, `nonce too short: ${nonce.value.length} chars`);
    assert.equal(nonce.expiresAt, nonce.issuedAt + 300);
    assert.ok(nonce.issuedAt <= Math.floor(Date.now() / 1000));
  });

  await test("createNonce() returns an unissued nonce description", async () => {
    const nonce = createNonce({ bytes: 32, ttlSeconds: 120 });
    assert.equal(nonce.expiresAt - nonce.issuedAt, 120);
    assert.ok(/^[A-Za-z0-9_-]+$/.test(nonce.value));
  });

  await test("generateNonce() throws when entropy below 16 bytes", async () => {
    assert.throws(() => generateNonce({ bytes: 4 }), /entropy too low/);
  });

  await test("PresenceClient.generateNonce() issues nonce into managed store", async () => {
    const client = new PresenceClient({ silent: true });
    const nonce = client.generateNonce();

    assert.ok(await client.nonceStore.isValid(nonce.value));
    assert.ok(!(await client.nonceStore.isUsed(nonce.value)));
  });

  await test("PresenceClient.generateNonce() uses custom issuable nonceStore when provided", async () => {
    const nonceStore = new InMemoryNonceStore(300) as ManagedNonceStore;
    nonceStore.issue = nonceStore.issue.bind(nonceStore);

    const client = new PresenceClient({ nonceStore, silent: true });
    const nonce = client.generateNonce();

    assert.ok(await nonceStore.isValid(nonce.value));
    assert.ok(!(await client.nonceStore.isUsed(nonce.value)));
  });

  await test("parsePresenceRequest() parses Android format and marks platform explicit", async () => {
    const attestation = buildAttestation(keys.publicKeyDer, keys.privateKeyDer, "dGVzdC1ub25jZS0xMjM0NTY");
    const body = buildAndroidBody(attestation, keys.publicKeyDer, undefined, true);
    const parsed = parsePresenceRequest(body);

    assert.equal(parsed.platform, "android");
    assert.equal(parsed.platformExplicit, true);
    assert.ok(parsed.signingPublicKey instanceof Uint8Array);
    assert.ok(parsed.deviceAttestationRawBytes instanceof Uint8Array);
    assert.deepEqual(parsed.attestation, attestation);
  });

  await test("parsePresenceRequest() parses iOS legacy format and marks platform inferred", async () => {
    const attestation = buildAttestation(keys.publicKeyDer, keys.privateKeyDer, "dGVzdC1ub25jZS0xMjM0NTY");
    const { rawBytes } = makeFakeDeviceAttestation();
    const body = { attestation, device_attestation: base64urlEncode(rawBytes) };
    const parsed = parsePresenceRequest(body);

    assert.equal(parsed.platform, "ios");
    assert.equal(parsed.platformExplicit, false);
    assert.ok(parsed.signingPublicKey === undefined);
  });

  await test("parsePresenceRequest() throws ParseError on missing attestation field", async () => {
    assert.throws(() => parsePresenceRequest({ device_attestation: "dGVzdA" }), ParseError);
  });

  await test("verify() returns ERR_NONCE_INVALID when attestation.nonce ≠ issued nonce", async () => {
    const client = new PresenceClient({ silent: true });
    const issued = client.generateNonce();
    const attestation = buildAttestation(keys.publicKeyDer, keys.privateKeyDer, "ZGlmZmVyZW50Tm9uY2UxMjM");
    const body = buildAndroidBody(attestation, keys.publicKeyDer, undefined, true);

    const result = await client.verify(body, issued.value);
    assert.equal(result.verified, false);
    if (!result.verified) assert.equal(result.error, "ERR_NONCE_INVALID");
  });

  await test("verify() respects requireExplicitPlatform for legacy-inferred requests", async () => {
    const warnings: string[] = [];
    const client = new PresenceClient({
      requireExplicitPlatform: true,
      logger: { warn: (msg) => warnings.push(msg) },
    });
    const nonce = client.generateNonce();
    const attestation = buildAttestation(keys.publicKeyDer, keys.privateKeyDer, nonce.value);
    const body = buildAndroidBody(attestation, keys.publicKeyDer);

    const result = await client.verify(body, nonce.value);
    assert.equal(result.verified, false);
    if (!result.verified) assert.equal(result.error, "ERR_INVALID_FORMAT");
    assert.equal(warnings.some((msg) => msg.includes("Using InMemoryNonceStore")), true);
  });

  await test("verify() returns ERR_NONCE_REUSED when nonce pre-marked used in store", async () => {
    const nonceValue = "dGVzdC1ub25jZS0xMjM0NTY";
    const nonceStore = new InMemoryNonceStore(300);
    nonceStore.issue(nonceValue);
    await nonceStore.markUsed(nonceValue);

    const client = new PresenceClient({ nonceStore, silent: true });
    const attestation = buildAttestation(keys.publicKeyDer, keys.privateKeyDer, nonceValue);
    const body = buildAndroidBody(attestation, keys.publicKeyDer, undefined, true);

    const result = await client.verify(body, nonceValue);
    assert.equal(result.verified, false);
    if (!result.verified) assert.equal(result.error, "ERR_NONCE_REUSED");
  });

  await test("createLinkSession() persists a pending link session with completion URLs", async () => {
    const store = new InMemoryLinkageStore();
    const client = new PresenceClient({ silent: true, linkageStore: store, serviceId: "svc" });
    const { session, nonce } = await client.createLinkSession({ serviceId: "svc", accountId: "acct-1" });

    assert.equal(session.status, "pending");
    assert.equal(typeof nonce, "string");
    assert.equal(session.accountId, "acct-1");
    assert.equal(session.completion?.method, "deeplink");
    assert.ok(session.completion?.qrUrl?.includes(session.id));
    assert.equal(session.completion?.linkedNonceApiUrl, "/presence/linked-accounts/acct-1/nonce");
    assert.equal(session.completion?.verifyLinkedAccountApiUrl, "/presence/linked-accounts/acct-1/verify");
  });

  await test("createCompletionSessionResponse() prefers session completion URLs over contract defaults", async () => {
    const store = new InMemoryLinkageStore();
    const client = new PresenceClient({ silent: true, linkageStore: store, serviceId: "svc" });
    const { session } = await client.createLinkSession({ serviceId: "svc", accountId: "acct-contract" });
    session.completion = {
      ...(session.completion ?? { method: "deeplink" as const }),
      method: "deeplink",
      completionApiUrl: `/custom/sessions/${session.id}/complete`,
      sessionStatusUrl: `/custom/sessions/${session.id}`,
    };

    const response = createCompletionSessionResponse({
      session,
      contract: {
        createSessionPath: "/presence/link-sessions",
        completeSessionPath: "/presence/link-sessions/:sessionId/complete",
        sessionStatusPath: "/presence/link-sessions/:sessionId",
      },
    });

    assert.equal(response.completion.endpoints.complete.path, `/custom/sessions/${session.id}/complete`);
    assert.equal(response.completion.endpoints.status?.path, `/custom/sessions/${session.id}`);
  });

  await test("createLinkedProofRequest() returns active binding + nonce and formats proof-request response", async () => {
    const store = new InMemoryLinkageStore();
    const client = new PresenceClient({ silent: true, linkageStore: store, serviceId: "svc" });
    const now = Math.floor(Date.now() / 1000);
    await store.saveServiceBinding({
      bindingId: "pbind_proof",
      serviceId: "svc",
      accountId: "acct-proof",
      deviceIss: "presence:device:proof",
      createdAt: now,
      updatedAt: now,
      status: "linked",
      lastLinkedAt: now,
      lastVerifiedAt: now,
      lastAttestedAt: now,
    });

    const request = await client.createLinkedProofRequest({ accountId: "acct-proof" });
    assert.equal(request.ok, true);
    if (!request.ok) {
      throw new Error("expected linked proof request");
    }

    const response = createLinkedProofRequestResponse({
      binding: request.binding,
      nonce: request.nonce,
      contract: {
        createSessionPath: "/presence/link-sessions",
        completeSessionPath: "/presence/link-sessions/:sessionId/complete",
        linkedNoncePath: "/presence/linked-accounts/:accountId/nonce",
        verifyLinkedAccountPath: "/presence/linked-accounts/:accountId/verify",
        linkedStatusPath: "/presence/linked-accounts/:accountId/status",
        unlinkAccountPath: "/presence/linked-accounts/:accountId/unlink",
      },
    });

    assert.equal(response.proofRequest.flow, "reauth");
    assert.equal(response.proofRequest.bindingId, "pbind_proof");
    assert.equal(response.proofRequest.nonce, request.nonce.value);
    assert.equal(response.proofRequest.endpoints.verify.path, "/presence/linked-accounts/acct-proof/verify");
    assert.equal(response.proofRequest.endpoints.status?.path, "/presence/linked-accounts/acct-proof/status");
    assert.equal(response.proofRequest.endpoints.unlink?.path, "/presence/linked-accounts/acct-proof/unlink");
  });

  await test("createLinkedProofRequest() reports missing bindings explicitly", async () => {
    const client = new PresenceClient({ silent: true, linkageStore: new InMemoryLinkageStore(), serviceId: "svc" });

    const request = await client.createLinkedProofRequest({ accountId: "acct-missing" });
    assert.equal(request.ok, false);
    if (request.ok) {
      throw new Error("expected unavailable linked proof request");
    }
    assert.equal(request.state, "missing_binding");
    assert.equal(request.binding, null);
    assert.equal(request.reason, "no_linked_binding");
  });

  await test("createLinkedProofRequest() reports recovery state instead of null", async () => {
    const store = new InMemoryLinkageStore();
    const client = new PresenceClient({ silent: true, linkageStore: store, serviceId: "svc" });
    const now = Math.floor(Date.now() / 1000);
    await store.saveServiceBinding({
      bindingId: "pbind_recovery",
      serviceId: "svc",
      accountId: "acct-recovery",
      deviceIss: "presence:device:recovery",
      createdAt: now,
      updatedAt: now,
      status: "recovery_pending",
      lastLinkedAt: now,
      lastVerifiedAt: now,
      lastAttestedAt: now,
      recoveryReason: "binding_mismatch",
    });

    const request = await client.createLinkedProofRequest({ accountId: "acct-recovery" });
    assert.equal(request.ok, false);
    if (request.ok) {
      throw new Error("expected unavailable linked proof request");
    }
    assert.equal(request.state, "recovery_pending");
    assert.equal(request.binding?.bindingId, "pbind_recovery");
    assert.equal(request.reason, "binding_mismatch");
  });

  await test("completeLinkSession() persists Android platform metadata from parsed request", async () => {
    const store = new InMemoryLinkageStore();
    const client = new PresenceClient({ silent: true, linkageStore: store, serviceId: "svc" });
    const { session } = await client.createLinkSession({ serviceId: "svc", accountId: "acct-android" });
    const attestation = buildAttestation(keys.publicKeyDer, keys.privateKeyDer, session.issuedNonce);
    const body = buildAndroidBody(attestation, keys.publicKeyDer, undefined, true);
    const iss = deriveIss(keys.publicKeyDer);
    const verifyStub = async () => ({
      verified: true as const,
      pol_version: "1.0",
      iss,
      iat: NOW,
      state_created_at: STATE_CREATED,
      state_valid_until: STATE_VALID_UNTIL,
      human: true as const,
      pass: true as const,
      signals: ["heart_rate", "steps"] as const,
      nonce: session.issuedNonce,
    });
    (client as unknown as { verify: typeof verifyStub }).verify = verifyStub;

    const result = await client.completeLinkSession({ sessionId: session.id, body });
    assert.equal(result.verification.verified, true);
    const device = await store.getLinkedDevice(iss);
    assert.equal(device?.platform, "android");
    const binding = await store.getServiceBinding("svc", "acct-android");
    assert.equal(binding?.lastSnapshot?.stateCreatedAt, STATE_CREATED);
    assert.equal(binding?.lastSnapshot?.stateValidUntil, STATE_VALID_UNTIL);
  });

  await test("createRecoveryResponse() preserves recovery session completion metadata", async () => {
    const now = Math.floor(Date.now() / 1000);
    const response = createRecoveryResponse({
      verified: false,
      error: "ERR_BINDING_RECOVERY_REQUIRED",
      detail: "binding mismatch",
      binding: {
        bindingId: "pbind_recover",
        serviceId: "svc",
        accountId: "acct-5",
        deviceIss: "presence:device:expected",
        createdAt: now,
        updatedAt: now,
        status: "recovery_pending",
        lastLinkedAt: now,
        lastVerifiedAt: now,
        lastAttestedAt: now,
        recoveryReason: "binding_mismatch",
      },
      expectedDeviceIss: "presence:device:expected",
      actualDeviceIss: "presence:device:actual",
      recoveryAction: "relink",
      recoverySession: {
        id: "plink_recover",
        serviceId: "svc",
        accountId: "acct-5",
        issuedNonce: "nonce",
        requestedAt: now,
        expiresAt: now + 300,
        status: "pending",
        relinkOfBindingId: "pbind_recover",
        recoveryReason: "binding_mismatch",
        completion: {
          method: "deeplink",
          completionApiUrl: "/custom/recovery/complete",
          sessionStatusUrl: "/custom/recovery/status",
        },
      },
    });

    assert.equal(response.recovery.relinkSession?.endpoints.complete.path, "/custom/recovery/complete");
    assert.equal(response.recovery.relinkSession?.endpoints.status?.path, "/custom/recovery/status");
    assert.equal(response.recovery.relinkSession?.flow, "relink");
  });

  await test("unlinkAccount() marks an active binding as unlinked and writes audit log", async () => {
    const store = new InMemoryLinkageStore();
    const client = new PresenceClient({ silent: true, linkageStore: store, serviceId: "svc" });
    const now = Math.floor(Date.now() / 1000);
    await store.saveServiceBinding({
      bindingId: "pbind_1",
      serviceId: "svc",
      accountId: "acct-2",
      deviceIss: "presence:device:test",
      createdAt: now,
      updatedAt: now,
      status: "linked",
      lastLinkedAt: now,
      lastVerifiedAt: now,
      lastAttestedAt: now,
    });

    const result = await client.unlinkAccount({ accountId: "acct-2", reason: "user_requested" });
    assert.ok(result);
    assert.equal(result?.binding.status, "unlinked");

    const auditEvents = await client.listAuditEvents({ serviceId: "svc", accountId: "acct-2" });
    assert.equal(auditEvents.some((event) => event.type === "binding_unlinked"), true);
  });

  await test("revokeDevice() revokes all bindings on the device", async () => {
    const store = new InMemoryLinkageStore();
    const client = new PresenceClient({ silent: true, linkageStore: store, serviceId: "svc" });
    const now = Math.floor(Date.now() / 1000);
    await store.saveLinkedDevice({
      iss: "presence:device:revoked",
      platform: "ios",
      firstLinkedAt: now,
      lastVerifiedAt: now,
      lastAttestedAt: now,
      trustState: "active",
    });
    await store.saveServiceBinding({
      bindingId: "pbind_revoke",
      serviceId: "svc",
      accountId: "acct-3",
      deviceIss: "presence:device:revoked",
      createdAt: now,
      updatedAt: now,
      status: "linked",
      lastLinkedAt: now,
      lastVerifiedAt: now,
      lastAttestedAt: now,
    });

    const events = await client.revokeDevice({ deviceIss: "presence:device:revoked", reason: "fraud_review" });
    assert.equal(events.length, 1);
    const binding = await store.getServiceBinding("svc", "acct-3");
    assert.equal(binding?.status, "revoked");
  });

  await test("verifyLinkedAccount() returns recovery guidance on binding mismatch", async () => {
    const store = new InMemoryLinkageStore();
    const client = new PresenceClient({
      silent: true,
      linkageStore: store,
      serviceId: "svc",
      bindingPolicy: { allowReplacementOnMismatch: true },
    });
    const now = Math.floor(Date.now() / 1000);
    await store.saveServiceBinding({
      bindingId: "pbind_recover",
      serviceId: "svc",
      accountId: "acct-4",
      deviceIss: "presence:device:expected",
      createdAt: now,
      updatedAt: now,
      status: "linked",
      lastLinkedAt: now,
      lastVerifiedAt: now,
      lastAttestedAt: now,
    });

    const verifyStub = async () => ({
      verified: true as const,
      iss: "presence:device:actual",
      iat: now,
      state_created_at: now - 60,
      state_valid_until: now + 300,
      human: true,
      pass: true,
      signals: ["heart_rate"] as const,
    });
    (client as unknown as { verify: typeof verifyStub }).verify = verifyStub;

    const result = await client.verifyLinkedAccount({}, { accountId: "acct-4", nonce: "n" });
    assert.equal(result.verified, false);
    if (!result.verified && result.error === "ERR_BINDING_RECOVERY_REQUIRED") {
      assert.equal(result.recoveryAction, "relink");
      assert.ok(result.recoverySession?.id);
    }
  });

  await test("getLinkedAccountReadiness() rejects expired linked snapshots", async () => {
    const store = new InMemoryLinkageStore();
    const client = new PresenceClient({ silent: true, linkageStore: store, serviceId: "svc" });
    const now = Math.floor(Date.now() / 1000);
    await store.saveServiceBinding({
      bindingId: "pbind_expired",
      serviceId: "svc",
      accountId: "acct-expired",
      deviceIss: "presence:device:expired",
      createdAt: now - 600,
      updatedAt: now - 60,
      status: "linked",
      lastLinkedAt: now - 600,
      lastVerifiedAt: now - 60,
      lastAttestedAt: now - 60,
      lastSnapshot: {
        deviceIss: "presence:device:expired",
        capturedAt: now - 60,
        attestedAt: now - 60,
        stateCreatedAt: now - 600,
        stateValidUntil: now - 1,
        human: true,
        pass: true,
        signals: ["heart_rate", "steps"],
        source: "verified_proof",
      },
    });

    const readiness = await client.getLinkedAccountReadiness({ accountId: "acct-expired", now });
    assert.equal(readiness.ready, false);
    assert.equal(readiness.state, "stale");
    assert.equal(readiness.reason, "snapshot_expired_grace");
  });

  await test("getLinkedAccountReadiness() degrades from the last successful PASS snapshot", async () => {
    const store = new InMemoryLinkageStore();
    const client = new PresenceClient({ silent: true, linkageStore: store, serviceId: "svc" });
    const now = Math.floor(Date.now() / 1000);
    await store.saveServiceBinding({
      bindingId: "pbind_not_ready",
      serviceId: "svc",
      accountId: "acct-not-ready",
      deviceIss: "presence:device:not-ready",
      createdAt: now - 600,
      updatedAt: now - 60,
      status: "linked",
      lastLinkedAt: now - 600,
      lastVerifiedAt: now - 60,
      lastAttestedAt: now - 60,
      lastSnapshot: {
        deviceIss: "presence:device:not-ready",
        capturedAt: now - 60,
        attestedAt: now - 60,
        stateCreatedAt: now - 600,
        stateValidUntil: now - 300,
        human: true,
        pass: true,
        signals: ["heart_rate", "steps"],
        source: "verified_proof",
      },
    });

    const readiness = await client.getLinkedAccountReadiness({ accountId: "acct-not-ready", now });
    assert.equal(readiness.ready, false);
    assert.equal(readiness.state, "stale");
    assert.equal(readiness.reason, "snapshot_expired_grace");

    const beyondGrace = await client.getLinkedAccountReadiness({
      accountId: "acct-not-ready",
      now: now + 1201,
    });
    assert.equal(beyondGrace.ready, false);
    assert.equal(beyondGrace.state, "not_ready");
    assert.equal(beyondGrace.reason, "snapshot_expired");
  });

  await test("FileSystemLinkageStore persists bindings to disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "presence-sdk-"));
    const storePath = fileLinkageStorePath(dir);
    const store = new FileSystemLinkageStore(storePath);
    const now = Math.floor(Date.now() / 1000);
    await store.saveServiceBinding({
      bindingId: "pbind_file",
      serviceId: "svc",
      accountId: "acct-5",
      deviceIss: "presence:device:file",
      createdAt: now,
      updatedAt: now,
      status: "linked",
      lastLinkedAt: now,
      lastVerifiedAt: now,
      lastAttestedAt: now,
    });

    assert.equal(existsSync(storePath), true);
    const raw = JSON.parse(readFileSync(storePath, "utf8"));
    assert.ok(raw.bindings["svc:acct-5"]);
  });

  await test("FileSystemLinkageStore fails closed on corrupted JSON instead of rewriting an empty store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "presence-sdk-"));
    const storePath = fileLinkageStorePath(dir);
    const now = Math.floor(Date.now() / 1000);
    const corrupted = `${JSON.stringify({
      sessions: {},
      bindings: {
        "svc:acct-corrupt": {
          bindingId: "pbind_corrupt",
          serviceId: "svc",
          accountId: "acct-corrupt",
          deviceIss: "presence:device:corrupt",
          createdAt: now,
          updatedAt: now,
          status: "linked",
          lastLinkedAt: now,
          lastVerifiedAt: now,
          lastAttestedAt: now,
        },
      },
      devices: {
        "presence:device:corrupt": {
          iss: "presence:device:corrupt",
          platform: "android",
          firstLinkedAt: now,
          lastVerifiedAt: now,
          lastAttestedAt: now,
          trustState: "active",
        },
      },
      auditEvents: [],
    }, null, 2)}774086508,`;
    writeFileSync(storePath, corrupted, "utf8");

    const store = new FileSystemLinkageStore(storePath);
    await assert.rejects(
      () => store.appendAuditEvent({
        eventId: "paudit_corrupt",
        type: "reauth_succeeded",
        serviceId: "svc",
        accountId: "acct-corrupt",
        bindingId: "pbind_corrupt",
        deviceIss: "presence:device:corrupt",
        occurredAt: now,
      }),
      (error: unknown) => {
        assert.ok(error instanceof LinkageStoreCorruptionError);
        return true;
      }
    );
    assert.equal(readFileSync(storePath, "utf8"), corrupted);
  });

  await test("FileSystemLinkageStore serializes cross-instance mutations against the same file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "presence-sdk-"));
    const storePath = fileLinkageStorePath(dir);
    const slowStore = new FileSystemLinkageStore(storePath) as unknown as {
      mutate<T>(mutator: (store: unknown) => Promise<T>): Promise<T>;
      writeData(data: unknown): Promise<void>;
    };
    const fastStore = new FileSystemLinkageStore(storePath);
    const originalWriteData = slowStore.writeData.bind(slowStore);
    let releaseSlowWrite!: () => void;
    let signalSlowWriteStarted!: () => void;
    const slowWriteStarted = new Promise<void>((resolve) => {
      signalSlowWriteStarted = resolve;
    });
    const slowWriteGate = new Promise<void>((resolve) => {
      releaseSlowWrite = resolve;
    });

    slowStore.writeData = async (data) => {
      signalSlowWriteStarted();
      await slowWriteGate;
      await originalWriteData(data);
    };

    const now = Math.floor(Date.now() / 1000);
    const slowMutation = slowStore.mutate(async (store) => {
      const tx = store as {
        saveServiceBinding(binding: unknown): Promise<void>;
        appendAuditEvent(event: unknown): Promise<void>;
      };
      await tx.saveServiceBinding({
        bindingId: "pbind_serialized",
        serviceId: "svc",
        accountId: "acct-serialized",
        deviceIss: "presence:device:serialized",
        createdAt: now,
        updatedAt: now,
        status: "linked",
        lastLinkedAt: now,
        lastVerifiedAt: now,
        lastAttestedAt: now,
      });
      await tx.appendAuditEvent({
        eventId: "paudit_slow",
        type: "link_completed",
        serviceId: "svc",
        accountId: "acct-serialized",
        bindingId: "pbind_serialized",
        deviceIss: "presence:device:serialized",
        occurredAt: now,
      });
    });

    await slowWriteStarted;

    const fastMutation = fastStore.mutate(async (store) => {
      const tx = store as {
        saveLinkedDevice(device: unknown): Promise<void>;
        saveLinkSession(session: unknown): Promise<void>;
        appendAuditEvent(event: unknown): Promise<void>;
      };
      await tx.saveLinkedDevice({
        iss: "presence:device:serialized",
        platform: "android",
        firstLinkedAt: now,
        lastVerifiedAt: now,
        lastAttestedAt: now,
        trustState: "active",
      });
      await tx.saveLinkSession({
        id: "plink_serialized",
        serviceId: "svc",
        accountId: "acct-serialized",
        issuedNonce: "nonce_serialized",
        requestedAt: now,
        expiresAt: now + 300,
        status: "pending",
      });
      await tx.appendAuditEvent({
        eventId: "paudit_fast",
        type: "link_started",
        serviceId: "svc",
        accountId: "acct-serialized",
        occurredAt: now,
      });
    });

    releaseSlowWrite();
    await Promise.all([slowMutation, fastMutation]);

    const raw = JSON.parse(readFileSync(storePath, "utf8"));
    assert.ok(raw.sessions.plink_serialized);
    assert.ok(raw.bindings["svc:acct-serialized"]);
    assert.ok(raw.devices["presence:device:serialized"]);
    assert.equal(raw.auditEvents.length, 2);
  });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})();
