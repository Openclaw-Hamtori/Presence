import type { LinkageStore } from "./types.js";

export interface PersistedNonceResolver {
  resolvePendingProofNonceIssueTime(params: {
    serviceId: string;
    accountId: string;
    nonce: string;
    now: number;
  }): Promise<number | null>;

  resolveLinkSessionIssueTime(params: {
    sessionId: string;
    now: number;
  }): Promise<number | null>;
}

/**
 * Resolve persisted nonces from linkage sessions/requests so verification paths can
 * rehydrate nonces after process restarts.
 */
export class LinkageStoreNonceResolver implements PersistedNonceResolver {
  constructor(private readonly linkageStore: LinkageStore) {}

  async resolvePendingProofNonceIssueTime(params: {
    serviceId: string;
    accountId: string;
    nonce: string;
    now: number;
  }): Promise<number | null> {
    const requests = await this.linkageStore.listPendingProofRequests({
      serviceId: params.serviceId,
      accountId: params.accountId,
      statuses: ["pending"],
    });

    const request = requests.find((entry) => entry.nonce === params.nonce && entry.expiresAt > params.now);
    return request?.requestedAt ?? null;
  }

  async resolveLinkSessionIssueTime(params: {
    sessionId: string;
    now: number;
  }): Promise<number | null> {
    const session = await this.linkageStore.getLinkSession(params.sessionId);
    if (!session) {
      return null;
    }
    if (session.status !== "pending") {
      return null;
    }
    return session.requestedAt;
  }
}
