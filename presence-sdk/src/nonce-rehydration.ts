import type { LinkageStore, LinkSession, PersistedNonceStore } from "./types.js";

interface PendingProofRequestLookup {
  serviceId: string;
  accountId: string;
  nonce: string;
  now: number;
}

interface LinkSessionLookup {
  sessionId: string;
  now: number;
}

/**
 * Resolve persisted nonces from durable linkage state so verification can recover
 * across restarts (pending proof + link session flows).
 */
export class LinkageStorePersistedNonceStore implements PersistedNonceStore {
  constructor(private readonly linkageStore: LinkageStore) {}

  async resolvePendingProofNonceIssueTime({ serviceId, accountId, nonce, now }: PendingProofRequestLookup): Promise<number | null> {
    const requests = await this.linkageStore.listPendingProofRequests({
      serviceId,
      accountId,
      statuses: ["pending"],
    });

    const request = requests.find((entry) => entry.nonce === nonce && entry.expiresAt > now);
    return request?.requestedAt ?? null;
  }

  async resolveLinkSessionIssueTime({ sessionId, now }: LinkSessionLookup): Promise<number | null> {
    const session = await this.linkageStore.getLinkSession(sessionId);
    if (!session) {
      return null;
    }
    if (session.status !== "pending") {
      return null;
    }
    return isStillActiveSession(session, now) ? session.requestedAt : null;
  }

  async sweepExpiredNonces(_params?: { now?: number }): Promise<{
    linkSessionsExpired: number;
    pendingProofRequestsExpired: number;
    totalExpired: number;
  }> {
    return {
      linkSessionsExpired: 0,
      pendingProofRequestsExpired: 0,
      totalExpired: 0,
    };
  }
}

function isStillActiveSession(session: LinkSession, now: number): boolean {
  return session.expiresAt > now;
}

/**
 * Backward-compatible name used in earlier phase: keep a direct export so callers
 * continue to work while we migrate to `PersistedNonceStore` naming.
 */
export class LinkageStoreNonceResolver extends LinkageStorePersistedNonceStore {}
