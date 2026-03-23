/**
 * presence-sdk — Integration Tests
 */

import { strict as assert } from "assert";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "fs";
import Database from "better-sqlite3";
import { tmpdir } from "os";
import { join } from "path";
import { generateKeyPairSync, createSign } from "crypto";
import {
  jcsSerialize,
  sha256Hex,
  deriveIss,
  InMemoryNonceStore,
  SqliteTofuStore,
} from "presence-verifier";
import { PresenceClient } from "../client.js";
import {
  createCompletionSessionResponse,
  createLinkedProofRequestResponse,
  createPendingProofRequestResponse,
  createPendingProofRequestListResponse,
  createRecoveryResponse,
  rewriteLinkSessionForPublicBase,
} from "../api.js";
import { InMemoryLinkageStore, FileSystemLinkageStore, LinkageStoreCorruptionError, fileLinkageStorePath } from "../linkage.js";
import { SqliteLinkageStore, SqlitePersistedNonceStore } from "../sqlite-store.js";
import { parsePresenceRequest, ParseError } from "../transport.js";
import { createNonce, generateNonce } from "../nonce.js";
import { LinkageStoreNonceResolver } from "../nonce-rehydration.js";
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

  await test("PresenceClient auto-configures SqliteTofuStore from sqlite linkageStore", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "presence-sqlite-tofu-auto-"));
    const dbPath = join(dbDir, "presence-linkage.db");
    const store = new SqliteLinkageStore({ dbPath, mode: "single-team" });

    try {
      const client = new PresenceClient({ silent: true, linkageStore: store, serviceId: "svc" });
      const resolved = (client as unknown as { tofuStore?: unknown }).tofuStore;
      assert.ok(resolved instanceof SqliteTofuStore, "expected SqliteTofuStore instance for sqlite linkage");
    } finally {
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  await test("SqliteLinkageStore creates and records schema migration version", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "presence-sqlite-migration-version-"));
    const dbPath = join(dbDir, "presence-linkage.db");

    try {
      new SqliteLinkageStore({ dbPath, mode: "single-team" });

      const db = new Database(dbPath);
      const migrationRow = db.prepare("SELECT version FROM _schema_migrations ORDER BY version DESC LIMIT 1").get() as
        | { version: number }
        | undefined;
      assert.ok(migrationRow, "expected schema migration row");
      assert.equal(migrationRow.version, 1);
      db.close();
    } finally {
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  await test("LinkageStoreNonceResolver returns issue time for active pending proof request", async () => {
    const store = new InMemoryLinkageStore();
    const now = Math.floor(Date.now() / 1000);
    const serviceId = "svc";
    const accountId = "acct-resolver";
    const nonce = "resolver-nonce";

    await store.savePendingProofRequest({
      id: "ppreq-resolver",
      serviceId,
      accountId,
      bindingId: "bind-1",
      deviceIss: "presence:device:1",
      nonce,
      requestedAt: now - 1,
      expiresAt: now + 60,
      status: "pending",
    });

    const resolver = new LinkageStoreNonceResolver(store);
    const issuedAt = await resolver.resolvePendingProofNonceIssueTime({
      serviceId,
      accountId,
      nonce,
      now,
    });
    assert.equal(issuedAt, now - 1);
  });

  await test("LinkageStoreNonceResolver returns issued time for active link-session", async () => {
    const store = new InMemoryLinkageStore();
    const now = Math.floor(Date.now() / 1000);
    await store.saveLinkSession({
      id: "plink-1",
      serviceId: "svc",
      accountId: "acct-link-session",
      issuedNonce: "link-session-nonce",
      requestedAt: now - 2,
      expiresAt: now + 60,
      status: "pending",
    });

    const resolver = new LinkageStoreNonceResolver(store);
    const issuedAt = await resolver.resolveLinkSessionIssueTime({
      sessionId: "plink-1",
      now,
    });
    assert.equal(issuedAt, now - 2);
  });

  await test("LinkageStoreNonceResolver ignores expired pending proof nonces", async () => {
    const store = new InMemoryLinkageStore();
    const now = Math.floor(Date.now() / 1000);
    const serviceId = "svc";
    const accountId = "acct-resolver-expired";

    await store.savePendingProofRequest({
      id: "ppreq-expired",
      serviceId,
      accountId,
      bindingId: "bind-1",
      deviceIss: "presence:device:1",
      nonce: "expired-nonce",
      requestedAt: now - 120,
      expiresAt: now - 10,
      status: "pending",
    });

    const resolver = new LinkageStoreNonceResolver(store);
    const issuedAt = await resolver.resolvePendingProofNonceIssueTime({
      serviceId,
      accountId,
      nonce: "expired-nonce",
      now,
    });
    assert.equal(issuedAt, null);
  });

  await test("SqlitePersistedNonceStore resolves pending and link-session nonce issue time", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "presence-sqlite-persisted-nonce-"));
    const dbPath = join(dbDir, "presence-linkage.db");
    const linkageStore = new SqliteLinkageStore({ dbPath, mode: "single-team" });
    const persistedNonceStore = new SqlitePersistedNonceStore({ dbPath, mode: "single-team" });
    const now = Math.floor(Date.now() / 1000);

    try {
      await linkageStore.savePendingProofRequest({
        id: "ppreq-sqlite-resolve",
        serviceId: "svc",
        accountId: "acct-sqlite-resolver",
        bindingId: "bind-1",
        deviceIss: "presence:device:1",
        nonce: "sqlite-pending-nonce",
        requestedAt: now - 4,
        expiresAt: now + 40,
        status: "pending",
      });

      const issuedAtPending = await persistedNonceStore.resolvePendingProofNonceIssueTime({
        serviceId: "svc",
        accountId: "acct-sqlite-resolver",
        nonce: "sqlite-pending-nonce",
        now,
      });
      assert.equal(issuedAtPending, now - 4);

      await linkageStore.saveLinkSession({
        id: "plink-sqlite-resolve",
        serviceId: "svc",
        accountId: "acct-sqlite-resolver",
        issuedNonce: "sqlite-session-nonce",
        requestedAt: now - 9,
        expiresAt: now + 40,
        status: "pending",
      });

      const issuedAtSession = await persistedNonceStore.resolveLinkSessionIssueTime({
        sessionId: "plink-sqlite-resolve",
        now,
      });
      assert.equal(issuedAtSession, now - 9);
    } finally {
      persistedNonceStore.close();
      linkageStore.close();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  await test("SqlitePersistedNonceStore sweepExpiredNonces() expires stale nonce-bearing rows", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "presence-sqlite-nonce-sweep-"));
    const dbPath = join(dbDir, "presence-linkage.db");
    const linkageStore = new SqliteLinkageStore({ dbPath, mode: "single-team" });
    const persistedNonceStore = new SqlitePersistedNonceStore({ dbPath, mode: "single-team" });
    const now = Math.floor(Date.now() / 1000);

    try {
      await linkageStore.savePendingProofRequest({
        id: "ppreq-sqlite-sweep-expired",
        serviceId: "svc",
        accountId: "acct-sweep",
        bindingId: "bind-sweep",
        deviceIss: "presence:device:sweep",
        nonce: "sweep-expired-nonce",
        requestedAt: now - 120,
        expiresAt: now - 60,
        status: "pending",
      });
      await linkageStore.savePendingProofRequest({
        id: "ppreq-sqlite-sweep-active",
        serviceId: "svc",
        accountId: "acct-sweep",
        bindingId: "bind-sweep",
        deviceIss: "presence:device:sweep",
        nonce: "sweep-active-nonce",
        requestedAt: now,
        expiresAt: now + 120,
        status: "pending",
      });
      await linkageStore.saveLinkSession({
        id: "plink-sqlite-sweep-expired",
        serviceId: "svc",
        accountId: "acct-sweep",
        issuedNonce: "sqlite-sweep-expired",
        requestedAt: now - 120,
        expiresAt: now - 60,
        status: "pending",
      });
      await linkageStore.saveLinkSession({
        id: "plink-sqlite-sweep-active",
        serviceId: "svc",
        accountId: "acct-sweep",
        issuedNonce: "sqlite-sweep-active",
        requestedAt: now,
        expiresAt: now + 120,
        status: "pending",
      });

      const sweep = await persistedNonceStore.sweepExpiredNonces({ now });
      assert.equal(sweep.linkSessionsExpired, 1);
      assert.equal(sweep.pendingProofRequestsExpired, 1);
      assert.equal(sweep.totalExpired, 2);

      const expiredRequest = await linkageStore.getPendingProofRequest("ppreq-sqlite-sweep-expired");
      const activeRequest = await linkageStore.getPendingProofRequest("ppreq-sqlite-sweep-active");
      const expiredSession = await linkageStore.getLinkSession("plink-sqlite-sweep-expired");
      const activeSession = await linkageStore.getLinkSession("plink-sqlite-sweep-active");

      assert.equal(expiredRequest?.status, "expired");
      assert.equal(activeRequest?.status, "pending");
      assert.equal(expiredSession?.status, "expired");
      assert.equal(activeSession?.status, "pending");
    } finally {
      persistedNonceStore.close();
      linkageStore.close();
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  await test("LinkageStoreNonceResolver sweepExpiredNonces() is a no-op", async () => {
    const store = new InMemoryLinkageStore();
    const resolver = new LinkageStoreNonceResolver(store);

    const result = await resolver.sweepExpiredNonces();
    assert.equal(result.linkSessionsExpired, 0);
    assert.equal(result.pendingProofRequestsExpired, 0);
    assert.equal(result.totalExpired, 0);
  });

  await test("cleanupPersistedNonces() reports in-memory and persisted nonce expiration counts", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "presence-sqlite-maintenance-"));
    const dbPath = join(dbDir, "presence-linkage.db");
    const linkageStore = new SqliteLinkageStore({ dbPath, mode: "single-team" });
    const client = new PresenceClient({
      linkageStore,
      silent: true,
      nonceTtlSeconds: 300,
      serviceId: "svc",
    });

    const now = Math.floor(Date.now() / 1000);

    try {
      client.issueNonce("expired-memory-nonce", now - 500);
      client.issueNonce("fresh-memory-nonce", now);

      await linkageStore.savePendingProofRequest({
        id: "ppreq-maintenance-expired",
        serviceId: "svc",
        accountId: "acct-maintenance",
        bindingId: "bind-maintenance",
        deviceIss: "presence:device:maintenance",
        nonce: "maintenance-expired-nonce",
        requestedAt: now - 500,
        expiresAt: now - 20,
        status: "pending",
      });

      await linkageStore.savePendingProofRequest({
        id: "ppreq-maintenance-active",
        serviceId: "svc",
        accountId: "acct-maintenance",
        bindingId: "bind-maintenance",
        deviceIss: "presence:device:maintenance",
        nonce: "maintenance-active-nonce",
        requestedAt: now,
        expiresAt: now + 120,
        status: "pending",
      });

      await linkageStore.saveLinkSession({
        id: "plink-maintenance-expired",
        serviceId: "svc",
        accountId: "acct-maintenance",
        issuedNonce: "plink-expired-nonce",
        requestedAt: now - 500,
        expiresAt: now - 20,
        status: "pending",
      });

      await linkageStore.saveLinkSession({
        id: "plink-maintenance-active",
        serviceId: "svc",
        accountId: "acct-maintenance",
        issuedNonce: "plink-active-nonce",
        requestedAt: now,
        expiresAt: now + 120,
        status: "pending",
      });

      const report = await client.cleanupPersistedNonces({ now });

      assert.equal(report.inMemoryNoncesExpired, 1);
      assert.equal(report.persistedExpired.linkSessionsExpired, 1);
      assert.equal(report.persistedExpired.pendingProofRequestsExpired, 1);
      assert.equal(report.persistedExpired.totalExpired, 2);
      assert.equal(report.totalExpired, 3);

      const expiredProofRequest = await linkageStore.getPendingProofRequest("ppreq-maintenance-expired");
      const activeProofRequest = await linkageStore.getPendingProofRequest("ppreq-maintenance-active");
      const expiredSession = await linkageStore.getLinkSession("plink-maintenance-expired");
      const activeSession = await linkageStore.getLinkSession("plink-maintenance-active");
      assert.equal(expiredProofRequest?.status, "expired");
      assert.equal(activeProofRequest?.status, "pending");
      assert.equal(expiredSession?.status, "expired");
      assert.equal(activeSession?.status, "pending");
    } finally {
      linkageStore.close();
      rmSync(dbDir, { recursive: true, force: true });
    }
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

  await test("sqlite-backed LinkageStore persists createLinkSession() and reads session via same store", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "presence-sqlite-link-session-"));
    const store = new SqliteLinkageStore({
      dbPath: join(dbDir, "presence-linkage.db"),
      mode: "single-team",
      journalMode: "WAL",
    });

    try {
      const client = new PresenceClient({ silent: true, linkageStore: store, serviceId: "svc" });
      const { session } = await client.createLinkSession({
        serviceId: "svc",
        accountId: "acct-sqlite",
        metadata: { source: "sqlite-test" },
      });

      const persisted = await store.getLinkSession(session.id);
      if (!persisted) {
        throw new Error("expected persisted session");
      }

      assert.equal(persisted.status, "pending");
      assert.equal(persisted.accountId, "acct-sqlite");
      assert.equal(persisted.serviceId, "svc");
      assert.equal(persisted.metadata?.source, "sqlite-test");

      const auditEvents = await store.listAuditEvents({ serviceId: "svc", accountId: "acct-sqlite" });
      assert.equal(auditEvents.some((event) => event.type === "link_started"), true);
    } finally {
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  await test("sqlite-backed completeLinkSession() writes binding/device and consumes session in one flow", async () => {
    // Small-team/single-node SQLite-first assumption is explicit in test setup.
    const dbDir = mkdtempSync(join(tmpdir(), "presence-sqlite-complete-"));
    const store = new SqliteLinkageStore({ dbPath: join(dbDir, "presence-linkage.db"), mode: "single-team" });
    const client = new PresenceClient({ silent: true, linkageStore: store, serviceId: "svc" });

    try {
      const { session } = await client.createLinkSession({ serviceId: "svc", accountId: "acct-sqlite-complete" });
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
      assert.equal(result.session.status, "consumed");

      const persistedSession = await store.getLinkSession(session.id);
      if (!persistedSession) {
        throw new Error("expected completed session");
      }
      assert.equal(persistedSession.status, "consumed");
      assert.ok(persistedSession.completedAt);

      const device = await store.getLinkedDevice(iss);
      assert.equal(device?.platform, "android");

      const binding = await store.getServiceBinding("svc", "acct-sqlite-complete");
      assert.equal(binding?.deviceIss, iss);
      assert.equal(binding?.lastSnapshot?.stateValidUntil, STATE_VALID_UNTIL);

      const auditEvents = await store.listAuditEvents({ serviceId: "svc", accountId: "acct-sqlite-complete" });
      assert.equal(auditEvents.some((event) => event.type === "link_completed"), true);
    } finally {
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  await test("sqlite-backed listAuditEvents() filters by service/account/binding", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "presence-sqlite-audit-filter-"));
    const store = new SqliteLinkageStore({
      dbPath: join(dbDir, "presence-linkage.db"),
      mode: "single-team",
    });
    const now = Math.floor(Date.now() / 1000);

    try {
      await store.appendAuditEvent({
        eventId: "evt-1",
        type: "link_started",
        serviceId: "svc-a",
        accountId: "acct-1",
        bindingId: "bind-a",
        occurredAt: now + 1,
      });
      await store.appendAuditEvent({
        eventId: "evt-2",
        type: "link_started",
        serviceId: "svc-a",
        accountId: "acct-2",
        bindingId: "bind-b",
        occurredAt: now + 2,
      });
      await store.appendAuditEvent({
        eventId: "evt-3",
        type: "link_completed",
        serviceId: "svc-b",
        accountId: "acct-1",
        bindingId: "bind-a",
        occurredAt: now + 3,
      });
      await store.appendAuditEvent({
        eventId: "evt-4",
        type: "binding_unlinked",
        serviceId: "svc-b",
        accountId: "acct-1",
        occurredAt: now + 4,
      });

      const all = await store.listAuditEvents();
      assert.equal(all.length, 4);

      const byService = await store.listAuditEvents({ serviceId: "svc-a" });
      assert.deepEqual(byService.map((event) => event.eventId).sort(), ["evt-1", "evt-2"]);

      const byAccount = await store.listAuditEvents({ accountId: "acct-1" });
      assert.deepEqual(byAccount.map((event) => event.eventId).sort(), ["evt-1", "evt-3", "evt-4"]);

      const byBinding = await store.listAuditEvents({ bindingId: "bind-a" });
      assert.deepEqual(byBinding.map((event) => event.eventId).sort(), ["evt-1", "evt-3"]);

      const byServiceAndBinding = await store.listAuditEvents({ serviceId: "svc-a", bindingId: "bind-b" });
      assert.deepEqual(byServiceAndBinding.map((event) => event.eventId), ["evt-2"]);

      const byServiceAndAccount = await store.listAuditEvents({ serviceId: "svc-b", accountId: "acct-2" });
      assert.equal(byServiceAndAccount.length, 0);
    } finally {
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  await test("sqlite-backed listAuditEvents() supports simple pagination", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "presence-sqlite-audit-pagination-"));
    const store = new SqliteLinkageStore({
      dbPath: join(dbDir, "presence-linkage.db"),
      mode: "single-team",
    });

    try {
      const eventIds = ["evt-1", "evt-2", "evt-3", "evt-4", "evt-5"];
      for (const [index, eventId] of eventIds.entries()) {
        await store.appendAuditEvent({
          eventId,
          type: "link_started",
          serviceId: index < 3 ? "svc-a" : "svc-b",
          accountId: index < 3 ? "acct-a" : "acct-b",
          bindingId: index % 2 === 0 ? "bind-a" : "bind-b",
          occurredAt: 1700000000 + index,
        });
      }

      const filteredFirstPage = await store.listAuditEvents({
        serviceId: "svc-a",
        accountId: "acct-a",
        limit: 2,
        offset: 0,
      });
      assert.deepEqual(filteredFirstPage.map((event) => event.eventId), ["evt-1", "evt-2"]);

      const filteredSecondPage = await store.listAuditEvents({
        serviceId: "svc-a",
        accountId: "acct-a",
        limit: 2,
        offset: 2,
      });
      assert.deepEqual(filteredSecondPage.map((event) => event.eventId), ["evt-3"]);

      const filteredNoPagination = await store.listAuditEvents({
        serviceId: "svc-a",
        accountId: "acct-a",
      });
      assert.deepEqual(filteredNoPagination.map((event) => event.eventId), ["evt-1", "evt-2", "evt-3"]);

      const limitZero = await store.listAuditEvents({
        serviceId: "svc-a",
        accountId: "acct-a",
        limit: 0,
      });
      assert.equal(limitZero.length, 0);
    } finally {
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  await test("sqlite-backed SqliteLinkageStore.close() blocks operations", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "presence-sqlite-close-"));
    const store = new SqliteLinkageStore({
      dbPath: join(dbDir, "presence-linkage.db"),
      mode: "single-team",
    });
    const now = Math.floor(Date.now() / 1000);

    try {
      await store.saveServiceBinding({
        bindingId: "sqlite_bind_close",
        serviceId: "svc",
        accountId: "acct-close",
        deviceIss: "presence:device:close",
        createdAt: now,
        updatedAt: now,
        status: "linked",
        lastLinkedAt: now,
        lastVerifiedAt: now,
        lastAttestedAt: now,
      });

      store.close();

      await assert.rejects(
        () => store.getServiceBinding("svc", "acct-close"),
        /closed/i
      );
      assert.doesNotThrow(() => store.close());
    } finally {
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  await test("sqlite-backed mutate() rolls back nested async mutator on failure", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "presence-sqlite-mutate-rollback-"));
    const store = new SqliteLinkageStore({
      dbPath: join(dbDir, "presence-linkage.db"),
      mode: "single-team",
    });
    const now = Math.floor(Date.now() / 1000);

    try {
      await store.saveServiceBinding({
        bindingId: "sqlite_bind_tx_base",
        serviceId: "svc",
        accountId: "acct-tx",
        deviceIss: "presence:device:tx-base",
        createdAt: now,
        updatedAt: now,
        status: "linked",
        lastLinkedAt: now,
        lastVerifiedAt: now,
        lastAttestedAt: now,
      });

      await assert.rejects(
        () => store.mutate(async (mutatorStore) => {
          await mutatorStore.savePendingProofRequest({
            id: "preq-fail",
            serviceId: "svc",
            accountId: "acct-tx",
            bindingId: "sqlite_bind_tx_base",
            deviceIss: "presence:device:tx-base",
            nonce: "nonce-fail",
            requestedAt: now,
            expiresAt: now + 300,
            status: "pending",
          });
          await Promise.resolve();
          throw new Error("tx-failed");
        }),
        /tx-failed/
      );

      const stillMissing = await store.getPendingProofRequest("preq-fail");
      assert.equal(stillMissing, null);
    } finally {
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  await test("sqlite-backed mutate() serializes concurrent async mutators", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "presence-sqlite-mutate-serialize-"));
    const store = new SqliteLinkageStore({
      dbPath: join(dbDir, "presence-linkage.db"),
      mode: "single-team",
    });
    const now = Math.floor(Date.now() / 1000);

    try {
      const first = store.mutate(async (mutatorStore) => {
        await mutatorStore.saveServiceBinding({
          bindingId: "sqlite_bind_concurrent_a",
          serviceId: "svc",
          accountId: "acct-concurrent-a",
          deviceIss: "presence:device:concurrent-a",
          createdAt: now,
          updatedAt: now,
          status: "linked",
          lastLinkedAt: now,
          lastVerifiedAt: now,
          lastAttestedAt: now,
        });
        await new Promise((resolve) => setTimeout(resolve, 75));
        return "first-done";
      });

      const second = store.mutate(async (mutatorStore) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        await mutatorStore.saveServiceBinding({
          bindingId: "sqlite_bind_concurrent_b",
          serviceId: "svc",
          accountId: "acct-concurrent-b",
          deviceIss: "presence:device:concurrent-b",
          createdAt: now,
          updatedAt: now,
          status: "linked",
          lastLinkedAt: now,
          lastVerifiedAt: now,
          lastAttestedAt: now,
        });
        throw new Error("second-failed");
      });

      const [firstResult, secondResult] = await Promise.allSettled([first, second]);

      assert.equal(firstResult.status, "fulfilled");
      assert.equal(secondResult.status, "rejected");

      const survived = await store.getServiceBinding("svc", "acct-concurrent-a");
      const failed = await store.getServiceBinding("svc", "acct-concurrent-b");

      assert.equal(survived?.bindingId, "sqlite_bind_concurrent_a");
      assert.equal(failed, null);
    } finally {
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  await test("sqlite-backed destroy() is idempotent and allows reopening", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "presence-sqlite-destroy-"));
    const dbPath = join(dbDir, "presence-linkage.db");
    const now = Math.floor(Date.now() / 1000);

    const writer = new SqliteLinkageStore({ dbPath, mode: "single-team" });
    try {
      await writer.saveServiceBinding({
        bindingId: "sqlite_bind_reopen",
        serviceId: "svc",
        accountId: "acct-reopen",
        deviceIss: "presence:device:reopen",
        createdAt: now,
        updatedAt: now,
        status: "linked",
        lastLinkedAt: now,
        lastVerifiedAt: now,
        lastAttestedAt: now,
      });
      writer.destroy();

      const reopened = new SqliteLinkageStore({ dbPath, mode: "single-team" });
      try {
        const rehydrated = await reopened.getServiceBinding("svc", "acct-reopen");
        assert.equal(rehydrated?.deviceIss, "presence:device:reopen");
      } finally {
        assert.doesNotThrow(() => reopened.destroy());
        assert.doesNotThrow(() => reopened.destroy());
      }
    } finally {
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  await test("sqlite-backed createPendingProofRequest() persists and lists server-side requests", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "presence-sqlite-pending-"));
    const store = new SqliteLinkageStore({ dbPath: join(dbDir, "presence-linkage.db"), mode: "single-team" });
    const client = new PresenceClient({ silent: true, linkageStore: store, serviceId: "svc" });

    try {
      const now = Math.floor(Date.now() / 1000);
      await store.saveServiceBinding({
        bindingId: "sqlite_bind_pending",
        serviceId: "svc",
        accountId: "acct-sqlite-pending",
        deviceIss: "presence:device:sqlite-pending",
        createdAt: now,
        updatedAt: now,
        status: "linked",
        lastLinkedAt: now,
        lastVerifiedAt: now,
        lastAttestedAt: now,
      });

      const pending = await client.createPendingProofRequest({
        accountId: "acct-sqlite-pending",
        metadata: { source: "sdk-test" },
      });
      assert.equal(pending.ok, true);
      if (!pending.ok) {
        throw new Error("expected pending proof request");
      }

      const persisted = await store.getPendingProofRequest(pending.request.id);
      assert.equal(persisted?.status, "pending");
      assert.equal(persisted?.accountId, "acct-sqlite-pending");
      assert.equal(persisted?.metadata?.source, "sdk-test");

      const list = await client.listPendingProofRequests({ accountId: "acct-sqlite-pending" });
      assert.equal(list.length, 1);
      assert.equal(list[0]?.id, pending.request.id);
      assert.equal(list[0]?.status, "pending");
    } finally {
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  await test("sqlite-backed respondToPendingProofRequest() marks request verified", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "presence-sqlite-pending-verify-"));
    const store = new SqliteLinkageStore({ dbPath: join(dbDir, "presence-linkage.db"), mode: "single-team" });
    const client = new PresenceClient({ silent: true, linkageStore: store, serviceId: "svc" });

    try {
      const now = Math.floor(Date.now() / 1000);
      const binding = {
        bindingId: "sqlite_bind_pending_verify",
        serviceId: "svc",
        accountId: "acct-sqlite-pending-verify",
        deviceIss: "presence:device:pending-verify-sqlite",
        createdAt: now,
        updatedAt: now,
        status: "linked" as const,
        lastLinkedAt: now,
        lastVerifiedAt: now,
        lastAttestedAt: now,
      };
      await store.saveServiceBinding(binding);

      const pending = await client.createPendingProofRequest({ accountId: "acct-sqlite-pending-verify" });
      assert.equal(pending.ok, true);
      if (!pending.ok) {
        throw new Error("expected pending proof request");
      }

      const verifyLinked = async () => ({
        verified: true as const,
        pol_version: "1.0" as const,
        iss: binding.deviceIss,
        iat: NOW,
        state_created_at: STATE_CREATED,
        state_valid_until: STATE_VALID_UNTIL,
        human: true as const,
        pass: true as const,
        signals: ["heart_rate", "steps"] as const,
        nonce: pending.request.nonce,
      });
      (client as unknown as { verifyLinkedAccount: typeof verifyLinked }).verifyLinkedAccount = verifyLinked;

      const result = await client.respondToPendingProofRequest({ requestId: pending.request.id, body: { ok: true } });
      assert.equal(result.verified, true);
      const saved = await store.getPendingProofRequest(pending.request.id);
      assert.equal(saved?.status, "verified");
      assert.ok(saved?.completedAt);
    } finally {
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  await test("sqlite-backed pending proof request expiry transitions to expired", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "presence-sqlite-pending-expired-"));
    const store = new SqliteLinkageStore({ dbPath: join(dbDir, "presence-linkage.db"), mode: "single-team" });
    const client = new PresenceClient({ silent: true, linkageStore: store, serviceId: "svc" });

    try {
      const now = Math.floor(Date.now() / 1000);
      await store.saveServiceBinding({
        bindingId: "sqlite_bind_pending_expired",
        serviceId: "svc",
        accountId: "acct-sqlite-pending-expired",
        deviceIss: "presence:device:pending-expired-sqlite",
        createdAt: now,
        updatedAt: now,
        status: "linked",
        lastLinkedAt: now,
        lastVerifiedAt: now,
        lastAttestedAt: now,
      });

      await store.savePendingProofRequest({
        id: "ppreq_sqlite_expired",
        serviceId: "svc",
        accountId: "acct-sqlite-pending-expired",
        bindingId: "sqlite_bind_pending_expired",
        deviceIss: "presence:device:pending-expired-sqlite",
        nonce: "fixture-nonce",
        requestedAt: now - 60,
        expiresAt: now - 1,
        status: "pending",
      });

      const expired = await client.getPendingProofRequest({ requestId: "ppreq_sqlite_expired" });
      assert.equal(expired?.status, "expired");
      assert.ok(expired?.completedAt);

      const list = await client.listPendingProofRequests({ accountId: "acct-sqlite-pending-expired", includeInactive: true });
      const byId = list.find((request) => request.id === "ppreq_sqlite_expired");
      assert.equal(byId?.status, "expired");
    } finally {
      rmSync(dbDir, { recursive: true, force: true });
    }
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

  await test("rewriteLinkSessionForPublicBase() absolutizes default completion URLs for mobile-facing transport", async () => {
    const store = new InMemoryLinkageStore();
    const client = new PresenceClient({ silent: true, linkageStore: store, serviceId: "svc" });
    const { session } = await client.createLinkSession({ serviceId: "svc", accountId: "acct-public" });
    const rewritten = rewriteLinkSessionForPublicBase(session, {
      publicBaseUrl: "https://presence.example.com",
      serviceDomain: "presence.example.com",
    });
    const qrUrl = new URL(rewritten.completion?.qrUrl ?? "");

    assert.equal(rewritten.completion?.sessionStatusUrl, `https://presence.example.com/presence/link-sessions/${encodeURIComponent(session.id)}`);
    assert.equal(rewritten.completion?.completionApiUrl, `https://presence.example.com/presence/link-sessions/${encodeURIComponent(session.id)}/complete`);
    assert.equal(rewritten.completion?.linkedNonceApiUrl, "https://presence.example.com/presence/linked-accounts/acct-public/nonce");
    assert.equal(rewritten.completion?.verifyLinkedAccountApiUrl, "https://presence.example.com/presence/linked-accounts/acct-public/verify");
    assert.equal(qrUrl.searchParams.get("service_domain"), "presence.example.com");
    assert.equal(qrUrl.searchParams.get("status_url"), `https://presence.example.com/presence/link-sessions/${encodeURIComponent(session.id)}`);
    assert.equal(qrUrl.searchParams.get("nonce_url"), "https://presence.example.com/presence/linked-accounts/acct-public/nonce");
    assert.equal(qrUrl.searchParams.get("verify_url"), "https://presence.example.com/presence/linked-accounts/acct-public/verify");

    const response = createCompletionSessionResponse({
      session: rewritten,
      contract: {
        createSessionPath: "/presence/link-sessions",
        completeSessionPath: "/presence/link-sessions/:sessionId/complete",
        sessionStatusPath: "/presence/link-sessions/:sessionId",
      },
    });
    assert.equal(response.completion.endpoints.complete.path, `https://presence.example.com/presence/link-sessions/${encodeURIComponent(session.id)}/complete`);
    assert.equal(response.completion.endpoints.status?.path, `https://presence.example.com/presence/link-sessions/${encodeURIComponent(session.id)}`);
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

  await test("createPendingProofRequest() persists a server-side pending request and formats respond endpoints", async () => {
    const store = new InMemoryLinkageStore();
    const client = new PresenceClient({ silent: true, linkageStore: store, serviceId: "svc" });
    const now = Math.floor(Date.now() / 1000);
    await store.saveServiceBinding({
      bindingId: "pbind_pending",
      serviceId: "svc",
      accountId: "acct-pending",
      deviceIss: "presence:device:pending",
      createdAt: now,
      updatedAt: now,
      status: "linked",
      lastLinkedAt: now,
      lastVerifiedAt: now,
      lastAttestedAt: now,
    });

    const pending = await client.createPendingProofRequest({
      accountId: "acct-pending",
      metadata: { source: "sdk-test" },
    });
    assert.equal(pending.ok, true);
    if (!pending.ok) {
      throw new Error("expected pending proof request");
    }

    const response = createPendingProofRequestResponse({
      request: pending.request,
      contract: {
        createSessionPath: "/presence/link-sessions",
        completeSessionPath: "/presence/link-sessions/:sessionId/complete",
        linkedPendingProofRequestsPath: "/presence/linked-accounts/:accountId/pending-proof-requests",
        pendingProofRequestPath: "/presence/pending-proof-requests/:requestId",
        respondPendingProofRequestPath: "/presence/pending-proof-requests/:requestId/respond",
        unlinkAccountPath: "/presence/linked-accounts/:accountId/unlink",
      },
    });
    assert.equal(response.proofRequest.requestId, pending.request.id);
    assert.equal(response.proofRequest.endpoints.respond.path, `/presence/pending-proof-requests/${encodeURIComponent(pending.request.id)}/respond`);
    assert.equal(response.proofRequest.endpoints.status?.path, `/presence/pending-proof-requests/${encodeURIComponent(pending.request.id)}`);

    const listResponse = createPendingProofRequestListResponse({
      requests: await client.listPendingProofRequests({ accountId: "acct-pending" }),
      contract: {
        createSessionPath: "/presence/link-sessions",
        completeSessionPath: "/presence/link-sessions/:sessionId/complete",
        linkedPendingProofRequestsPath: "/presence/linked-accounts/:accountId/pending-proof-requests",
        pendingProofRequestPath: "/presence/pending-proof-requests/:requestId",
        respondPendingProofRequestPath: "/presence/pending-proof-requests/:requestId/respond",
      },
    });
    assert.equal(listResponse.proofRequests.length, 1);
    assert.equal(listResponse.proofRequests[0]?.status, "pending");
    assert.equal(pending.request.signal?.kind, "pending_proof_request.available");
    assert.equal(pending.request.signalDispatch?.state, "not_configured");
  });

  await test("registerDevicePushToken() stores an active APNs target on the linked device", async () => {
    const store = new InMemoryLinkageStore();
    const client = new PresenceClient({ silent: true, linkageStore: store, serviceId: "svc" });
    const now = Math.floor(Date.now() / 1000);
    await store.saveLinkedDevice({
      iss: "presence:device:push",
      platform: "ios",
      firstLinkedAt: now,
      lastVerifiedAt: now,
      lastAttestedAt: now,
      trustState: "active",
    });

    const registration = await client.registerDevicePushToken({
      deviceIss: "presence:device:push",
      token: "AA BB CC DD",
      environment: "development",
      bundleId: "com.presence.testapp",
    });

    assert.equal(registration.pushToken.platform, "ios_apns");
    assert.equal(registration.pushToken.token, "aabbccdd");
    assert.equal(registration.pushToken.status, "active");
    assert.equal(registration.device.pushTokens?.length, 1);
    assert.equal(registration.device.pushTokens?.[0]?.bundleId, "com.presence.testapp");
  });

  await test("createPendingProofRequest() dispatches a push signal when an active token and transport exist", async () => {
    const store = new InMemoryLinkageStore();
    const deliveries: Array<{ requestId: string; targetCount: number }> = [];
    const client = new PresenceClient({
      silent: true,
      linkageStore: store,
      serviceId: "svc",
      pendingProofSignalTransport: {
        async deliver({ signal, targets }) {
          deliveries.push({ requestId: signal.requestId, targetCount: targets.length });
          return {
            provider: "test-transport",
            deliveredAt: NOW,
            providerMessageId: `msg:${signal.signalId}`,
          };
        },
      },
    });
    const now = Math.floor(Date.now() / 1000);
    await store.saveLinkedDevice({
      iss: "presence:device:push-dispatch",
      platform: "ios",
      firstLinkedAt: now,
      lastVerifiedAt: now,
      lastAttestedAt: now,
      trustState: "active",
    });
    await client.registerDevicePushToken({
      deviceIss: "presence:device:push-dispatch",
      token: "feedface",
      environment: "development",
      bundleId: "com.presence.testapp",
    });
    await store.saveServiceBinding({
      bindingId: "pbind_pending_push",
      serviceId: "svc",
      accountId: "acct-pending-push",
      deviceIss: "presence:device:push-dispatch",
      createdAt: now,
      updatedAt: now,
      status: "linked",
      lastLinkedAt: now,
      lastVerifiedAt: now,
      lastAttestedAt: now,
    });

    const pending = await client.createPendingProofRequest({
      accountId: "acct-pending-push",
    });
    assert.equal(pending.ok, true);
    if (!pending.ok) {
      throw new Error("expected pending proof request");
    }

    assert.deepEqual(deliveries, [{
      requestId: pending.request.id,
      targetCount: 1,
    }]);
    assert.equal(pending.request.signalDispatch?.state, "dispatched");
    assert.equal(pending.request.signalDispatch?.provider, "test-transport");
    assert.equal(pending.request.signalDispatch?.providerMessageId?.startsWith("msg:"), true);
  });

  await test("respondToPendingProofRequest() marks the pending request verified after a successful linked verification", async () => {
    const store = new InMemoryLinkageStore();
    const client = new PresenceClient({ silent: true, linkageStore: store, serviceId: "svc" });
    const now = Math.floor(Date.now() / 1000);
    const binding = {
      bindingId: "pbind_pending_verify",
      serviceId: "svc",
      accountId: "acct-pending-verify",
      deviceIss: "presence:device:pending-verify",
      createdAt: now,
      updatedAt: now,
      status: "linked" as const,
      lastLinkedAt: now,
      lastVerifiedAt: now,
      lastAttestedAt: now,
    };
    await store.saveServiceBinding(binding);

    const pending = await client.createPendingProofRequest({ accountId: "acct-pending-verify" });
    assert.equal(pending.ok, true);
    if (!pending.ok) {
      throw new Error("expected pending proof request");
    }

    const respondStub = async () => ({
      verified: true as const,
      pol_version: "1.0" as const,
      iss: binding.deviceIss,
      iat: NOW,
      state_created_at: STATE_CREATED,
      state_valid_until: STATE_VALID_UNTIL,
      human: true as const,
      pass: true as const,
      signals: ["heart_rate", "steps"] as const,
      nonce: pending.request.nonce,
      binding,
      snapshot: {
        deviceIss: binding.deviceIss,
        capturedAt: NOW,
        attestedAt: NOW,
        stateCreatedAt: STATE_CREATED,
        stateValidUntil: STATE_VALID_UNTIL,
        human: true,
        pass: true,
        signals: ["heart_rate", "steps"] as const,
        source: "verified_proof" as const,
      },
    });
    (client as unknown as { verifyLinkedAccount: typeof respondStub }).verifyLinkedAccount = respondStub;

    const result = await client.respondToPendingProofRequest({
      requestId: pending.request.id,
      body: { ok: true },
    });
    assert.equal(result.verified, true);
    const savedRequest = await store.getPendingProofRequest(pending.request.id);
    assert.equal(savedRequest?.status, "verified");
    assert.ok(savedRequest?.completedAt);
  });

  await test("pending-proof lifecycle transitions are locked down via fixtures", async () => {
    const fixtures: Array<() => Promise<void>> = [
      async () => {
        const store = new InMemoryLinkageStore();
        const client = new PresenceClient({ silent: true, linkageStore: store, serviceId: "svc" });
        const now = Math.floor(Date.now() / 1000);
        const binding = {
          bindingId: "pbind_pending_transition_verified",
          serviceId: "svc",
          accountId: "acct-pending-transition-verified",
          deviceIss: "presence:device:pending-transition-verified",
          createdAt: now,
          updatedAt: now,
          status: "linked" as const,
          lastLinkedAt: now,
          lastVerifiedAt: now,
          lastAttestedAt: now,
        };
        await store.saveServiceBinding(binding);

        const pending = await client.createPendingProofRequest({ accountId: binding.accountId });
        assert.equal(pending.ok, true);
        if (!pending.ok) {
          throw new Error("expected pending proof request");
        }

        const respondStub = async () => ({
          verified: true as const,
          pol_version: "1.0" as const,
          iss: binding.deviceIss,
          iat: NOW,
          state_created_at: STATE_CREATED,
          state_valid_until: STATE_VALID_UNTIL,
          human: true as const,
          pass: true as const,
          signals: ["heart_rate"] as const,
          nonce: pending.request.nonce,
          binding,
          snapshot: {
            deviceIss: binding.deviceIss,
            capturedAt: NOW,
            attestedAt: NOW,
            stateCreatedAt: STATE_CREATED,
            stateValidUntil: STATE_VALID_UNTIL,
            human: true,
            pass: true,
            signals: ["heart_rate"] as const,
            source: "verified_proof" as const,
          },
        });
        (client as unknown as { verifyLinkedAccount: typeof respondStub }).verifyLinkedAccount = respondStub;

        const result = await client.respondToPendingProofRequest({ requestId: pending.request.id, body: { ok: true } });
        assert.equal(result.verified, true);

        const saved = await store.getPendingProofRequest(pending.request.id);
        assert.equal(saved?.status, "verified");
        assert.ok(saved?.completedAt);
      },
      async () => {
        const store = new InMemoryLinkageStore();
        const client = new PresenceClient({ silent: true, linkageStore: store, serviceId: "svc" });
        const now = Math.floor(Date.now() / 1000);
        const linkedBinding = {
          bindingId: "pbind_pending_transition_recovery",
          serviceId: "svc",
          accountId: "acct-pending-transition-recovery",
          deviceIss: "presence:device:pending-transition-recovery",
          createdAt: now,
          updatedAt: now,
          status: "linked" as const,
          lastLinkedAt: now,
          lastVerifiedAt: now,
          lastAttestedAt: now,
        };
        await store.saveServiceBinding(linkedBinding);

        const pending = await client.createPendingProofRequest({ accountId: linkedBinding.accountId });
        assert.equal(pending.ok, true);
        if (!pending.ok) {
          throw new Error("expected pending proof request");
        }

        const respondStub = async () => ({
          verified: false as const,
          error: "ERR_BINDING_RECOVERY_REQUIRED" as const,
          detail: "binding mismatch",
          binding: {
            ...linkedBinding,
            bindingId: "pbind_pending_transition_recovery_other",
            deviceIss: "presence:device:replacement",
          },
          expectedDeviceIss: linkedBinding.deviceIss,
          actualDeviceIss: "presence:device:replacement",
          recoveryAction: "relink" as const,
        });
        (client as unknown as { verifyLinkedAccount: typeof respondStub }).verifyLinkedAccount = respondStub;

        const result = await client.respondToPendingProofRequest({ requestId: pending.request.id, body: { ok: true } });
        if (result.verified) {
          throw new Error("expected recovery_required result");
        }

        const saved = await store.getPendingProofRequest(pending.request.id);
        assert.equal(saved?.status, "recovery_required");
        assert.equal(saved?.recoveryReason, "binding_recovery_required");
      },
      async () => {
        const store = new InMemoryLinkageStore();
        const client = new PresenceClient({ silent: true, linkageStore: store, serviceId: "svc" });
        const now = Math.floor(Date.now() / 1000);
        const binding = {
          bindingId: "pbind_pending_transition_expired",
          serviceId: "svc",
          accountId: "acct-pending-transition-expired",
          deviceIss: "presence:device:pending-transition-expired",
          createdAt: now,
          updatedAt: now,
          status: "linked" as const,
          lastLinkedAt: now,
          lastVerifiedAt: now,
          lastAttestedAt: now,
        };
        await store.saveServiceBinding(binding);
        await store.savePendingProofRequest({
          id: "ppreq_expired_fixture",
          serviceId: binding.serviceId,
          accountId: binding.accountId,
          bindingId: binding.bindingId,
          deviceIss: binding.deviceIss,
          nonce: "fixture-expired-nonce",
          requestedAt: now - 120,
          expiresAt: now - 1,
          status: "pending",
        });

        const expired = await client.getPendingProofRequest({ requestId: "ppreq_expired_fixture" });
        assert.equal(expired?.status, "expired");
        assert.ok(expired?.completedAt);

        const allRequests = await client.listPendingProofRequests({ accountId: binding.accountId, includeInactive: true });
        const persisted = allRequests.find((request) => request.id === "ppreq_expired_fixture");
        assert.equal(persisted?.status, "expired");
      },
      async () => {
        const store = new InMemoryLinkageStore();
        const client = new PresenceClient({ silent: true, linkageStore: store, serviceId: "svc" });
        const now = Math.floor(Date.now() / 1000);
        await store.saveServiceBinding({
          bindingId: "pbind_pending_transition_cancel",
          serviceId: "svc",
          accountId: "acct-pending-transition-cancel",
          deviceIss: "presence:device:pending-transition-cancel",
          createdAt: now,
          updatedAt: now,
          status: "linked" as const,
          lastLinkedAt: now,
          lastVerifiedAt: now,
          lastAttestedAt: now,
        });

        const first = await client.createPendingProofRequest({ accountId: "acct-pending-transition-cancel" });
        assert.equal(first.ok, true);
        if (!first.ok) {
          throw new Error("expected first pending proof request");
        }

        const second = await client.createPendingProofRequest({ accountId: "acct-pending-transition-cancel" });
        assert.equal(second.ok, true);
        if (!second.ok) {
          throw new Error("expected second pending proof request");
        }

        const firstSaved = await store.getPendingProofRequest(first.request.id);
        const secondSaved = await store.getPendingProofRequest(second.request.id);
        assert.equal(firstSaved?.status, "cancelled");
        assert.equal(secondSaved?.status, "pending");
        assert.ok(firstSaved?.completedAt);
      },
    ];

    for (const fixture of fixtures) {
      await fixture();
    }
  });

  await test("verifyLinkedAccount() rehydrates pending-proof nonce from persisted request", async () => {
    const store = new InMemoryLinkageStore();
    const serviceId = "svc";
    const accountId = "acct-pending-restart";
    const now = Math.floor(Date.now() / 1000);
    const binding = {
      bindingId: "pbind-pending-restart",
      serviceId,
      accountId,
      deviceIss: "presence:device:pending-restart",
      createdAt: now,
      updatedAt: now,
      status: "linked" as const,
      lastLinkedAt: now,
      lastVerifiedAt: now,
      lastAttestedAt: now,
    };

    await store.saveServiceBinding(binding);

    const bootstrap = new PresenceClient({ silent: true, linkageStore: store, serviceId });
    const request = await bootstrap.createPendingProofRequest({ accountId });
    assert.equal(request.ok, true);
    if (!request.ok) {
      throw new Error("expected pending proof request");
    }

    const restarted = new PresenceClient({ silent: true, linkageStore: store, serviceId });
    const restartedNonceStore = (restarted as unknown as { managedNonces: { nonceStore: { isValid: (nonce: string, now: number) => Promise<boolean> } } }).managedNonces;
    const beforeValid = await restartedNonceStore.nonceStore.isValid(request.request.nonce, now);
    assert.equal(beforeValid, false);

    (restarted as unknown as { verify: (body: unknown, nonce: string) => Promise<unknown> }).verify = async () => ({
      verified: true as const,
      pol_version: "1.0" as const,
      iss: binding.deviceIss,
      iat: NOW,
      state_created_at: STATE_CREATED,
      state_valid_until: STATE_VALID_UNTIL,
      human: true as const,
      pass: true as const,
      signals: ["heart_rate"] as const,
      nonce: request.request.nonce,
    });

    const result = await restarted.verifyLinkedAccount(
      { ok: true },
      {
        accountId,
        nonce: request.request.nonce,
      }
    );

    assert.equal(result.verified, true);
    const afterValid = await restartedNonceStore.nonceStore.isValid(request.request.nonce, Math.floor(Date.now() / 1000));
    assert.equal(afterValid, true);
  });

  await test("completeLinkSession() rehydrates link-session nonce from persisted session", async () => {
    const store = new InMemoryLinkageStore();
    const bootstrap = new PresenceClient({ silent: true, linkageStore: store, serviceId: "svc" });
    const { session } = await bootstrap.createLinkSession({ serviceId: "svc", accountId: "acct-link-restart" });

    const body = buildAndroidBody(
      buildAttestation(keys.publicKeyDer, keys.privateKeyDer, session.issuedNonce),
      keys.publicKeyDer,
      undefined,
      true
    );
    const iss = deriveIss(keys.publicKeyDer);

    const restarted = new PresenceClient({ silent: true, linkageStore: store, serviceId: "svc" });
    const restartedNonceStore = (restarted as unknown as { managedNonces: { nonceStore: { isValid: (nonce: string, now: number) => Promise<boolean> } } }).managedNonces;
    const beforeValid = await restartedNonceStore.nonceStore.isValid(session.issuedNonce, Math.floor(Date.now() / 1000));
    assert.equal(beforeValid, false);

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
    (restarted as unknown as { verify: typeof verifyStub }).verify = verifyStub;

    const result = await restarted.completeLinkSession({ sessionId: session.id, body });
    assert.equal(result.verification.verified, true);
    const afterValid = await restartedNonceStore.nonceStore.isValid(session.issuedNonce, Math.floor(Date.now() / 1000));
    assert.equal(afterValid, true);
  });

  await test("completeLinkSession() rehydrates link-session nonce from sqlite persistence without explicit resolver config", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "presence-sqlite-rehydration-"));
    const dbPath = join(dbDir, "presence-linkage.db");
    const store = new SqliteLinkageStore({ dbPath, mode: "single-team" });

    try {
      const bootstrap = new PresenceClient({ silent: true, linkageStore: store, serviceId: "svc" });
      const { session } = await bootstrap.createLinkSession({ serviceId: "svc", accountId: "acct-sqlite-restart" });
      const body = buildAndroidBody(
        buildAttestation(keys.publicKeyDer, keys.privateKeyDer, session.issuedNonce),
        keys.publicKeyDer,
        undefined,
        true
      );
      const iss = deriveIss(keys.publicKeyDer);

      const restarted = new PresenceClient({ silent: true, linkageStore: store, serviceId: "svc" });
      const restartedNonceStore = (restarted as unknown as { managedNonces: { nonceStore: { isValid: (nonce: string, now: number) => Promise<boolean> } } }).managedNonces;
      const beforeValid = await restartedNonceStore.nonceStore.isValid(session.issuedNonce, Math.floor(Date.now() / 1000));
      assert.equal(beforeValid, false);

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
      (restarted as unknown as { verify: typeof verifyStub }).verify = verifyStub;

      const result = await restarted.completeLinkSession({ sessionId: session.id, body });
      assert.equal(result.verification.verified, true);
      const afterValid = await restartedNonceStore.nonceStore.isValid(session.issuedNonce, Math.floor(Date.now() / 1000));
      assert.equal(afterValid, true);
    } finally {
      rmSync(dbDir, { recursive: true, force: true });
    }
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
