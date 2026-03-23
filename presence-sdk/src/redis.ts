import type {
  LinkageStore,
  LinkageStoreCapabilities,
  LinkSession,
  ServiceBinding,
  LinkedDevice,
  LinkageAuditEvent,
  PendingProofRequest,
  PendingProofRequestStatus,
  ListAuditEventsFilter,
} from "./types.js";

interface RedisLinkageStoreData {
  sessions: Record<string, LinkSession>;
  bindings: Record<string, ServiceBinding>;
  pendingProofRequests: Record<string, PendingProofRequest>;
  devices: Record<string, LinkedDevice>;
  auditEvents: LinkageAuditEvent[];
}

export interface RedisLikeClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
}

export class RedisLinkageStore implements LinkageStore {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly client: RedisLikeClient,
    private readonly key = "presence:linkage:store"
  ) {}

  getCapabilities(): LinkageStoreCapabilities {
    return {
      kind: "redis",
      supportsAtomicMutations: false,
      supportsCrossProcessLocking: true,
      sqliteFirstNote: "Redis adapter is full-blob compatible today; migration target remains SQLite-first for small-team production.",
    };
  }

  async saveLinkSession(session: LinkSession): Promise<void> {
    await this.update((data) => {
      data.sessions[session.id] = { ...session };
    });
  }

  async getLinkSession(sessionId: string): Promise<LinkSession | null> {
    const data = await this.readData();
    return data.sessions[sessionId] ?? null;
  }

  async saveServiceBinding(binding: ServiceBinding): Promise<void> {
    await this.update((data) => {
      data.bindings[this.bindingKey(binding.serviceId, binding.accountId)] = { ...binding };
    });
  }

  async getServiceBinding(serviceId: string, accountId: string): Promise<ServiceBinding | null> {
    const data = await this.readData();
    return data.bindings[this.bindingKey(serviceId, accountId)] ?? null;
  }

  async listBindingsForDevice(deviceIss: string): Promise<ServiceBinding[]> {
    const data = await this.readData();
    return Object.values(data.bindings).filter((binding) => binding.deviceIss === deviceIss);
  }

  async savePendingProofRequest(request: PendingProofRequest): Promise<void> {
    await this.update((data) => {
      data.pendingProofRequests[request.id] = { ...request };
    });
  }

  async getPendingProofRequest(requestId: string): Promise<PendingProofRequest | null> {
    const data = await this.readData();
    return data.pendingProofRequests[requestId] ?? null;
  }

  async listPendingProofRequests(filter?: {
    serviceId?: string;
    accountId?: string;
    bindingId?: string;
    deviceIss?: string;
    statuses?: PendingProofRequestStatus[];
  }): Promise<PendingProofRequest[]> {
    const statuses = filter?.statuses ? new Set(filter.statuses) : null;
    const data = await this.readData();
    return Object.values(data.pendingProofRequests).filter((request) => {
      if (filter?.serviceId && request.serviceId !== filter.serviceId) return false;
      if (filter?.accountId && request.accountId !== filter.accountId) return false;
      if (filter?.bindingId && request.bindingId !== filter.bindingId) return false;
      if (filter?.deviceIss && request.deviceIss !== filter.deviceIss) return false;
      if (statuses && !statuses.has(request.status)) return false;
      return true;
    });
  }

  async getLinkedDevice(deviceIss: string): Promise<LinkedDevice | null> {
    const data = await this.readData();
    return data.devices[deviceIss] ?? null;
  }

  async saveLinkedDevice(device: LinkedDevice): Promise<void> {
    await this.update((data) => {
      data.devices[device.iss] = { ...device };
    });
  }

  async appendAuditEvent(event: LinkageAuditEvent): Promise<void> {
    await this.update((data) => {
      data.auditEvents.push({ ...event });
    });
  }

  async listAuditEvents(filter?: ListAuditEventsFilter): Promise<LinkageAuditEvent[]> {
    const data = await this.readData();
    const filtered = data.auditEvents.filter((event) => {
      if (filter?.serviceId && event.serviceId !== filter.serviceId) return false;
      if (filter?.accountId && event.accountId !== filter.accountId) return false;
      if (filter?.bindingId && event.bindingId !== filter.bindingId) return false;
      return true;
    });

    if (!filter || filter.limit == null) {
      return filtered.map((event) => ({ ...event }));
    }

    const limit = Math.floor(filter.limit);
    if (!Number.isFinite(limit) || limit <= 0) {
      return [];
    }

    const offset = Math.max(0, Math.floor(filter.offset ?? 0));
    return filtered.slice(offset, offset + limit).map((event) => ({ ...event }));
  }

  async mutate<T>(mutator: (store: LinkageStore) => Promise<T>): Promise<T> {
    let result!: T;
    const run = async () => {
      result = await mutator(this);
    };
    const queued = this.mutationQueue.then(run, run);
    this.mutationQueue = queued.then(() => undefined, () => undefined);
    await queued;
    return result;
  }

  private bindingKey(serviceId: string, accountId: string): string {
    return `${serviceId}:${accountId}`;
  }

  private async update(mutator: (data: RedisLinkageStoreData) => void): Promise<void> {
    const data = await this.readData();
    mutator(data);
    await this.client.set(this.key, JSON.stringify(data));
  }

  private async readData(): Promise<RedisLinkageStoreData> {
    const raw = await this.client.get(this.key);
    if (!raw) {
      return { sessions: {}, bindings: {}, pendingProofRequests: {}, devices: {}, auditEvents: [] };
    }

    try {
      const parsed = JSON.parse(raw) as RedisLinkageStoreData;
      return {
        sessions: parsed.sessions ?? {},
        bindings: parsed.bindings ?? {},
        pendingProofRequests: parsed.pendingProofRequests ?? {},
        devices: parsed.devices ?? {},
        auditEvents: parsed.auditEvents ?? [],
      };
    } catch {
      return { sessions: {}, bindings: {}, pendingProofRequests: {}, devices: {}, auditEvents: [] };
    }
  }
}
