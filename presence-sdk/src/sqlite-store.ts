import type {
  LinkageStore,
  LinkageStoreCapabilities,
  LinkageAuditEvent,
  LinkSession,
  PendingProofRequest,
  ServiceBinding,
  PendingProofRequestStatus,
  LinkedDevice,
} from "./types.js";

/**
 * SQLite-first scaffold surface for the next store slice.
 *
 * This file intentionally keeps runtime behavior inert: it's a contract + schema
 * preparation layer that does not alter the default file-backed happy path.
 */

export const SQLITE_FIRST_MODE = "single-team" as const;

export interface SqliteLinkageStoreOptions {
  /**
   * Filesystem DB path for SQLite persistence (for single-server / single-team use).
   */
  dbPath: string;
  /**
   * Keep this explicit while SQL adapter is in preparation.
   */
  mode?: typeof SQLITE_FIRST_MODE;
  /**
   * Optional, explicit opt-in for future transactional behavior toggles.
   */
  journalMode?: "WAL" | "DELETE";
}

export interface SqliteSchemaArtifact {
  version: number;
  sql: string;
}

export interface SqliteLinkageMappingRow {
  table: string;
  columns: readonly string[];
}

export const SQLITE_LINKAGE_SCHEMA: readonly SqliteSchemaArtifact[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS link_sessions (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  issued_nonce TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  completed_at INTEGER,
  linked_device_iss TEXT,
  relink_of_binding_id TEXT,
  recovery_reason TEXT,
  completion_json TEXT,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_link_sessions_service_account ON link_sessions(service_id, account_id);
CREATE INDEX IF NOT EXISTS idx_link_sessions_status_expires ON link_sessions(status, expires_at);

CREATE TABLE IF NOT EXISTS service_bindings (
  binding_id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  device_iss TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  last_linked_at INTEGER NOT NULL,
  last_verified_at INTEGER NOT NULL,
  last_attested_at INTEGER NOT NULL,
  last_snapshot_json TEXT,
  revoked_at INTEGER,
  unlinked_at INTEGER,
  reauth_required_at INTEGER,
  recovery_started_at INTEGER,
  recovery_reason TEXT,
  metadata_json TEXT,
  UNIQUE (service_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_service_bindings_device_iss ON service_bindings(device_iss);
CREATE INDEX IF NOT EXISTS idx_service_bindings_service_account ON service_bindings(service_id, account_id);

CREATE TABLE IF NOT EXISTS linked_devices (
  iss TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  first_linked_at INTEGER NOT NULL,
  last_verified_at INTEGER NOT NULL,
  last_attested_at INTEGER NOT NULL,
  trust_state TEXT NOT NULL,
  revoked_at INTEGER,
  recovery_started_at INTEGER,
  metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS pending_proof_requests (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  device_iss TEXT NOT NULL,
  nonce TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  completed_at INTEGER,
  recovery_reason TEXT,
  signal_json TEXT,
  signal_dispatch_json TEXT,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_requests_service_account ON pending_proof_requests(service_id, account_id);
CREATE INDEX IF NOT EXISTS idx_pending_requests_status_expires ON pending_proof_requests(status, expires_at);

CREATE TABLE IF NOT EXISTS audit_events (
  event_id TEXT PRIMARY KEY,
  occurred_at INTEGER NOT NULL,
  type TEXT NOT NULL,
  service_id TEXT,
  account_id TEXT,
  binding_id TEXT,
  device_iss TEXT,
  reason TEXT,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_events_service_account ON audit_events(service_id, account_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_occurred_at ON audit_events(occurred_at);
`.trim(),
  },
] as const;

const STUB_ERROR = "SQLiteLinkageStore is a prepared scaffold and not yet wired to runtime persistence";

function throwStoreStub(operation: string): never {
  throw new Error(`${operation}: ${STUB_ERROR}`);
}

/**
 * Explicitly adapter-shaped SQLite store scaffold.
 * Not bound into default runtime path yet.
 */
export class SqliteLinkageStore implements LinkageStore {
  readonly kind: "sqlite" = "sqlite";
  readonly dbPath: string;
  readonly options: SqliteLinkageStoreOptions;

  constructor(options: SqliteLinkageStoreOptions) {
    this.options = { ...options, mode: options.mode ?? SQLITE_FIRST_MODE };
    this.dbPath = options.dbPath;
  }

  getCapabilities(): LinkageStoreCapabilities {
    return {
      kind: "sqlite",
      supportsAtomicMutations: true,
      supportsCrossProcessLocking: true,
      sqliteFirstNote: "Single-team/single-DB SQLite-first path is the intended next adapter.",
    };
  }

  saveLinkSession(_session: LinkSession): Promise<void> {
    return throwStoreStub("saveLinkSession");
  }

  getLinkSession(_sessionId: string): Promise<LinkSession | null> {
    return throwStoreStub("getLinkSession");
  }

  saveServiceBinding(_binding: ServiceBinding): Promise<void> {
    return throwStoreStub("saveServiceBinding");
  }

  getServiceBinding(_serviceId: string, _accountId: string): Promise<ServiceBinding | null> {
    return throwStoreStub("getServiceBinding");
  }

  listBindingsForDevice(_deviceIss: string): Promise<ServiceBinding[]> {
    return throwStoreStub("listBindingsForDevice");
  }

  savePendingProofRequest(_request: PendingProofRequest): Promise<void> {
    return throwStoreStub("savePendingProofRequest");
  }

  getPendingProofRequest(_requestId: string): Promise<PendingProofRequest | null> {
    return throwStoreStub("getPendingProofRequest");
  }

  listPendingProofRequests(_filter?: {
    serviceId?: string;
    accountId?: string;
    bindingId?: string;
    deviceIss?: string;
    statuses?: PendingProofRequestStatus[];
  }): Promise<PendingProofRequest[]> {
    return throwStoreStub("listPendingProofRequests");
  }

  getLinkedDevice(_deviceIss: string): Promise<LinkedDevice | null> {
    return throwStoreStub("getLinkedDevice");
  }

  saveLinkedDevice(_device: LinkedDevice): Promise<void> {
    return throwStoreStub("saveLinkedDevice");
  }

  appendAuditEvent(_event: LinkageAuditEvent): Promise<void> {
    return throwStoreStub("appendAuditEvent");
  }

  listAuditEvents(_filter?: { serviceId?: string; accountId?: string; bindingId?: string }): Promise<LinkageAuditEvent[]> {
    return throwStoreStub("listAuditEvents");
  }

  async mutate<T>(mutator: (store: LinkageStore) => Promise<T>): Promise<T> {
    throwStoreStub("mutate");
    throw new Error("unreachable");
  }
}

export function renderSqliteSchema(): string {
  return SQLITE_LINKAGE_SCHEMA.map((entry) => entry.sql).join("\n\n");
}

export const SQLITE_LINKAGE_MAPPINGS: readonly SqliteLinkageMappingRow[] = [
  { table: "link_sessions", columns: [
    "id",
    "service_id",
    "account_id",
    "issued_nonce",
    "requested_at",
    "expires_at",
    "status",
    "completed_at",
    "linked_device_iss",
    "relink_of_binding_id",
    "recovery_reason",
    "completion_json",
    "metadata_json",
  ] },
  { table: "service_bindings", columns: [
    "binding_id",
    "service_id",
    "account_id",
    "device_iss",
    "created_at",
    "updated_at",
    "status",
    "last_linked_at",
    "last_verified_at",
    "last_attested_at",
    "last_snapshot_json",
    "revoked_at",
    "unlinked_at",
    "reauth_required_at",
    "recovery_started_at",
    "recovery_reason",
    "metadata_json",
  ] },
  { table: "linked_devices", columns: [
    "iss",
    "platform",
    "first_linked_at",
    "last_verified_at",
    "last_attested_at",
    "trust_state",
    "revoked_at",
    "recovery_started_at",
    "metadata_json",
  ] },
  { table: "pending_proof_requests", columns: [
    "id",
    "service_id",
    "account_id",
    "binding_id",
    "device_iss",
    "nonce",
    "requested_at",
    "expires_at",
    "status",
    "completed_at",
    "recovery_reason",
    "signal_json",
    "signal_dispatch_json",
    "metadata_json",
  ] },
  { table: "audit_events", columns: [
    "event_id",
    "occurred_at",
    "type",
    "service_id",
    "account_id",
    "binding_id",
    "device_iss",
    "reason",
    "metadata_json",
  ] },
] as const;
