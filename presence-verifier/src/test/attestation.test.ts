/**
 * Presence Verifier - Attestation helpers
 */

import { strict as assert } from "node:assert";
import { PresenceVerifierError } from "../types.js";
import { resolveTofuPublicKey } from "../attestation.js";
import type { TofuStore } from "../types.js";

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

function makeTofuStore(seed: Map<string, Uint8Array>): TofuStore {
  return {
    async get(iss: string) {
      return seed.get(iss) ?? null;
    },
    async set(iss: string, publicKey: Uint8Array) {
      seed.set(iss, new Uint8Array(publicKey));
    },
  };
}

(async () => {
  console.log("\n── Attestation helpers ──");

  await test("resolveTofuPublicKey returns existing key when payload matches", async () => {
    const key = new Uint8Array([1, 2, 3, 4]);
    const store = makeTofuStore(new Map([ ["did:test:alpha", key] ]));

    const resolved = await resolveTofuPublicKey("did:test:alpha", new Uint8Array([1, 2, 3, 4]), store);

    assert.deepEqual(Array.from(resolved), [1, 2, 3, 4]);
  });

  await test("resolveTofuPublicKey rejects mismatched TOFU key", async () => {
    const store = makeTofuStore(new Map([ ["did:test:alpha", new Uint8Array([10, 20, 30, 40])] ]));

    try {
      await resolveTofuPublicKey("did:test:alpha", new Uint8Array([10, 20, 30, 41]), store);
    } catch (error) {
      assert.ok(error instanceof PresenceVerifierError);
      assert.equal((error as PresenceVerifierError).code, "ERR_INVALID_SIGNATURE");
      return;
    }

    throw new Error("expected resolveTofuPublicKey to reject on key mismatch");
  });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})();
