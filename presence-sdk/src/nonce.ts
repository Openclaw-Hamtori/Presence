/**
 * presence-sdk — Nonce Generation & Management
 *
 * Signal Spec v0.4:
 *   - cryptographically random
 *   - minimum 16 bytes entropy
 *   - base64url format (MUST)
 *   - TTL ≤ 5 minutes
 *   - single-use
 */

import { randomBytes } from "crypto";
import { InMemoryNonceStore } from "presence-verifier";
import type { GeneratedNonce, NonceIssuer, NonceOptions } from "./types.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_BYTES = 16;
const DEFAULT_BYTES = 32;
const MAX_TTL_SECONDS = 300;
const DEFAULT_TTL_SECONDS = 300;

// ─── Nonce Generation ─────────────────────────────────────────────────────────

/**
 * Create a cryptographically random nonce without issuing it into a store.
 *
 * Use PresenceClient.generateNonce() when you want the SDK to create + issue in one step.
 */
export function createNonce(options: NonceOptions = {}): GeneratedNonce {
  const bytes = options.bytes ?? DEFAULT_BYTES;
  const ttl = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;

  if (bytes < MIN_BYTES) {
    throw new Error(`nonce entropy too low: ${bytes} bytes (minimum ${MIN_BYTES})`);
  }
  if (ttl > MAX_TTL_SECONDS) {
    throw new Error(`nonce TTL too long: ${ttl}s (maximum ${MAX_TTL_SECONDS}s)`);
  }

  const raw = randomBytes(bytes);
  const value = base64urlEncode(raw);
  const issuedAt = Math.floor(Date.now() / 1000);

  return {
    value,
    issuedAt,
    expiresAt: issuedAt + ttl,
  };
}

/**
 * Backward-compatible alias for createNonce().
 *
 * Note: this helper only creates a nonce value. PresenceClient.generateNonce()
 * creates and issues it into the effective SDK nonce store.
 */
export const generateNonce = createNonce;

// ─── Managed Nonce Store ──────────────────────────────────────────────────────

/**
 * InMemoryManagedNonceStore
 *
 * In-memory development helper that combines nonce generation and store management.
 * Not suitable for production (single-process, non-persistent).
 *
 * For production: implement the NonceStore interface backed by Redis or similar.
 */
export class InMemoryManagedNonceStore implements NonceIssuer {
  private readonly store: InMemoryNonceStore;
  private readonly ttlSeconds: number;

  constructor(ttlSeconds = DEFAULT_TTL_SECONDS) {
    if (ttlSeconds > MAX_TTL_SECONDS) {
      throw new Error(`nonce TTL too long: ${ttlSeconds}s (maximum ${MAX_TTL_SECONDS}s)`);
    }
    this.ttlSeconds = ttlSeconds;
    this.store = new InMemoryNonceStore(ttlSeconds);
  }

  /** Register an already-created nonce in the store */
  issue(nonce: string, now = Math.floor(Date.now() / 1000)): void {
    this.store.issue(nonce, now);
  }

  /**
   * Create a new nonce and register it in the store atomically.
   * Returns the GeneratedNonce — send `value` to the client.
   */
  generateAndIssue(options: Omit<NonceOptions, "ttlSeconds"> = {}): GeneratedNonce {
    const nonce = createNonce({ ...options, ttlSeconds: this.ttlSeconds });
    this.issue(nonce.value, nonce.issuedAt);
    return nonce;
  }

  /** Expose underlying store for use in VerifierContext */
  get nonceStore(): InMemoryNonceStore {
    return this.store;
  }

  /** Cleanup expired nonces (call periodically in production). Returns number removed. */
  cleanup(): number {
    return (this.store.cleanup as () => number)();
  }
}

// ─── Base64url ────────────────────────────────────────────────────────────────

function base64urlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

export function base64urlDecode(input: string): Buffer {
  // Validate: base64url allows A-Z a-z 0-9 - _
  if (!/^[A-Za-z0-9\-_]*$/.test(input)) {
    throw new Error(`invalid base64url string: contains illegal characters`);
  }
  const base64 = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(input.length + ((4 - (input.length % 4)) % 4), "=");
  return Buffer.from(base64, "base64");
}

/** @deprecated Use InMemoryManagedNonceStore */
export { InMemoryManagedNonceStore as ManagedNonceStore };
