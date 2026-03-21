import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import type { PresenceVerifyResult, VerifierSuccess } from "./types.js";

export type LinkSessionStatus = "pending" | "consumed" | "expired" | "cancelled";
export type ServiceBindingStatus = "linked" | "revoked" | "unlinked" | "reauth_required" | "recovery_pending";
export type LinkedDeviceTrustState = "active" | "revoked" | "recovery_pending";
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
  metadata?: Record<string, string>;
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

export interface LinkCompletion {
  method: LinkCompletionMethod;
  qrUrl?: string;
  deeplinkUrl?: string;
  fallbackCode?: string;
  expiresAt?: number;
  sessionStatusUrl?: string;
  completionApiUrl?: string;
  linkedNonceApiUrl?: string;
  verifyLinkedAccountApiUrl?: string;
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
  getLinkedDevice(deviceIss: string): Promise<LinkedDevice | null>;
  saveLinkedDevice(device: LinkedDevice): Promise<void>;
  appendAuditEvent(event: LinkageAuditEvent): Promise<void>;
  listAuditEvents(filter?: { serviceId?: string; accountId?: string; bindingId?: string }): Promise<LinkageAuditEvent[]>;
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
  private readonly devices = new Map<string, LinkedDevice>();
  private readonly auditEvents: LinkageAuditEvent[] = [];

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

  private bindingKey(serviceId: string, accountId: string): string {
    return `${serviceId}:${accountId}`;
  }
}

interface FileLinkageStoreData {
  sessions: Record<string, LinkSession>;
  bindings: Record<string, ServiceBinding>;
  devices: Record<string, LinkedDevice>;
  auditEvents: LinkageAuditEvent[];
}

export class FileSystemLinkageStore implements LinkageStore {
  private updateQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

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

  async listAuditEvents(filter?: { serviceId?: string; accountId?: string; bindingId?: string }): Promise<LinkageAuditEvent[]> {
    const data = await this.readData();
    return data.auditEvents.filter((event) => {
      if (filter?.serviceId && event.serviceId !== filter.serviceId) return false;
      if (filter?.accountId && event.accountId !== filter.accountId) return false;
      if (filter?.bindingId && event.bindingId !== filter.bindingId) return false;
      return true;
    });
  }

  private bindingKey(serviceId: string, accountId: string): string {
    return `${serviceId}:${accountId}`;
  }

  private async update(mutator: (data: FileLinkageStoreData) => void): Promise<void> {
    const data = await this.readData();
    mutator(data);
    await this.writeData(data);
  }

  private async readData(): Promise<FileLinkageStoreData> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as FileLinkageStoreData;
      return {
        sessions: parsed.sessions ?? {},
        bindings: parsed.bindings ?? {},
        devices: parsed.devices ?? {},
        auditEvents: parsed.auditEvents ?? [],
      };
    } catch {
      return { sessions: {}, bindings: {}, devices: {}, auditEvents: [] };
    }
  }

  private async writeData(data: FileLinkageStoreData): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(data, null, 2), "utf8");
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
  const query =
    `session_id=${encodeURIComponent(sessionId)}` +
    `&service_id=${encodeURIComponent(serviceId)}` +
    `&account_id=${encodeURIComponent(accountId)}` +
    `&nonce=${encodeURIComponent(nonce)}` +
    `&nonce_url=${encodeURIComponent(linkedNonceApiUrl)}` +
    `&verify_url=${encodeURIComponent(verifyLinkedAccountApiUrl)}` +
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
