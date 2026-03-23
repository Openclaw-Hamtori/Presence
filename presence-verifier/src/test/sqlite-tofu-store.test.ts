/**
 * Presence Verifier - SQLite TOFU Store tests
 */

import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import Database from "better-sqlite3";

import { SqliteTofuStore, SQLITE_TOFU_SCHEMA, SQLITE_TOFU_SCHEMA_VERSION } from "../stores.js";

let passed = 0;
let failed = 0;

function nextTempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "presence-verifier-sqlite-tofu-"));
  return join(dir, `${randomUUID()}.db`);
}

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`  ✗ ${name}:`, (error as Error).message);
    failed += 1;
  }
}

function cleanup(path: string) {
  try {
    rmSync(path);
  } catch {
    // ignore
  }
}

function createLegacyTofuDb(path: string): void {
  const db = new Database(path);
  db.exec(SQLITE_TOFU_SCHEMA);
  db.close();
}

function readSchemaVersion(path: string): number {
  const db = new Database(path);
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM _presence_verifier_schema_migrations;").get() as
    | { version: number }
    | undefined;
  db.close();
  return row?.version ?? 0;
}

(async () => {
  console.log("\n── SqliteTofuStore ──");

  await test("persists keys across reopened sqlite stores", async () => {
    const dbPath = nextTempDbPath();

    const first = new SqliteTofuStore({ dbPath });
    await first.set("did:example:android-1", new Uint8Array([1, 2, 3, 4]));

    const second = new SqliteTofuStore({ dbPath });
    const recovered = await second.get("did:example:android-1");

    assert.equal(second.dbPath, dbPath);
    assert.ok(recovered !== null);
    assert.deepEqual(Array.from(recovered), [1, 2, 3, 4]);

    first.close();
    second.close();
    cleanup(dbPath);
  });

  await test("returns null for unknown iss without creating entries", async () => {
    const dbPath = nextTempDbPath();
    const store = new SqliteTofuStore({ dbPath });

    const missing = await store.get("did:example:missing");
    assert.equal(missing, null);

    store.close();
    cleanup(dbPath);
  });

  await test("supports explicit get/set overwrite behavior", async () => {
    const dbPath = nextTempDbPath();

    const store = new SqliteTofuStore({ dbPath, journalMode: "DELETE" });
    const first = new Uint8Array([11, 12, 13]);
    const second = new Uint8Array([21, 22, 23]);

    await store.set("did:example:overwrite", first);
    await store.set("did:example:overwrite", second);

    const got = await store.get("did:example:overwrite");
    assert.deepEqual(Array.from(got ?? []), [21, 22, 23]);

    store.close();
    cleanup(dbPath);
  });

  await test("migrates legacy no-version schema to version table", async () => {
    const dbPath = nextTempDbPath();
    createLegacyTofuDb(dbPath);

    const store = new SqliteTofuStore({ dbPath });
    const got = await store.get("did:example:legacy");

    assert.equal(got, null);
    assert.equal(readSchemaVersion(dbPath), SQLITE_TOFU_SCHEMA_VERSION);

    await store.set("did:example:legacy", new Uint8Array([9, 8, 7]));

    const recovered = await store.get("did:example:legacy");
    assert.ok(recovered !== null);
    assert.deepEqual(Array.from(recovered), [9, 8, 7]);

    store.close();
    cleanup(dbPath);
  });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})();
