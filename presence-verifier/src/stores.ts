/**
 * Presence Verifier - Store Implementations
 *
 * - In-memory stores: reference defaults for tests and local development
 * - SQLite-backed stores: small-team/single-server persistence path
 *
 * NonceStore tracks issued/used nonces.
 * TofuStore persists first-seen public keys per iss (Android TOFU).
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { NonceStore, TofuStore } from "./types.js";

// ─── In-Memory Nonce Store ────────────────────────────────────────────────────

interface NonceEntry {
  issuedAt: number;    // unix seconds
  ttlSeconds: number;
  used: boolean;
}

/**
 * InMemoryNonceStore
 *
 * Suitable for single-process testing only.
 * For production: use Redis or distributed cache with TTL.
 *
 * Nonce TTL is 5 minutes per Verifier Spec v0.4 Step 4.
 */
export class InMemoryNonceStore implements NonceStore {
  private store = new Map<string, NonceEntry>();
  private readonly ttlSeconds: number;

  constructor(ttlSeconds = 300) {
    this.ttlSeconds = ttlSeconds;
  }

  /** Issue a nonce (call this when generating nonces for clients) */
  issue(nonce: string, now = Math.floor(Date.now() / 1000)): void {
    this.store.set(nonce, {
      issuedAt: now,
      ttlSeconds: this.ttlSeconds,
      used: false,
    });
  }

  async isValid(nonce: string, now = Math.floor(Date.now() / 1000)): Promise<boolean> {
    const entry = this.store.get(nonce);
    if (!entry) return false;
    return now - entry.issuedAt <= entry.ttlSeconds;
  }

  async isUsed(nonce: string): Promise<boolean> {
    return this.store.get(nonce)?.used ?? false;
  }

  async markUsed(nonce: string): Promise<void> {
    const entry = this.store.get(nonce);
    if (entry) entry.used = true;
  }

  /** Cleanup expired entries (call periodically in production). Returns number removed. */
  cleanup(now = Math.floor(Date.now() / 1000)): number {
    let removed = 0;

    for (const [nonce, entry] of this.store.entries()) {
      if (now - entry.issuedAt > entry.ttlSeconds) {
        this.store.delete(nonce);
        removed += 1;
      }
    }
    return removed;
  }
}

// ─── In-Memory TOFU Store ─────────────────────────────────────────────────────

/**
 * InMemoryTofuStore
 *
 * Android Appendix v0.1 Section 5.3:
 *   - First accepted public key for a given iss is stored
 *   - Subsequent requests MUST use the same key
 *   - SHOULD persist across service restarts (use DB in production)
 *   - SHOULD retain until explicit revocation or service-defined expiration
 *
 * Suitable for single-process testing only.
 * For production: use persistent DB with revocation support.
 */
export class InMemoryTofuStore implements TofuStore {
  private store = new Map<string, Uint8Array>();

  async get(iss: string): Promise<Uint8Array | null> {
    return this.store.get(iss) ?? null;
  }

  async set(iss: string, publicKey: Uint8Array): Promise<void> {
    this.store.set(iss, publicKey);
  }

  /** Explicit revocation — removes iss from TOFU store */
  async revoke(iss: string): Promise<void> {
    this.store.delete(iss);
  }

  /** List all registered iss values */
  list(): string[] {
    return Array.from(this.store.keys());
  }
}

// ─── SQLite-backed TOFU Store ────────────────────────────────────────────────

export interface SqliteTofuStoreOptions {
  /**
   * Filesystem DB path for TOFU persistence (single-server / single-team use).
   */
  dbPath: string;
  /**
   * Journal mode for sqlite-backed stores.
   */
  journalMode?: "WAL" | "DELETE";
}

export const SQLITE_TOFU_SCHEMA_VERSION = 1;

export const SQLITE_TOFU_SCHEMA = `
CREATE TABLE IF NOT EXISTS tofu_keys (
  iss TEXT PRIMARY KEY,
  public_key BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);
`.trim();

const SQLITE_TOFU_SCHEMA_MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS _presence_verifier_schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
`.trim();

const TOFU_MIGRATIONS: ReadonlyArray<{ version: number; up: string[] }> = [
  {
    version: 1,
    up: [
      SQLITE_TOFU_SCHEMA_MIGRATIONS_TABLE,
      SQLITE_TOFU_SCHEMA,
      "INSERT OR IGNORE INTO _presence_verifier_schema_migrations (version, applied_at) VALUES (1, strftime('%s','now'));",
    ],
  },
];

/**
 * SqliteTofuStore
 *
 * Small-team/SQLite-first TOFU persistence helper.
 *
 * This keeps TOFU bindings across process restarts while preserving the same
 * TOFU API contract as InMemoryTofuStore.
 */
export class SqliteTofuStore implements TofuStore {
  readonly dbPath: string;
  private readonly db: Database.Database;
  private isClosed = false;

  constructor(options: SqliteTofuStoreOptions) {
    this.dbPath = options.dbPath;
    if (this.dbPath !== ":memory:") {
      mkdirSync(dirname(this.dbPath), { recursive: true });
    }

    this.db = new Database(this.dbPath);
    this.db.exec(`PRAGMA journal_mode = ${options.journalMode ?? "WAL"};`);
    this.runMigrations();
  }

  async get(iss: string): Promise<Uint8Array | null> {
    this.assertOpen();

    const row = this.db.prepare("SELECT public_key FROM tofu_keys WHERE iss = ?").get(iss) as
      | { public_key: Buffer }
      | undefined;

    if (!row?.public_key) {
      return null;
    }

    return new Uint8Array(row.public_key);
  }

  async set(iss: string, publicKey: Uint8Array): Promise<void> {
    this.assertOpen();

    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(`
      INSERT INTO tofu_keys (iss, public_key, updated_at)
      VALUES (@iss, @public_key, @updated_at)
      ON CONFLICT(iss) DO UPDATE SET
        public_key = excluded.public_key,
        updated_at = excluded.updated_at
    `).run({
      iss,
      public_key: Buffer.from(publicKey),
      updated_at: now,
    });
  }

  /**
   * For explicit cleanup in service/container lifecycles.
   */
  close(): void {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    this.db.close();
  }

  private runMigrations(): void {
    const applyMigrations = this.db.transaction(() => {
      this.db.exec(SQLITE_TOFU_SCHEMA_MIGRATIONS_TABLE);

      const currentVersion = Number(
        (this.db
          .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM _presence_verifier_schema_migrations;")
          .get() as { version: number } | undefined)?.version ?? 0
      );

      for (const migration of TOFU_MIGRATIONS) {
        if (migration.version > currentVersion) {
          for (const statement of migration.up) {
            this.db.exec(statement);
          }
        }
      }
    });

    applyMigrations();
  }

  private assertOpen(): void {
    if (this.isClosed) {
      throw new Error("SqliteTofuStore is closed");
    }
  }
}
