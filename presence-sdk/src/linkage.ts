import { mkdir, open, readFile, rename, rm, stat, unlink } from "fs/promises";
import { basename, dirname, join } from "path";
import type { PresenceVerifyResult, VerifierSuccess } from "./types.js";

export type LinkSessionStatus = "pending" | "consumed" | "expired" | "cancelled";
export type ServiceBindingStatus = "linked" | "revoked" | "unlinked" | "reauth_required" | "recovery_pending";
export type LinkedDeviceTrustState = "active" | "revoked" | "recovery_pending";
export type PendingProofRequestStatus = "pending" | "verified" | "recovery_required" | "expired" | "cancelled";
export type DevicePushTokenPlatform = "ios_apns";
export type DevicePushTokenEnvironment = "development" | "production";
export type DevicePushTokenStatus = "active" | "invalidated";
export type PendingProofSignalKind = "pending_proof_request.available";
export type PendingProofSignalDispatchState = "not_configured" | "no_registered_targets" | "dispatched" | "dispatch_failed";
export type BindingRecoveryAction = "reauth" | "relink" | "contact_support";
export type LinkCompletionMethod = "qr" | "deeplink" | "manual_code";
export type BindingEventType =
  | "link_started"
  | "link_completed"
  | "reauth_succeeded"
  | "reauth_failed"
  | "binding_mismatch"
  | "unlink_requested"
  | "binding_unlinked"
  | "device_revoked"
  | "relink_started"
  | "recovery_started"
  | "recovery_completed";

export interface LinkSession {
  id: string;
  serviceId: string;
  accountId: string;
  issuedNonce: string;
  requestedAt: number;
  expiresAt: number;
  status: LinkSessionStatus;
  completedAt?: number;
  linkedDeviceIss?: string;
  relinkOfBindingId?: string;
  recoveryReason?: string;
  completion?: LinkCompletion;
  metadata?: Record<string, string>;
}

export interface LinkedDevice {
  iss: string;
  platform: "ios" | "android";
  firstLinkedAt: number;
  lastVerifiedAt: number;
  lastAttestedAt: number;
  trustState: LinkedDeviceTrustState;
  revokedAt?: number;
  recoveryStartedAt?: number;
  pushTokens?: DevicePushToken[];
  metadata?: Record<string, string>;
}

export interface DevicePushToken {
  tokenId: string;
  platform: DevicePushTokenPlatform;
  token: string;
  environment: DevicePushTokenEnvironment;
  bundleId?: string;
  status: DevicePushTokenStatus;
  registeredAt: number;
  lastConfirmedAt: number;
  invalidatedAt?: number;
}

export interface PresenceSnapshot {
  deviceIss: string;
  capturedAt: number;
  attestedAt?: number;
  stateCreatedAt?: number;
  stateValidUntil?: number;
  human: boolean;
  pass: boolean;
  signals: readonly string[];
  reason?: string;
  source?: "verified_proof" | "local_measurement";
}

export interface ServiceBinding {
  bindingId: string;
  serviceId: string;
  accountId: string;
  /**
   * Backend/source-of-truth name for the linked device identifier.
   * Mobile/test-app local state stores this same value as `linkedDeviceIss`.
   */
  deviceIss: string;
  createdAt: number;
  updatedAt: number;
  status: ServiceBindingStatus;
  lastLinkedAt: number;
  lastVerifiedAt: number;
  lastAttestedAt: number;
  lastSnapshot?: PresenceSnapshot;
  revokedAt?: number;
  unlinkedAt?: number;
  reauthRequiredAt?: number;
  recoveryStartedAt?: number;
  recoveryReason?: string;
  metadata?: Record<string, string>;
}

export interface LinkageAuditEvent {
  eventId: string;
  type: BindingEventType;
  serviceId: string;
  accountId: string;
  bindingId?: string;
  deviceIss?: string;
  occurredAt: number;
  reason?: string;
  metadata?: Record<string, string>;
}

export interface PendingProofRequest {
  id: string;
  serviceId: string;
  accountId: string;
  bindingId: string;
  deviceIss: string;
  nonce: string;
  requestedAt: number;
  expiresAt: number;
  status: PendingProofRequestStatus;
  completedAt?: number;
  recoveryReason?: string;
  signal?: PendingProofSignal;
  signalDispatch?: PendingProofSignalDispatch;
  metadata?: Record<string, string>;
}

export interface PendingProofSignal {
  version: "1";
  signalId: string;
  kind: PendingProofSignalKind;
  serviceId: string;
  accountId: string;
  bindingId: string;
  deviceIss: string;
  requestId: string;
  requestedAt: number;
  expiresAt: number;
}

export interface PendingProofSignalDispatch {
  signalId: string;
  state: PendingProofSignalDispatchState;
  provider: string;
  targetCount: number;
  attemptedAt: number;
  deliveredAt?: number;
  providerMessageId?: string;
  error?: string;
}

export interface LinkCompletion {
  /**
   * `defaultLinkCompletion()` emits backend-relative API paths by default.
   * Rewrite them to public absolute URLs before exposing session completion
   * metadata to mobile or product UI.
   */
  method: LinkCompletionMethod;
  qrUrl?: string;
  deeplinkUrl?: string;
  fallbackCode?: string;
  expiresAt?: number;
  sessionStatusUrl?: string;
  completionApiUrl?: string;
  linkedNonceApiUrl?: string;
  verifyLinkedAccountApiUrl?: string;
  pendingProofRequestsApiUrl?: string;
}

export interface BindingPolicy {
  allowRelinkAfterUnlink?: boolean;
  allowReplacementOnMismatch?: boolean;
  requireFreshReauthOnRelink?: boolean;
}

export interface LinkageStore {
  saveLinkSession(session: LinkSession): Promise<void>;
  getLinkSession(sessionId: string): Promise<LinkSession | null>;
  saveServiceBinding(binding: ServiceBinding): Promise<void>;
  getServiceBinding(serviceId: string, accountId: string): Promise<ServiceBinding | null>;
  listBindingsForDevice(deviceIss: string): Promise<ServiceBinding[]>;
  savePendingProofRequest(request: PendingProofRequest): Promise<void>;
  getPendingProofRequest(requestId: string): Promise<PendingProofRequest | null>;
  listPendingProofRequests(filter?: {
    serviceId?: string;
    accountId?: string;
    bindingId?: string;
    deviceIss?: string;
    statuses?: PendingProofRequestStatus[];
  }): Promise<PendingProofRequest[]>;
  getLinkedDevice(deviceIss: string): Promise<LinkedDevice | null>;
  saveLinkedDevice(device: LinkedDevice): Promise<void>;
  appendAuditEvent(event: LinkageAuditEvent): Promise<void>;
  listAuditEvents(filter?: { serviceId?: string; accountId?: string; bindingId?: string }): Promise<LinkageAuditEvent[]>;
  mutate?<T>(mutator: (store: LinkageStore) => Promise<T>): Promise<T>;
}

export interface CreateLinkSessionOptions {
  serviceId: string;
  accountId: string;
  ttlSeconds?: number;
  metadata?: Record<string, string>;
  relinkOfBindingId?: string;
  recoveryReason?: string;
  completion?: LinkCompletion;
}

export interface CreateLinkSessionResult {
  session: LinkSession;
  nonce: string;
}

export interface CompleteLinkSessionInput {
  sessionId: string;
  body: unknown;
}

export interface CompleteLinkSessionResult {
  verification: PresenceVerifyResult;
  session: LinkSession;
  binding?: ServiceBinding;
  device?: LinkedDevice;
}

export interface LinkedVerificationSuccess extends VerifierSuccess {
  binding: ServiceBinding;
  snapshot: PresenceSnapshot;
}

export type LinkedAccountReadinessState =
  | "ready"
  | "not_ready"
  | "stale"
  | "recovery_pending"
  | "unlinked"
  | "revoked"
  | "missing_binding";

export interface LinkedAccountReadiness {
  ready: boolean;
  state: LinkedAccountReadinessState;
  serviceId: string;
  accountId: string;
  checkedAt: number;
  reason: string;
  binding: ServiceBinding | null;
  snapshot?: PresenceSnapshot;
  validUntil?: number;
}

export interface LinkedVerificationRecovery {
  verified: false;
  error: "ERR_BINDING_RECOVERY_REQUIRED";
  detail: string;
  binding: ServiceBinding;
  expectedDeviceIss: string;
  actualDeviceIss?: string;
  recoveryAction: BindingRecoveryAction;
  recoverySession?: LinkSession;
}

export interface BindingMutationResult {
  binding: ServiceBinding;
  auditEvent: LinkageAuditEvent;
}

export class InMemoryLinkageStore implements LinkageStore {
  private readonly sessions = new Map<string, LinkSession>();
  private readonly bindings = new Map<string, ServiceBinding>();
  private readonly pendingProofRequests = new Map<string, PendingProofRequest>();
  private readonly devices = new Map<string, LinkedDevice>();
  private readonly auditEvents: LinkageAuditEvent[] = [];
  private mutationQueue: Promise<void> = Promise.resolve();

  async saveLinkSession(session: LinkSession): Promise<void> {
    this.sessions.set(session.id, { ...session });
  }

  async getLinkSession(sessionId: string): Promise<LinkSession | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async saveServiceBinding(binding: ServiceBinding): Promise<void> {
    this.bindings.set(this.bindingKey(binding.serviceId, binding.accountId), { ...binding });
  }

  async getServiceBinding(serviceId: string, accountId: string): Promise<ServiceBinding | null> {
    return this.bindings.get(this.bindingKey(serviceId, accountId)) ?? null;
  }

  async listBindingsForDevice(deviceIss: string): Promise<ServiceBinding[]> {
    return [...this.bindings.values()]
      .filter((binding) => binding.deviceIss === deviceIss)
      .map((binding) => ({ ...binding }));
  }

  async savePendingProofRequest(request: PendingProofRequest): Promise<void> {
    this.pendingProofRequests.set(request.id, clonePendingProofRequest(request));
  }

  async getPendingProofRequest(requestId: string): Promise<PendingProofRequest | null> {
    const request = this.pendingProofRequests.get(requestId);
    return request ? clonePendingProofRequest(request) : null;
  }

  async listPendingProofRequests(filter?: {
    serviceId?: string;
    accountId?: string;
    bindingId?: string;
    deviceIss?: string;
    statuses?: PendingProofRequestStatus[];
  }): Promise<PendingProofRequest[]> {
    return filterPendingProofRequests([...this.pendingProofRequests.values()], filter)
      .map((request) => clonePendingProofRequest(request));
  }

  async getLinkedDevice(deviceIss: string): Promise<LinkedDevice | null> {
    return this.devices.get(deviceIss) ?? null;
  }

  async saveLinkedDevice(device: LinkedDevice): Promise<void> {
    this.devices.set(device.iss, { ...device });
  }

  async appendAuditEvent(event: LinkageAuditEvent): Promise<void> {
    this.auditEvents.push({ ...event });
  }

  async listAuditEvents(filter?: { serviceId?: string; accountId?: string; bindingId?: string }): Promise<LinkageAuditEvent[]> {
    return this.auditEvents
      .filter((event) => {
        if (filter?.serviceId && event.serviceId !== filter.serviceId) return false;
        if (filter?.accountId && event.accountId !== filter.accountId) return false;
        if (filter?.bindingId && event.bindingId !== filter.bindingId) return false;
        return true;
      })
      .map((event) => ({ ...event }));
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
}

interface FileLinkageStoreData {
  sessions: Record<string, LinkSession>;
  bindings: Record<string, ServiceBinding>;
  pendingProofRequests: Record<string, PendingProofRequest>;
  devices: Record<string, LinkedDevice>;
  auditEvents: LinkageAuditEvent[];
}

export class LinkageStoreCorruptionError extends Error {
  constructor(
    readonly filePath: string,
    message: string
  ) {
    super(message);
    this.name = "LinkageStoreCorruptionError";
  }
}

const FILE_LOCK_RETRY_MS = 10;
const FILE_LOCK_STALE_MS = 30_000;

function cloneMetadata(metadata?: Record<string, string>): Record<string, string> | undefined {
  return metadata ? { ...metadata } : undefined;
}

function cloneLinkCompletion(completion?: LinkCompletion): LinkCompletion | undefined {
  return completion ? { ...completion } : undefined;
}

function cloneDevicePushToken(token: DevicePushToken): DevicePushToken {
  return {
    ...token,
  };
}

function clonePendingProofSignal(signal?: PendingProofSignal): PendingProofSignal | undefined {
  return signal ? { ...signal } : undefined;
}

function clonePendingProofSignalDispatch(
  dispatch?: PendingProofSignalDispatch
): PendingProofSignalDispatch | undefined {
  return dispatch ? { ...dispatch } : undefined;
}

function clonePresenceSnapshot(snapshot?: PresenceSnapshot): PresenceSnapshot | undefined {
  if (!snapshot) return undefined;
  return {
    ...snapshot,
    signals: [...snapshot.signals],
  };
}

function cloneLinkSession(session: LinkSession): LinkSession {
  return {
    ...session,
    completion: cloneLinkCompletion(session.completion),
    metadata: cloneMetadata(session.metadata),
  };
}

function cloneLinkedDevice(device: LinkedDevice): LinkedDevice {
  return {
    ...device,
    pushTokens: device.pushTokens?.map((token) => cloneDevicePushToken(token)),
    metadata: cloneMetadata(device.metadata),
  };
}

function cloneServiceBinding(binding: ServiceBinding): ServiceBinding {
  return {
    ...binding,
    lastSnapshot: clonePresenceSnapshot(binding.lastSnapshot),
    metadata: cloneMetadata(binding.metadata),
  };
}

function clonePendingProofRequest(request: PendingProofRequest): PendingProofRequest {
  return {
    ...request,
    signal: clonePendingProofSignal(request.signal),
    signalDispatch: clonePendingProofSignalDispatch(request.signalDispatch),
    metadata: cloneMetadata(request.metadata),
  };
}

function cloneAuditEvent(event: LinkageAuditEvent): LinkageAuditEvent {
  return {
    ...event,
    metadata: cloneMetadata(event.metadata),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeFileLinkageStoreData(parsed: unknown): FileLinkageStoreData {
  if (!isRecord(parsed)) {
    throw new Error("linkage store root must be a JSON object");
  }

  return {
    sessions: isRecord(parsed.sessions) ? parsed.sessions as Record<string, LinkSession> : {},
    bindings: isRecord(parsed.bindings) ? parsed.bindings as Record<string, ServiceBinding> : {},
    pendingProofRequests: isRecord(parsed.pendingProofRequests)
      ? parsed.pendingProofRequests as Record<string, PendingProofRequest>
      : {},
    devices: isRecord(parsed.devices) ? parsed.devices as Record<string, LinkedDevice> : {},
    auditEvents: Array.isArray(parsed.auditEvents) ? parsed.auditEvents as LinkageAuditEvent[] : [],
  };
}

function filterAuditEvents(
  events: readonly LinkageAuditEvent[],
  filter?: { serviceId?: string; accountId?: string; bindingId?: string }
): LinkageAuditEvent[] {
  return events.filter((event) => {
    if (filter?.serviceId && event.serviceId !== filter.serviceId) return false;
    if (filter?.accountId && event.accountId !== filter.accountId) return false;
    if (filter?.bindingId && event.bindingId !== filter.bindingId) return false;
    return true;
  });
}

function filterPendingProofRequests(
  requests: readonly PendingProofRequest[],
  filter?: {
    serviceId?: string;
    accountId?: string;
    bindingId?: string;
    deviceIss?: string;
    statuses?: PendingProofRequestStatus[];
  }
): PendingProofRequest[] {
  const statuses = filter?.statuses ? new Set(filter.statuses) : null;
  return requests.filter((request) => {
    if (filter?.serviceId && request.serviceId !== filter.serviceId) return false;
    if (filter?.accountId && request.accountId !== filter.accountId) return false;
    if (filter?.bindingId && request.bindingId !== filter.bindingId) return false;
    if (filter?.deviceIss && request.deviceIss !== filter.deviceIss) return false;
    if (statuses && !statuses.has(request.status)) return false;
    return true;
  });
}

export class FileSystemLinkageStore implements LinkageStore {
  private static readonly pathQueues = new Map<string, Promise<void>>();

  constructor(private readonly filePath: string) {}

  async saveLinkSession(session: LinkSession): Promise<void> {
    await this.update((data) => {
      data.sessions[session.id] = cloneLinkSession(session);
    });
  }

  async getLinkSession(sessionId: string): Promise<LinkSession | null> {
    const data = await this.readData();
    const session = data.sessions[sessionId];
    return session ? cloneLinkSession(session) : null;
  }

  async saveServiceBinding(binding: ServiceBinding): Promise<void> {
    await this.update((data) => {
      data.bindings[this.bindingKey(binding.serviceId, binding.accountId)] = cloneServiceBinding(binding);
    });
  }

  async getServiceBinding(serviceId: string, accountId: string): Promise<ServiceBinding | null> {
    const data = await this.readData();
    const binding = data.bindings[this.bindingKey(serviceId, accountId)];
    return binding ? cloneServiceBinding(binding) : null;
  }

  async listBindingsForDevice(deviceIss: string): Promise<ServiceBinding[]> {
    const data = await this.readData();
    return Object.values(data.bindings)
      .filter((binding) => binding.deviceIss === deviceIss)
      .map((binding) => cloneServiceBinding(binding));
  }

  async savePendingProofRequest(request: PendingProofRequest): Promise<void> {
    await this.update((data) => {
      data.pendingProofRequests[request.id] = clonePendingProofRequest(request);
    });
  }

  async getPendingProofRequest(requestId: string): Promise<PendingProofRequest | null> {
    const data = await this.readData();
    const request = data.pendingProofRequests[requestId];
    return request ? clonePendingProofRequest(request) : null;
  }

  async listPendingProofRequests(filter?: {
    serviceId?: string;
    accountId?: string;
    bindingId?: string;
    deviceIss?: string;
    statuses?: PendingProofRequestStatus[];
  }): Promise<PendingProofRequest[]> {
    const data = await this.readData();
    return filterPendingProofRequests(Object.values(data.pendingProofRequests), filter)
      .map((request) => clonePendingProofRequest(request));
  }

  async getLinkedDevice(deviceIss: string): Promise<LinkedDevice | null> {
    const data = await this.readData();
    const device = data.devices[deviceIss];
    return device ? cloneLinkedDevice(device) : null;
  }

  async saveLinkedDevice(device: LinkedDevice): Promise<void> {
    await this.update((data) => {
      data.devices[device.iss] = cloneLinkedDevice(device);
    });
  }

  async appendAuditEvent(event: LinkageAuditEvent): Promise<void> {
    await this.update((data) => {
      data.auditEvents.push(cloneAuditEvent(event));
    });
  }

  async listAuditEvents(filter?: { serviceId?: string; accountId?: string; bindingId?: string }): Promise<LinkageAuditEvent[]> {
    const data = await this.readData();
    return filterAuditEvents(data.auditEvents, filter).map((event) => cloneAuditEvent(event));
  }

  async mutate<T>(mutator: (store: LinkageStore) => Promise<T>): Promise<T> {
    return this.runExclusiveMutation(async (data) => mutator(this.createTransactionalStore(data)));
  }

  private bindingKey(serviceId: string, accountId: string): string {
    return `${serviceId}:${accountId}`;
  }

  private async update(mutator: (data: FileLinkageStoreData) => void): Promise<void> {
    await this.runExclusiveMutation(async (data) => {
      mutator(data);
    });
  }

  private async readData(): Promise<FileLinkageStoreData> {
    await this.waitForPendingLocalWrites();
    return this.readDataFromDisk();
  }

  private async readDataFromDisk(): Promise<FileLinkageStoreData> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      try {
        return normalizeFileLinkageStoreData(JSON.parse(raw));
      } catch (error) {
        throw new LinkageStoreCorruptionError(
          this.filePath,
          `invalid linkage store JSON at ${this.filePath}: ${(error as Error).message}`
        );
      }
    } catch (error) {
      if (this.isErrnoException(error, "ENOENT")) {
        return { sessions: {}, bindings: {}, pendingProofRequests: {}, devices: {}, auditEvents: [] };
      }
      if (error instanceof LinkageStoreCorruptionError) {
        throw error;
      }
      throw error;
    }
  }

  private async writeData(data: FileLinkageStoreData): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = this.tempFilePath();
    const handle = await open(tempPath, "w");
    try {
      await handle.writeFile(JSON.stringify(data, null, 2), "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }

    await handle.close();
    await rename(tempPath, this.filePath);
    await this.syncDirectory(dirname(this.filePath));
  }

  private async runExclusiveMutation<T>(mutator: (data: FileLinkageStoreData) => Promise<T>): Promise<T> {
    return this.enqueueWrite(async () => {
      const releaseLock = await this.acquireFileLock();
      try {
        const data = await this.readDataFromDisk();
        const result = await mutator(data);
        await this.writeData(data);
        return result;
      } finally {
        await releaseLock();
      }
    });
  }

  private createTransactionalStore(data: FileLinkageStoreData): LinkageStore {
    const store: LinkageStore = {
      saveLinkSession: async (session) => {
        data.sessions[session.id] = cloneLinkSession(session);
      },
      getLinkSession: async (sessionId) => {
        const session = data.sessions[sessionId];
        return session ? cloneLinkSession(session) : null;
      },
      saveServiceBinding: async (binding) => {
        data.bindings[this.bindingKey(binding.serviceId, binding.accountId)] = cloneServiceBinding(binding);
      },
      getServiceBinding: async (serviceId, accountId) => {
        const binding = data.bindings[this.bindingKey(serviceId, accountId)];
        return binding ? cloneServiceBinding(binding) : null;
      },
      listBindingsForDevice: async (deviceIss) => Object.values(data.bindings)
        .filter((binding) => binding.deviceIss === deviceIss)
        .map((binding) => cloneServiceBinding(binding)),
      savePendingProofRequest: async (request) => {
        data.pendingProofRequests[request.id] = clonePendingProofRequest(request);
      },
      getPendingProofRequest: async (requestId) => {
        const request = data.pendingProofRequests[requestId];
        return request ? clonePendingProofRequest(request) : null;
      },
      listPendingProofRequests: async (filter) => filterPendingProofRequests(
        Object.values(data.pendingProofRequests),
        filter
      ).map((request) => clonePendingProofRequest(request)),
      getLinkedDevice: async (deviceIss) => {
        const device = data.devices[deviceIss];
        return device ? cloneLinkedDevice(device) : null;
      },
      saveLinkedDevice: async (device) => {
        data.devices[device.iss] = cloneLinkedDevice(device);
      },
      appendAuditEvent: async (event) => {
        data.auditEvents.push(cloneAuditEvent(event));
      },
      listAuditEvents: async (filter) => filterAuditEvents(data.auditEvents, filter).map((event) => cloneAuditEvent(event)),
      mutate: async <T>(nestedMutator: (nestedStore: LinkageStore) => Promise<T>) => nestedMutator(store),
    };

    return store;
  }

  private async enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    let result!: T;
    const current = FileSystemLinkageStore.pathQueues.get(this.filePath) ?? Promise.resolve();
    const run = async () => {
      result = await task();
    };
    const queued = current.then(run, run);
    const settled = queued.then(() => undefined, () => undefined);
    FileSystemLinkageStore.pathQueues.set(this.filePath, settled);
    try {
      await queued;
      return result;
    } finally {
      if (FileSystemLinkageStore.pathQueues.get(this.filePath) === settled) {
        FileSystemLinkageStore.pathQueues.delete(this.filePath);
      }
    }
  }

  private async waitForPendingLocalWrites(): Promise<void> {
    await (FileSystemLinkageStore.pathQueues.get(this.filePath) ?? Promise.resolve());
  }

  private async acquireFileLock(): Promise<() => Promise<void>> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const lockPath = `${this.filePath}.lock`;
    const startedAt = Date.now();

    for (;;) {
      try {
        const handle = await open(lockPath, "wx");
        await handle.writeFile(`${process.pid} ${Date.now()}\n`, "utf8");
        return async () => {
          try {
            await handle.close();
          } finally {
            await unlink(lockPath).catch((error) => {
              if (!this.isErrnoException(error, "ENOENT")) {
                throw error;
              }
            });
          }
        };
      } catch (error) {
        if (!this.isErrnoException(error, "EEXIST")) {
          throw error;
        }

        if (await this.isStaleLock(lockPath)) {
          await unlink(lockPath).catch((unlinkError) => {
            if (!this.isErrnoException(unlinkError, "ENOENT")) {
              throw unlinkError;
            }
          });
          continue;
        }

        if (Date.now() - startedAt > FILE_LOCK_STALE_MS * 2) {
          throw new Error(`timed out acquiring linkage store lock for ${this.filePath}`);
        }

        await this.sleep(FILE_LOCK_RETRY_MS);
      }
    }
  }

  private async isStaleLock(lockPath: string): Promise<boolean> {
    try {
      const info = await stat(lockPath);
      return Date.now() - info.mtimeMs > FILE_LOCK_STALE_MS;
    } catch (error) {
      if (this.isErrnoException(error, "ENOENT")) {
        return false;
      }
      throw error;
    }
  }

  private tempFilePath(): string {
    const token = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
    return join(dirname(this.filePath), `.${basename(this.filePath)}.${token}.tmp`);
  }

  private async syncDirectory(path: string): Promise<void> {
    try {
      const handle = await open(path, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // Best-effort directory fsync; some filesystems do not support it.
    }
  }

  private isErrnoException(error: unknown, code: string): boolean {
    return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === code;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export function defaultLinkCompletion(
  sessionId: string,
  serviceId: string,
  accountId: string,
  nonce: string,
  expiresAt: number
): LinkCompletion {
  const code = sessionId.slice(-6).toUpperCase();
  const linkedNonceApiUrl = `/presence/linked-accounts/${encodeURIComponent(accountId)}/nonce`;
  const verifyLinkedAccountApiUrl = `/presence/linked-accounts/${encodeURIComponent(accountId)}/verify`;
  const pendingProofRequestsApiUrl = `/presence/linked-accounts/${encodeURIComponent(accountId)}/pending-proof-requests`;
  const query =
    `session_id=${encodeURIComponent(sessionId)}` +
    `&service_id=${encodeURIComponent(serviceId)}` +
    `&account_id=${encodeURIComponent(accountId)}` +
    `&nonce=${encodeURIComponent(nonce)}` +
    `&nonce_url=${encodeURIComponent(linkedNonceApiUrl)}` +
    `&verify_url=${encodeURIComponent(verifyLinkedAccountApiUrl)}` +
    `&pending_url=${encodeURIComponent(pendingProofRequestsApiUrl)}` +
    `&status_url=${encodeURIComponent(`/presence/link-sessions/${encodeURIComponent(sessionId)}`)}`;
  return {
    method: "deeplink",
    qrUrl: `presence://link?${query}`,
    deeplinkUrl: `https://presence.local/link?${query}`,
    fallbackCode: code,
    expiresAt,
    sessionStatusUrl: `/presence/link-sessions/${encodeURIComponent(sessionId)}`,
    completionApiUrl: `/presence/link-sessions/${encodeURIComponent(sessionId)}/complete`,
    linkedNonceApiUrl,
    verifyLinkedAccountApiUrl,
    pendingProofRequestsApiUrl,
  };
}

export function createPresenceSnapshot(result: VerifierSuccess): PresenceSnapshot {
  return {
    deviceIss: result.iss,
    capturedAt: Math.floor(Date.now() / 1000),
    attestedAt: result.iat,
    stateCreatedAt: result.state_created_at,
    stateValidUntil: result.state_valid_until,
    human: result.human,
    pass: result.pass,
    signals: [...result.signals],
    source: "verified_proof",
  };
}

export function createAuditEvent(params: Omit<LinkageAuditEvent, "eventId" | "occurredAt"> & { occurredAt?: number }): LinkageAuditEvent {
  return {
    eventId: randomId("paudit"),
    occurredAt: params.occurredAt ?? Math.floor(Date.now() / 1000),
    ...params,
  };
}

export function createRecoveryDetail(action: BindingRecoveryAction, expectedDeviceIss: string, actualDeviceIss?: string): string {
  if (action === "reauth") {
    return `fresh Presence re-auth required for ${expectedDeviceIss}`;
  }
  if (action === "relink") {
    return actualDeviceIss
      ? `binding mismatch: expected ${expectedDeviceIss}, received ${actualDeviceIss}; relink required`
      : `binding recovery required for ${expectedDeviceIss}`;
  }
  return "manual support review required for linked Presence recovery";
}

export function fileLinkageStorePath(baseDir: string): string {
  return join(baseDir, "presence-linkage-store.json");
}

export function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}
