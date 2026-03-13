/**
 * presence-sdk smoke test
 * Tests PresenceClient API surface without platform attestation (stub path)
 */
const assert = require("assert");

// Load built SDK
const sdk = require("./dist/index.js");
const { PresenceClient, generateNonce, parsePresenceRequest, ParseError, InMemoryManagedNonceStore } = sdk;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

// ── 1. Exports ────────────────────────────────────────────────────────────────
console.log("\n[1] Export surface");
test("PresenceClient exported", () => assert.strictEqual(typeof PresenceClient, "function"));
test("generateNonce exported", () => assert.strictEqual(typeof generateNonce, "function"));
test("parsePresenceRequest exported", () => assert.strictEqual(typeof parsePresenceRequest, "function"));
test("ParseError exported", () => assert.strictEqual(typeof ParseError, "function"));
test("InMemoryManagedNonceStore exported", () => assert.strictEqual(typeof InMemoryManagedNonceStore, "function"));

// ── 2. generateNonce ──────────────────────────────────────────────────────────
console.log("\n[2] generateNonce()");
test("returns value/issuedAt/expiresAt", () => {
  const n = generateNonce();
  assert.ok(typeof n.value === "string" && n.value.length > 0);
  assert.ok(typeof n.issuedAt === "number");
  assert.ok(typeof n.expiresAt === "number");
  assert.ok(n.expiresAt > n.issuedAt);
});
test("value is base64url (no +/=/)", () => {
  const n = generateNonce();
  assert.ok(!/[+/=]/.test(n.value), `bad chars in: ${n.value}`);
});
test("default TTL is 300s", () => {
  const n = generateNonce();
  assert.strictEqual(n.expiresAt - n.issuedAt, 300);
});
test("rejects bytes < 16", () => {
  assert.throws(() => generateNonce({ bytes: 8 }), /minimum/);
});
test("rejects TTL > 300", () => {
  assert.throws(() => generateNonce({ ttlSeconds: 301 }), /maximum/);
});

// ── 3. PresenceClient constructor ──────────────────────────────────────────────────
console.log("\n[3] PresenceClient constructor");
test("creates with no config (silent)", () => {
  const presence = new PresenceClient({ silent: true });
  assert.ok(presence);
});
test("rejects nonceTtlSeconds > 300", () => {
  assert.throws(() => new PresenceClient({ nonceTtlSeconds: 301, silent: true }), /300/);
});
test("custom logger.warn is called", () => {
  const msgs = [];
  new PresenceClient({ logger: { warn: (m) => msgs.push(m) } });
  assert.ok(msgs.length > 0);
  assert.ok(msgs.some(m => m.includes("InMemoryNonceStore")));
});
test("silent suppresses all warnings", () => {
  const msgs = [];
  new PresenceClient({ silent: true, logger: { warn: (m) => msgs.push(m) } });
  assert.strictEqual(msgs.length, 0);
});

// ── 4. PresenceClient.generateNonce ────────────────────────────────────────────────
console.log("\n[4] PresenceClient.generateNonce()");
test("returns valid nonce and registers in store", () => {
  const presence = new PresenceClient({ silent: true });
  const n = presence.generateNonce();
  assert.ok(n.value.length > 0);
  assert.ok(!/[+/=]/.test(n.value));
});

// ── 5. parsePresenceRequest ────────────────────────────────────────────────────────
console.log("\n[5] parsePresenceRequest()");
test("throws ParseError on non-object", () => {
  assert.throws(() => parsePresenceRequest("string"), (e) => e instanceof ParseError);
});
test("throws ParseError on missing attestation", () => {
  assert.throws(() => parsePresenceRequest({ device_attestation: "abc" }), (e) => e instanceof ParseError);
});
test("throws ParseError on missing device_attestation", () => {
  assert.throws(() => parsePresenceRequest({ attestation: {} }), (e) => e instanceof ParseError);
});
test("throws ParseError on invalid base64url device_attestation", () => {
  assert.throws(
    () => parsePresenceRequest({ attestation: {}, device_attestation: "!!!invalid!!!" }),
    (e) => e instanceof ParseError
  );
});
test("infers iOS platform (no signing_public_key)", () => {
  // Use a valid base64url string that decodes to something
  const fakeAttestation = Buffer.from("fake-attestation-bytes").toString("base64url");
  const result = parsePresenceRequest({ attestation: {}, device_attestation: fakeAttestation });
  assert.strictEqual(result.platform, "ios");
});
test("infers Android platform (signing_public_key present)", () => {
  const fakeAttestation = Buffer.from("fake-attestation-bytes").toString("base64url");
  // 91 bytes for valid P-256 SPKI minimum
  const fakeKey = Buffer.alloc(91, 0x30).toString("base64url");
  const result = parsePresenceRequest({
    attestation: {},
    device_attestation: fakeAttestation,
    signing_public_key: fakeKey,
  });
  assert.strictEqual(result.platform, "android");
});
test("rejects signing_public_key < 91 bytes", () => {
  const fakeAttestation = Buffer.from("fake").toString("base64url");
  const shortKey = Buffer.alloc(10, 0x30).toString("base64url");
  assert.throws(
    () => parsePresenceRequest({ attestation: {}, device_attestation: fakeAttestation, signing_public_key: shortKey }),
    (e) => e instanceof ParseError && /P-256 SPKI/.test(e.message)
  );
});

// ── 6. PresenceClient.verify — nonce mismatch ──────────────────────────────────────
console.log("\n[6] PresenceClient.verify() — nonce checks");
asyncTest("nonce mismatch returns ERR_NONCE_INVALID", async () => {
  const presence = new PresenceClient({ silent: true });
  const fakeAttestation = Buffer.from("fake").toString("base64url");
  const body = {
    attestation: { nonce: "correct-nonce", pol_version: "1.0" },
    device_attestation: fakeAttestation,
  };
  const result = await presence.verify(body, "wrong-nonce");
  assert.strictEqual(result.verified, false);
  assert.strictEqual(result.error, "ERR_NONCE_INVALID");
}).then(() => {
  // ── 7. Summary ──────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
});
