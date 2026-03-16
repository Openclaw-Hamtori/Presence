/**
 * Presence Verifier - In-Memory Store Implementations
 *
 * These are reference implementations for testing and development.
 * Production deployments SHOULD use persistent stores (Redis, DB, etc.).
 *
 * NonceStore: tracks issued and used nonces
 * TofuStore:  persists first-seen public keys per iss (Android TOFU)
 */

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

  /** Cleanup expired entries (call periodically in production) */
  cleanup(now = Math.floor(Date.now() / 1000)): void {
    for (const [nonce, entry] of this.store.entries()) {
      if (now - entry.issuedAt > entry.ttlSeconds) {
        this.store.delete(nonce);
      }
    }
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
