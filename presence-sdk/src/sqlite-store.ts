import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "fs";
import { dirname } from "path";
import Database from "better-sqlite3";
import type {
  LinkageStore,
  LinkageStoreCapabilities,
  LinkageAuditEvent,
  LinkSession,
  PendingProofRequest,
  ServiceBinding,
  PendingProofRequestStatus,
  LinkedDevice,
  ListAuditEventsFilter,
  PersistedNonceStore,
} from "./types.js";

/**
 * SQLite-first scaffold surface for the next store slice.
 *
 * This implementation keeps the file-backed store as default and provides only the
 * first persisted linkage slice: create/complete link session lifecycle.
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

export const SQLITE_LINKAGE_SCHEMA_VERSION = 1;

export const SQLITE_LINKAGE_SCHEMA: readonly SqliteSchemaArtifact[] = [
  {
    version: SQLITE_LINKAGE_SCHEMA_VERSION,
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

const SQLITE_LINKAGE_SCHEMA_MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS _schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
`.trim();

const LINKAGE_MIGRATIONS: ReadonlyArray<{ version: number; up: string[] }> = [
  {
    version: SQLITE_LINKAGE_SCHEMA_VERSION,
    up: [
      ...SQLITE_LINKAGE_SCHEMA.map((artifact) => artifact.sql),
      `INSERT OR IGNORE INTO _schema_migrations (version, applied_at) VALUES (${SQLITE_LINKAGE_SCHEMA_VERSION}, strftime('%s','now'));`,
    ],
  },
];


export class SqliteLinkageStore implements LinkageStore {
  readonly kind: "sqlite" = "sqlite";
  readonly dbPath: string;
  readonly options: SqliteLinkageStoreOptions;
  private readonly db: Database.Database;
  private txDepth = 0;
  private isClosed = false;
  private txQueue: Promise<unknown> = Promise.resolve();
  private readonly mutationScope = new AsyncLocalStorage<boolean>();

  constructor(options: SqliteLinkageStoreOptions) {
    this.options = { ...options, mode: options.mode ?? SQLITE_FIRST_MODE };
    this.dbPath = options.dbPath;
    if (this.dbPath !== ":memory:") {
      mkdirSync(dirname(this.dbPath), { recursive: true });
    }
    this.db = new Database(this.dbPath);
    this.getDb().exec(`PRAGMA journal_mode = ${options.journalMode ?? "WAL"};`);
    this.initializeSchema();
  }

  getCapabilities(): LinkageStoreCapabilities {
    return {
      kind: "sqlite",
      supportsAtomicMutations: true,
      supportsCrossProcessLocking: true,
      sqliteFirstNote: "Single-team/single-DB SQLite-first path is the intended next adapter.",
    };
  }

  close(): void {
    this.destroy();
  }

  destroy(): void {
    if (this.isClosed) {
      return;
    }
    if (this.txDepth > 0) {
      throw new Error("Cannot destroy SqliteLinkageStore while a transaction is active");
    }
    this.isClosed = true;
    this.db.close();
  }

  private getDb(): Database.Database {
    this.assertOpen();
    return this.db;
  }

  private assertOpen(): void {
    if (this.isClosed) {
      throw new Error("SqliteLinkageStore is closed");
    }
  }

  async saveLinkSession(session: LinkSession): Promise<void> {
    this.withTransaction(() => {
      const row = this.sessionToRow(session);
      const stmt = this.getDb().prepare(`
        INSERT INTO link_sessions (
          id,
          service_id,
          account_id,
          issued_nonce,
          requested_at,
          expires_at,
          status,
          completed_at,
          linked_device_iss,
          relink_of_binding_id,
          recovery_reason,
          completion_json,
          metadata_json
        ) VALUES (@id, @service_id, @account_id, @issued_nonce, @requested_at, @expires_at, @status, @completed_at, @linked_device_iss, @relink_of_binding_id, @recovery_reason, @completion_json, @metadata_json)
        ON CONFLICT(id) DO UPDATE SET
          service_id = excluded.service_id,
          account_id = excluded.account_id,
          issued_nonce = excluded.issued_nonce,
          requested_at = excluded.requested_at,
          expires_at = excluded.expires_at,
          status = excluded.status,
          completed_at = excluded.completed_at,
          linked_device_iss = excluded.linked_device_iss,
          relink_of_binding_id = excluded.relink_of_binding_id,
          recovery_reason = excluded.recovery_reason,
          completion_json = excluded.completion_json,
          metadata_json = excluded.metadata_json
      `);
      stmt.run(row);
    });
  }

  async getLinkSession(sessionId: string): Promise<LinkSession | null> {
    const row = this.getDb().prepare("SELECT * FROM link_sessions WHERE id = ?").get(sessionId) as SqliteLinkSessionRow | undefined;
    if (!row) {
      return null;
    }
    return this.rowToLinkSession(row);
  }

  async saveServiceBinding(binding: ServiceBinding): Promise<void> {
    this.withTransaction(() => {
      const stmt = this.getDb().prepare(`
        INSERT INTO service_bindings (
          binding_id,
          service_id,
          account_id,
          device_iss,
          created_at,
          updated_at,
          status,
          last_linked_at,
          last_verified_at,
          last_attested_at,
          last_snapshot_json,
          revoked_at,
          unlinked_at,
          reauth_required_at,
          recovery_started_at,
          recovery_reason,
          metadata_json
        ) VALUES (@binding_id, @service_id, @account_id, @device_iss, @created_at, @updated_at, @status, @last_linked_at, @last_verified_at, @last_attested_at, @last_snapshot_json, @revoked_at, @unlinked_at, @reauth_required_at, @recovery_started_at, @recovery_reason, @metadata_json)
        ON CONFLICT(binding_id) DO UPDATE SET
          binding_id = excluded.binding_id,
          service_id = excluded.service_id,
          account_id = excluded.account_id,
          device_iss = excluded.device_iss,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          status = excluded.status,
          last_linked_at = excluded.last_linked_at,
          last_verified_at = excluded.last_verified_at,
          last_attested_at = excluded.last_attested_at,
          last_snapshot_json = excluded.last_snapshot_json,
          revoked_at = excluded.revoked_at,
          unlinked_at = excluded.unlinked_at,
          reauth_required_at = excluded.reauth_required_at,
          recovery_started_at = excluded.recovery_started_at,
          recovery_reason = excluded.recovery_reason,
          metadata_json = excluded.metadata_json
      `);
      stmt.run({
        binding_id: binding.bindingId,
        service_id: binding.serviceId,
        account_id: binding.accountId,
        device_iss: binding.deviceIss,
        created_at: binding.createdAt,
        updated_at: binding.updatedAt,
        status: binding.status,
        last_linked_at: binding.lastLinkedAt,
        last_verified_at: binding.lastVerifiedAt,
        last_attested_at: binding.lastAttestedAt,
        last_snapshot_json: binding.lastSnapshot ? JSON.stringify(binding.lastSnapshot) : null,
        revoked_at: binding.revokedAt ?? null,
        unlinked_at: binding.unlinkedAt ?? null,
        reauth_required_at: binding.reauthRequiredAt ?? null,
        recovery_started_at: binding.recoveryStartedAt ?? null,
        recovery_reason: binding.recoveryReason ?? null,
        metadata_json: binding.metadata ? JSON.stringify(binding.metadata) : null,
      });
    });
  }

  async getServiceBinding(serviceId: string, accountId: string): Promise<ServiceBinding | null> {
    const row = this.getDb().prepare(
      "SELECT * FROM service_bindings WHERE service_id = ? AND account_id = ?"
    ).get(serviceId, accountId) as SqliteServiceBindingRow | undefined;
    if (!row) {
      return null;
    }
    return this.rowToServiceBinding(row);
  }

  async listBindingsForDevice(deviceIss: string): Promise<ServiceBinding[]> {
    const rows = this.getDb().prepare("SELECT * FROM service_bindings WHERE device_iss = ?").all(deviceIss) as SqliteServiceBindingRow[];
    return rows.map((row) => this.rowToServiceBinding(row));
  }

  async savePendingProofRequest(request: PendingProofRequest): Promise<void> {
    this.withTransaction(() => {
      const row = this.pendingProofRequestToRow(request);
      const stmt = this.getDb().prepare(`
        INSERT INTO pending_proof_requests (
          id,
          service_id,
          account_id,
          binding_id,
          device_iss,
          nonce,
          requested_at,
          expires_at,
          status,
          completed_at,
          recovery_reason,
          signal_json,
          signal_dispatch_json,
          metadata_json
        ) VALUES (@id, @service_id, @account_id, @binding_id, @device_iss, @nonce, @requested_at, @expires_at, @status, @completed_at, @recovery_reason, @signal_json, @signal_dispatch_json, @metadata_json)
        ON CONFLICT(id) DO UPDATE SET
          service_id = excluded.service_id,
          account_id = excluded.account_id,
          binding_id = excluded.binding_id,
          device_iss = excluded.device_iss,
          nonce = excluded.nonce,
          requested_at = excluded.requested_at,
          expires_at = excluded.expires_at,
          status = excluded.status,
          completed_at = excluded.completed_at,
          recovery_reason = excluded.recovery_reason,
          signal_json = excluded.signal_json,
          signal_dispatch_json = excluded.signal_dispatch_json,
          metadata_json = excluded.metadata_json
      `);
      stmt.run(row);
    });
  }

  async getPendingProofRequest(requestId: string): Promise<PendingProofRequest | null> {
    const row = this.getDb().prepare("SELECT * FROM pending_proof_requests WHERE id = ?").get(requestId) as SqlitePendingProofRequestRow | undefined;
    if (!row) {
      return null;
    }
    return this.rowToPendingProofRequest(row);
  }

  async listPendingProofRequests(filter?: {
    serviceId?: string;
    accountId?: string;
    bindingId?: string;
    deviceIss?: string;
    statuses?: PendingProofRequestStatus[];
  }): Promise<PendingProofRequest[]> {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (filter?.serviceId) {
      clauses.push("service_id = ?");
      params.push(filter.serviceId);
    }
    if (filter?.accountId) {
      clauses.push("account_id = ?");
      params.push(filter.accountId);
    }
    if (filter?.bindingId) {
      clauses.push("binding_id = ?");
      params.push(filter.bindingId);
    }
    if (filter?.deviceIss) {
      clauses.push("device_iss = ?");
      params.push(filter.deviceIss);
    }

    const statuses = filter?.statuses?.length
      ? new Set(filter.statuses)
      : null;
    if (statuses) {
      const placeholders = Array.from(statuses, () => "?").join(", ");
      clauses.push(`status IN (${placeholders})`);
      params.push(...statuses);
    }

    const sql = [
      "SELECT * FROM pending_proof_requests",
      clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
      "ORDER BY requested_at DESC, id DESC",
    ].filter(Boolean).join(" ");

    const rows = this.getDb().prepare(sql).all(...params) as SqlitePendingProofRequestRow[];
    return rows.map((row) => this.rowToPendingProofRequest(row));
  }

  async getLinkedDevice(deviceIss: string): Promise<LinkedDevice | null> {
    const row = this.getDb().prepare("SELECT * FROM linked_devices WHERE iss = ?").get(deviceIss) as SqliteLinkedDeviceRow | undefined;
    if (!row) {
      return null;
    }
    return this.rowToLinkedDevice(row);
  }

  async saveLinkedDevice(device: LinkedDevice): Promise<void> {
    this.withTransaction(() => {
      const stmt = this.getDb().prepare(`
        INSERT INTO linked_devices (
          iss,
          platform,
          first_linked_at,
          last_verified_at,
          last_attested_at,
          trust_state,
          revoked_at,
          recovery_started_at,
          metadata_json
        ) VALUES (@iss, @platform, @first_linked_at, @last_verified_at, @last_attested_at, @trust_state, @revoked_at, @recovery_started_at, @metadata_json)
        ON CONFLICT(iss) DO UPDATE SET
          iss = excluded.iss,
          platform = excluded.platform,
          first_linked_at = excluded.first_linked_at,
          last_verified_at = excluded.last_verified_at,
          last_attested_at = excluded.last_attested_at,
          trust_state = excluded.trust_state,
          revoked_at = excluded.revoked_at,
          recovery_started_at = excluded.recovery_started_at,
          metadata_json = excluded.metadata_json
      `);
      stmt.run({
        iss: device.iss,
        platform: device.platform,
        first_linked_at: device.firstLinkedAt,
        last_verified_at: device.lastVerifiedAt,
        last_attested_at: device.lastAttestedAt,
        trust_state: device.trustState,
        revoked_at: device.revokedAt ?? null,
        recovery_started_at: device.recoveryStartedAt ?? null,
        metadata_json: device.metadata ? JSON.stringify(device.metadata) : null,
      });
    });
  }

  async appendAuditEvent(event: LinkageAuditEvent): Promise<void> {
    this.withTransaction(() => {
      const stmt = this.getDb().prepare(`
        INSERT INTO audit_events (
          event_id,
          occurred_at,
          type,
          service_id,
          account_id,
          binding_id,
          device_iss,
          reason,
          metadata_json
        ) VALUES (@event_id, @occurred_at, @type, @service_id, @account_id, @binding_id, @device_iss, @reason, @metadata_json)
      `);
      stmt.run({
        event_id: event.eventId,
        occurred_at: event.occurredAt,
        type: event.type,
        service_id: event.serviceId,
        account_id: event.accountId,
        binding_id: event.bindingId ?? null,
        device_iss: event.deviceIss ?? null,
        reason: event.reason,
        metadata_json: event.metadata ? JSON.stringify(event.metadata) : null,
      });
    });
  }

  async listAuditEvents(filter?: ListAuditEventsFilter): Promise<LinkageAuditEvent[]> {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (filter?.serviceId) {
      clauses.push("service_id = ?");
      params.push(filter.serviceId);
    }
    if (filter?.accountId) {
      clauses.push("account_id = ?");
      params.push(filter.accountId);
    }
    if (filter?.bindingId) {
      clauses.push("binding_id = ?");
      params.push(filter.bindingId);
    }

    const hasLimit = filter?.limit !== undefined;
    const rawLimit = typeof filter?.limit === "number" ? filter.limit : undefined;
    const limit = hasLimit && Number.isFinite(rawLimit) ? Math.floor(rawLimit as number) : undefined;
    if (hasLimit && (typeof rawLimit !== "number" || !Number.isFinite(rawLimit) || rawLimit <= 0)) {
      return [];
    }
    const rawOffset = filter?.offset;
    const offset = hasLimit && typeof rawOffset === "number" ? Math.floor(rawOffset) : 0;
    const usePagination = hasLimit && limit !== undefined && limit > 0;

    const queryParts = [
      "SELECT * FROM audit_events",
      clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
      usePagination ? "ORDER BY rowid ASC" : "",
      usePagination ? "LIMIT ?" : "",
      usePagination && offset > 0 ? "OFFSET ?" : "",
    ].filter(Boolean);

    const query = this.getDb().prepare(queryParts.join(" "));
    const queryLimit = limit ?? 0;
    const rows = usePagination
      ? (offset > 0
          ? query.all(...params, queryLimit, offset) : query.all(...params, queryLimit)) as {
            event_id: string;
            occurred_at: number;
            type: string;
            service_id: string | null;
            account_id: string | null;
            binding_id: string | null;
            device_iss: string | null;
            reason: string | null;
            metadata_json: string | null;
          }[]
      : query.all(...params) as {
        event_id: string;
        occurred_at: number;
        type: string;
        service_id: string | null;
        account_id: string | null;
        binding_id: string | null;
        device_iss: string | null;
        reason: string | null;
        metadata_json: string | null;
      }[];

    return rows
      .map((row) => ({
        eventId: row.event_id,
        occurredAt: row.occurred_at,
        type: row.type as LinkageAuditEvent["type"],
        serviceId: row.service_id ?? "",
        accountId: row.account_id ?? "",
        bindingId: row.binding_id ?? undefined,
        deviceIss: row.device_iss ?? undefined,
        reason: row.reason ?? undefined,
        metadata: row.metadata_json ? safeJsonParse<Record<string, string>>(row.metadata_json) : undefined,
      }));
  }

  async mutate<T>(mutator: (store: LinkageStore) => Promise<T>): Promise<T> {
    return this.withAutoTransaction(() => mutator(this));
  }

  private initializeSchema(): void {
    const migrate = this.db.transaction(() => {
      this.db.exec(SQLITE_LINKAGE_SCHEMA_MIGRATIONS_TABLE);

      const currentVersion = Number(
        (
          this.db
            .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM _schema_migrations;")
            .get() as { version: number } | undefined
        )?.version ?? 0
      );

      for (const migration of LINKAGE_MIGRATIONS) {
        if (migration.version > currentVersion) {
          for (const statement of migration.up) {
            this.db.exec(statement);
          }
        }
      }
    });

    migrate();
  }

  /**
   * Run sync database mutations using a transaction when this is the outermost call.
   *
   * This is intentionally narrow: all store mutations are synchronous today,
   * so keeping the transaction boundary sync avoids wrapping sync better-sqlite3
   * calls in async closures.
   */
  private withTransaction<T>(operation: () => T): T {
    const shouldStartTransaction = this.txDepth === 0;
    this.txDepth += 1;
    if (shouldStartTransaction) {
      this.getDb().exec("BEGIN IMMEDIATE");
    }

    try {
      const result = operation();
      if (shouldStartTransaction) {
        this.getDb().exec("COMMIT");
      }
      return result;
    } catch (error) {
      if (shouldStartTransaction) {
        try {
          this.getDb().exec("ROLLBACK");
        } catch {
          // ignore rollback failures while surfacing original schema error
        }
      }
      throw error;
    } finally {
      this.txDepth -= 1;
    }
  }

  /**
   * Async wrapper for composition APIs that need to supply async mutators.
   *
   * In this store, async variants should call this entrypoint (e.g. mutate()),
   * while primary methods use withTransaction() directly.
   */
  private async withAutoTransaction<T>(operation: () => Promise<T>): Promise<T> {
    // Re-enter same async transaction context when nested: callers sharing the
    // same async stack should not create a separate queued transaction.
    if (this.mutationScope.getStore()) {
      return this.withAutoTransactionUnqueued(operation);
    }

    // Serialize async transaction entry points to avoid interleaving async
    // continuations from distinct calls into a shared write lock.
    const execution = () => this.mutationScope.run(true, () => this.withAutoTransactionUnqueued(operation));
    const queued = this.txQueue.then(execution, execution);

    this.txQueue = queued.catch(() => undefined);
    return queued;
  }

  private async withAutoTransactionUnqueued<T>(operation: () => Promise<T>): Promise<T> {
    const shouldStartTransaction = this.txDepth === 0;
    this.txDepth += 1;
    if (shouldStartTransaction) {
      this.getDb().exec("BEGIN IMMEDIATE");
    }

    try {
      const result = await operation();
      if (shouldStartTransaction) {
        this.getDb().exec("COMMIT");
      }
      return result;
    } catch (error) {
      if (shouldStartTransaction) {
        try {
          this.getDb().exec("ROLLBACK");
        } catch {
          // ignore rollback failures while surfacing original cause
        }
      }
      throw error;
    } finally {
      this.txDepth -= 1;
    }
  }

  private sessionToRow(session: LinkSession): Record<string, unknown> {
    return {
      id: session.id,
      service_id: session.serviceId,
      account_id: session.accountId,
      issued_nonce: session.issuedNonce,
      requested_at: session.requestedAt,
      expires_at: session.expiresAt,
      status: session.status,
      completed_at: session.completedAt ?? null,
      linked_device_iss: session.linkedDeviceIss ?? null,
      relink_of_binding_id: session.relinkOfBindingId ?? null,
      recovery_reason: session.recoveryReason ?? null,
      completion_json: session.completion ? JSON.stringify(session.completion) : null,
      metadata_json: session.metadata ? JSON.stringify(session.metadata) : null,
    };
  }

  private rowToLinkSession(row: SqliteLinkSessionRow): LinkSession {
    return {
      id: row.id,
      serviceId: row.service_id,
      accountId: row.account_id,
      issuedNonce: row.issued_nonce,
      requestedAt: row.requested_at,
      expiresAt: row.expires_at,
      status: row.status as LinkSession["status"],
      completedAt: row.completed_at ?? undefined,
      linkedDeviceIss: row.linked_device_iss ?? undefined,
      relinkOfBindingId: row.relink_of_binding_id ?? undefined,
      recoveryReason: row.recovery_reason ?? undefined,
      completion: row.completion_json ? safeJsonParse(row.completion_json) : undefined,
      metadata: row.metadata_json ? safeJsonParse(row.metadata_json) : undefined,
    };
  }

  private rowToServiceBinding(row: SqliteServiceBindingRow): ServiceBinding {
    return {
      bindingId: row.binding_id,
      serviceId: row.service_id,
      accountId: row.account_id,
      deviceIss: row.device_iss,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      status: row.status as ServiceBinding["status"],
      lastLinkedAt: row.last_linked_at,
      lastVerifiedAt: row.last_verified_at,
      lastAttestedAt: row.last_attested_at,
      lastSnapshot: row.last_snapshot_json ? safeJsonParse(row.last_snapshot_json) : undefined,
      revokedAt: row.revoked_at ?? undefined,
      unlinkedAt: row.unlinked_at ?? undefined,
      reauthRequiredAt: row.reauth_required_at ?? undefined,
      recoveryStartedAt: row.recovery_started_at ?? undefined,
      recoveryReason: row.recovery_reason ?? undefined,
      metadata: row.metadata_json ? safeJsonParse(row.metadata_json) : undefined,
    };
  }

  private rowToLinkedDevice(row: SqliteLinkedDeviceRow): LinkedDevice {
    return {
      iss: row.iss,
      platform: row.platform as LinkedDevice["platform"],
      firstLinkedAt: row.first_linked_at,
      lastVerifiedAt: row.last_verified_at,
      lastAttestedAt: row.last_attested_at,
      trustState: row.trust_state as LinkedDevice["trustState"],
      revokedAt: row.revoked_at ?? undefined,
      recoveryStartedAt: row.recovery_started_at ?? undefined,
      metadata: row.metadata_json ? safeJsonParse(row.metadata_json) : undefined,
    };
  }

  private pendingProofRequestToRow(request: PendingProofRequest): Record<string, unknown> {
    return {
      id: request.id,
      service_id: request.serviceId,
      account_id: request.accountId,
      binding_id: request.bindingId,
      device_iss: request.deviceIss,
      nonce: request.nonce,
      requested_at: request.requestedAt,
      expires_at: request.expiresAt,
      status: request.status,
      completed_at: request.completedAt ?? null,
      recovery_reason: request.recoveryReason ?? null,
      signal_json: request.signal ? JSON.stringify(request.signal) : null,
      signal_dispatch_json: request.signalDispatch ? JSON.stringify(request.signalDispatch) : null,
      metadata_json: request.metadata ? JSON.stringify(request.metadata) : null,
    };
  }

  private rowToPendingProofRequest(row: SqlitePendingProofRequestRow): PendingProofRequest {
    return {
      id: row.id,
      serviceId: row.service_id,
      accountId: row.account_id,
      bindingId: row.binding_id,
      deviceIss: row.device_iss,
      nonce: row.nonce,
      requestedAt: row.requested_at,
      expiresAt: row.expires_at,
      status: row.status as PendingProofRequest["status"],
      completedAt: row.completed_at ?? undefined,
      recoveryReason: row.recovery_reason ?? undefined,
      signal: row.signal_json ? safeJsonParse(row.signal_json) : undefined,
      signalDispatch: row.signal_dispatch_json ? safeJsonParse(row.signal_dispatch_json) : undefined,
      metadata: row.metadata_json ? safeJsonParse(row.metadata_json) : undefined,
    };
  }
}

export interface SqlitePersistedNonceStoreOptions {
  dbPath: string;
  mode?: "single-team" | "external";
}

/**
 * Result payload for one sweep over nonce-bearing rows.
 */
export interface PersistedNonceSweepResult {
  linkSessionsExpired: number;
  pendingProofRequestsExpired: number;
  totalExpired: number;
}

/**
 * SQLite-backed persisted-nonce resolver that reads issuance times directly from
 * link-session and pending-proof state tables.
 */
export class SqlitePersistedNonceStore implements PersistedNonceStore {
  private readonly db: Database.Database;
  private isClosed = false;

  constructor(options: SqlitePersistedNonceStoreOptions) {
    this.db = new Database(options.dbPath);
  }

  async resolvePendingProofNonceIssueTime(params: {
    serviceId: string;
    accountId: string;
    nonce: string;
    now: number;
  }): Promise<number | null> {
    const row = this.db
      .prepare(
        `SELECT requested_at
         FROM pending_proof_requests
         WHERE service_id = ? AND account_id = ? AND nonce = ? AND status = 'pending' AND expires_at > ?
         ORDER BY requested_at DESC
         LIMIT 1`
      )
      .get(params.serviceId, params.accountId, params.nonce, params.now) as { requested_at?: number } | undefined;

    return row?.requested_at ?? null;
  }

  async resolveLinkSessionIssueTime(params: { sessionId: string; now: number }): Promise<number | null> {
    const row = this.db
      .prepare(
        `SELECT requested_at
         FROM link_sessions
         WHERE id = ? AND status = 'pending' AND expires_at > ?
         LIMIT 1`
      )
      .get(params.sessionId, params.now) as { requested_at?: number } | undefined;

    return row?.requested_at ?? null;
  }

  async sweepExpiredNonces(params?: { now?: number }): Promise<PersistedNonceSweepResult> {
    const now = params?.now ?? Math.floor(Date.now() / 1000);

    const linkSessionsExpired = this.db.prepare(
      `UPDATE link_sessions
       SET status = 'expired', completed_at = COALESCE(completed_at, ?)
       WHERE status = 'pending' AND expires_at <= ?`
    ).run(now, now).changes;

    const pendingProofRequestsExpired = this.db.prepare(
      `UPDATE pending_proof_requests
       SET status = 'expired', completed_at = COALESCE(completed_at, ?)
       WHERE status = 'pending' AND expires_at <= ?`
    ).run(now, now).changes;

    return {
      linkSessionsExpired,
      pendingProofRequestsExpired,
      totalExpired: linkSessionsExpired + pendingProofRequestsExpired,
    };
  }

  close(): void {
    if (this.isClosed) {
      return;
    }
    this.isClosed = true;
    this.db.close();
  }
}

function safeJsonParse<T>(value: string): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

interface SqliteLinkSessionRow {
  id: string;
  service_id: string;
  account_id: string;
  issued_nonce: string;
  requested_at: number;
  expires_at: number;
  status: string;
  completed_at: number | null;
  linked_device_iss: string | null;
  relink_of_binding_id: string | null;
  recovery_reason: string | null;
  completion_json: string | null;
  metadata_json: string | null;
}

interface SqliteServiceBindingRow {
  binding_id: string;
  service_id: string;
  account_id: string;
  device_iss: string;
  created_at: number;
  updated_at: number;
  status: string;
  last_linked_at: number;
  last_verified_at: number;
  last_attested_at: number;
  last_snapshot_json: string | null;
  revoked_at: number | null;
  unlinked_at: number | null;
  reauth_required_at: number | null;
  recovery_started_at: number | null;
  recovery_reason: string | null;
  metadata_json: string | null;
}

interface SqlitePendingProofRequestRow {
  id: string;
  service_id: string;
  account_id: string;
  binding_id: string;
  device_iss: string;
  nonce: string;
  requested_at: number;
  expires_at: number;
  status: string;
  completed_at: number | null;
  recovery_reason: string | null;
  signal_json: string | null;
  signal_dispatch_json: string | null;
  metadata_json: string | null;
}

interface SqliteLinkedDeviceRow {
  iss: string;
  platform: string;
  first_linked_at: number;
  last_verified_at: number;
  last_attested_at: number;
  trust_state: string;
  revoked_at: number | null;
  recovery_started_at: number | null;
  metadata_json: string | null;
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
