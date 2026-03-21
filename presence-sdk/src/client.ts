/**
 * presence-sdk — PresenceClient
 *
 * Main SDK entry point for service integration.
 * Wraps presence-verifier with:
 *   - nonce lifecycle (create → issue → verify → mark used)
 *   - transport parsing (HTTP body → VerifierInput)
 *   - policy configuration
 *   - sensible defaults for development
 *   - persistent linkage / revoke / recovery flows
 */

import { verify as coreVerify, InMemoryTofuStore } from "presence-verifier";
import type { VerifierContext } from "presence-verifier";
import { createNonce, InMemoryManagedNonceStore } from "./nonce.js";
import { parsePresenceRequest } from "./transport.js";
import type {
  PresenceClientConfig,
  PresenceVerifyResult,
  GeneratedNonce,
  NonceOptions,
  ServicePolicy,
  NonceIssuer,
  NonceStore,
  CreateLinkedProofRequestResult,
  CreateLinkSessionOptions,
  CreateLinkSessionResult,
  CompleteLinkSessionResult,
  LinkedVerificationSuccess,
  LinkedVerificationResult,
  LinkedAccountReadiness,
  BindingMutationResult,
  LinkageAuditEvent,
  LinkageStore,
  ServiceBinding,
} from "./types.js";
import {
  InMemoryLinkageStore,
  createPresenceSnapshot,
  createAuditEvent,
  createRecoveryDetail,
  defaultLinkCompletion,
  randomId,
} from "./linkage.js";

export { ParseError } from "./transport.js";

function isNonceIssuer(store: NonceStore | undefined): store is NonceStore & NonceIssuer {
  return !!store && typeof (store as Partial<NonceIssuer>).issue === "function";
}

export class PresenceClient {
  private readonly config: PresenceClientConfig & { nonceTtlSeconds: number };
  private readonly managedNonces: InMemoryManagedNonceStore;
  private readonly tofuStore: InMemoryTofuStore;
  /**
   * Public for admin/debug surfaces that need direct store reads.
   * Prefer the higher-level client methods for normal linkage mutations.
   */
  readonly linkageStore: LinkageStore;
  private readonly warn: (msg: string) => void;
  private hasWarnedLegacyPlatform = false;

  constructor(config: PresenceClientConfig = {}) {
    const ttl = config.nonceTtlSeconds ?? 300;
    if (ttl > 300) {
      throw new Error("nonceTtlSeconds must not exceed 300 (Signal Spec v0.4)");
    }

    this.config = { ...config, nonceTtlSeconds: ttl };
    this.managedNonces = new InMemoryManagedNonceStore(ttl);
    this.tofuStore = new InMemoryTofuStore();
    this.linkageStore = config.linkageStore ?? new InMemoryLinkageStore();

    this.warn = config.silent ? () => {} : config.logger?.warn ?? ((msg) => console.warn(msg));

    if (!config.nonceStore) {
      this.warn("[presence-sdk] Using InMemoryNonceStore. Replace with a persistent store (e.g. Redis) in production.");
    } else if (!isNonceIssuer(config.nonceStore)) {
      this.warn(
        "[presence-sdk] Custom nonceStore does not implement issue(). PresenceClient.generateNonce() will issue into the SDK fallback store instead. For a single effective store, pass a ManagedNonceStore-compatible implementation or issue externally."
      );
    }
    if (!config.tofuStore) {
      this.warn("[presence-sdk] Using InMemoryTofuStore. Replace with a persistent store in production.");
    }
    if (!config.linkageStore) {
      this.warn("[presence-sdk] Using InMemoryLinkageStore. Replace with a persistent binding store in production.");
    }
  }

  generateNonce(options: NonceOptions = {}): GeneratedNonce {
    const nonce = createNonce({ ...options, ttlSeconds: this.config.nonceTtlSeconds });
    this.issueNonce(nonce.value, nonce.issuedAt);
    return nonce;
  }

  issueNonce(nonce: string, issuedAt = Math.floor(Date.now() / 1000)): void {
    this.nonceIssuer.issue(nonce, issuedAt);
  }

  async verify(body: unknown, nonce: string): Promise<PresenceVerifyResult> {
    let parsed;
    try {
      parsed = parsePresenceRequest(body);
    } catch (err) {
      return {
        verified: false,
        error: "ERR_INVALID_FORMAT",
        detail: err instanceof Error ? err.message : "transport parse error",
      };
    }

    return this.verifyParsed(parsed, nonce);
  }

  async verifyParsed(
    parsed: ReturnType<typeof parsePresenceRequest>,
    nonce: string
  ): Promise<PresenceVerifyResult> {
    if (this.config.requireExplicitPlatform && !parsed.platformExplicit) {
      return {
        verified: false,
        error: "ERR_INVALID_FORMAT",
        detail: "platform field is required by this SDK configuration",
      };
    }

    if (!parsed.platformExplicit && !this.hasWarnedLegacyPlatform) {
      this.warn(
        "[presence-sdk] Request omitted top-level platform. Legacy inference is still accepted for compatibility, but explicit platform is recommended and can be enforced via requireExplicitPlatform."
      );
      this.hasWarnedLegacyPlatform = true;
    }

    const mismatch = this._checkNonce(parsed.attestation, nonce);
    if (mismatch) return mismatch;

    return this._runVerify(parsed);
  }

  private get nonceIssuer(): NonceIssuer {
    if (isNonceIssuer(this.config.nonceStore)) {
      return this.config.nonceStore;
    }
    return this.managedNonces;
  }

  private _checkNonce(attestation: unknown, nonce: string): PresenceVerifyResult | null {
    if (
      typeof attestation === "object" &&
      attestation !== null &&
      "nonce" in attestation &&
      (attestation as { nonce: string }).nonce !== nonce
    ) {
      return {
        verified: false,
        error: "ERR_NONCE_INVALID",
        detail: "attestation nonce does not match issued nonce",
      };
    }
    return null;
  }

  private _runVerify(parsed: ReturnType<typeof parsePresenceRequest>): Promise<PresenceVerifyResult> {
    const effectivePolicy: ServicePolicy = {
      ...this.config.policy,
      ...(this.config.androidPackageName
        ? { android_package_name: this.config.androidPackageName }
        : {}),
    };

    const ctx: VerifierContext = {
      nonceStore: this.config.nonceStore ?? this.managedNonces.nonceStore,
      tofuStore: this.config.tofuStore ?? this.tofuStore,
      expectedAppId: this.config.iosAppId,
      appleRootCA: this.config.iosAppleRootCA,
    };

    return coreVerify(
      {
        attestation: parsed.attestation,
        deviceAttestationRawBytes: parsed.deviceAttestationRawBytes,
        signingPublicKey: parsed.signingPublicKey,
        platform: parsed.platform,
        policy: effectivePolicy,
      },
      ctx
    );
  }

  get nonceStore() {
    return this.config.nonceStore ?? this.managedNonces.nonceStore;
  }

  async createLinkSession(options: CreateLinkSessionOptions): Promise<CreateLinkSessionResult> {
    return this.runStoreMutation((store) => this.createLinkSessionWithStore(store, options));
  }

  private async createLinkSessionWithStore(
    store: LinkageStore,
    options: CreateLinkSessionOptions
  ): Promise<CreateLinkSessionResult> {
    const nonce = this.generateNonce({ ttlSeconds: options.ttlSeconds ?? this.config.nonceTtlSeconds });
    const sessionId = randomId("plink");
    const session = {
      id: sessionId,
      serviceId: options.serviceId,
      accountId: options.accountId,
      issuedNonce: nonce.value,
      requestedAt: nonce.issuedAt,
      expiresAt: nonce.expiresAt,
      status: "pending" as const,
      relinkOfBindingId: options.relinkOfBindingId,
      recoveryReason: options.recoveryReason,
      completion: options.completion,
      metadata: options.metadata,
    };

    session.completion = options.completion ?? defaultLinkCompletion(
      session.id,
      session.serviceId,
      session.accountId,
      nonce.value,
      nonce.expiresAt
    );
    await store.saveLinkSession(session);
    await this.appendAuditWithStore(store, {
      type: options.relinkOfBindingId ? "relink_started" : "link_started",
      serviceId: session.serviceId,
      accountId: session.accountId,
      bindingId: options.relinkOfBindingId,
      reason: options.recoveryReason,
      metadata: session.metadata,
    });
    return { session, nonce: nonce.value };
  }

  async createRelinkSession(options: CreateLinkSessionOptions): Promise<CreateLinkSessionResult> {
    return this.createLinkSession({ ...options, relinkOfBindingId: options.relinkOfBindingId });
  }

  async createLinkedProofRequest(params: {
    serviceId?: string;
    accountId: string;
  }): Promise<CreateLinkedProofRequestResult> {
    const serviceId = params.serviceId ?? this.config.serviceId;
    if (!serviceId) {
      throw new Error("serviceId required for createLinkedProofRequest");
    }

    const binding = await this.linkageStore.getServiceBinding(serviceId, params.accountId);
    if (!binding) {
      return {
        ok: false,
        state: "missing_binding",
        serviceId,
        accountId: params.accountId,
        binding: null,
        reason: "no_linked_binding",
      };
    }

    if (binding.status === "unlinked") {
      return {
        ok: false,
        state: "unlinked",
        serviceId,
        accountId: params.accountId,
        binding,
        reason: binding.recoveryReason ?? "binding_unlinked",
      };
    }

    if (binding.status === "revoked") {
      return {
        ok: false,
        state: "revoked",
        serviceId,
        accountId: params.accountId,
        binding,
        reason: binding.recoveryReason ?? "device_revoked",
      };
    }

    if (binding.status === "reauth_required" || binding.status === "recovery_pending") {
      return {
        ok: false,
        state: "recovery_pending",
        serviceId,
        accountId: params.accountId,
        binding,
        reason: binding.recoveryReason ?? "binding_recovery_required",
      };
    }

    return {
      ok: true,
      state: "linked",
      serviceId,
      accountId: params.accountId,
      binding,
      nonce: this.generateNonce(),
    };
  }

  async completeLinkSession(params: { sessionId: string; body: unknown }): Promise<CompleteLinkSessionResult> {
    const session = await this.linkageStore.getLinkSession(params.sessionId);
    if (!session) {
      return {
        verification: { verified: false, error: "ERR_INVALID_FORMAT", detail: "unknown link session" },
        session: {
          id: params.sessionId,
          serviceId: this.config.serviceId ?? "unknown",
          accountId: "unknown",
          issuedNonce: "",
          requestedAt: 0,
          expiresAt: 0,
          status: "expired",
        },
      };
    }

    let parsed;
    try {
      parsed = parsePresenceRequest(params.body);
    } catch (err) {
      return {
        verification: {
          verified: false,
          error: "ERR_INVALID_FORMAT",
          detail: err instanceof Error ? err.message : "transport parse error",
        },
        session,
      };
    }

    const verification = await this.verify(params.body, session.issuedNonce);
    if (!verification.verified) {
      return { verification, session };
    }

    return this.runStoreMutation(async (store) => {
      const currentSession = await store.getLinkSession(params.sessionId);
      if (!currentSession) {
        return {
          verification: { verified: false as const, error: "ERR_INVALID_FORMAT", detail: "unknown link session" },
          session: {
            id: params.sessionId,
            serviceId: this.config.serviceId ?? "unknown",
            accountId: "unknown",
            issuedNonce: "",
            requestedAt: 0,
            expiresAt: 0,
            status: "expired" as const,
          },
        };
      }

      const now = Math.floor(Date.now() / 1000);
      const existingDevice = await store.getLinkedDevice(verification.iss);
      const device = {
        ...(existingDevice ?? {
          iss: verification.iss,
          firstLinkedAt: now,
          metadata: undefined,
        }),
        iss: verification.iss,
        platform: parsed.platform,
        firstLinkedAt: existingDevice?.firstLinkedAt ?? now,
        lastVerifiedAt: now,
        lastAttestedAt: verification.iat,
        trustState: "active" as const,
        revokedAt: undefined,
      };
      await store.saveLinkedDevice(device);

      const existingBinding = await store.getServiceBinding(currentSession.serviceId, currentSession.accountId);
      const snapshot = createPresenceSnapshot(verification);
      const binding = {
        bindingId: existingBinding?.bindingId ?? currentSession.relinkOfBindingId ?? randomId("pbind"),
        serviceId: currentSession.serviceId,
        accountId: currentSession.accountId,
        deviceIss: verification.iss,
        createdAt: existingBinding?.createdAt ?? now,
        updatedAt: now,
        status: "linked" as const,
        lastLinkedAt: now,
        lastVerifiedAt: now,
        lastAttestedAt: verification.iat,
        lastSnapshot: snapshot,
        reauthRequiredAt: undefined,
        recoveryStartedAt: undefined,
        recoveryReason: undefined,
        revokedAt: undefined,
        unlinkedAt: undefined,
        metadata: { ...existingBinding?.metadata, ...currentSession.metadata },
      };
      await store.saveServiceBinding(binding);

      const completedSession = {
        ...currentSession,
        status: "consumed" as const,
        completedAt: now,
        linkedDeviceIss: verification.iss,
      };
      await store.saveLinkSession(completedSession);
      await this.appendAuditWithStore(store, {
        type: currentSession.relinkOfBindingId ? "recovery_completed" : "link_completed",
        serviceId: binding.serviceId,
        accountId: binding.accountId,
        bindingId: binding.bindingId,
        deviceIss: binding.deviceIss,
        reason: currentSession.recoveryReason,
        metadata: binding.metadata,
      });

      return { verification, session: completedSession, binding, device };
    });
  }

  async verifyLinkedAccount(
    body: unknown,
    bindingKey: { serviceId?: string; accountId: string; nonce: string }
  ): Promise<LinkedVerificationResult> {
    const serviceId = bindingKey.serviceId ?? this.config.serviceId;
    if (!serviceId) {
      return { verified: false, error: "ERR_INVALID_FORMAT", detail: "serviceId required for linked verification" };
    }

    const binding = await this.linkageStore.getServiceBinding(serviceId, bindingKey.accountId);
    if (!binding || binding.status === "unlinked") {
      return { verified: false, error: "ERR_INVALID_FORMAT", detail: "no active binding for account" };
    }
    if (binding.status === "revoked") {
      return {
        verified: false,
        error: "ERR_BINDING_RECOVERY_REQUIRED",
        detail: "binding revoked; relink required",
        binding,
        expectedDeviceIss: binding.deviceIss,
        recoveryAction: "relink",
      };
    }

    const verification = await this.verify(body, bindingKey.nonce);
    if (!verification.verified) {
      return verification;
    }

    return this.runStoreMutation(async (store) => {
      const currentBinding = await store.getServiceBinding(serviceId, bindingKey.accountId);
      if (!currentBinding || currentBinding.status === "unlinked") {
        return { verified: false as const, error: "ERR_INVALID_FORMAT", detail: "no active binding for account" };
      }
      if (currentBinding.status === "revoked") {
        return {
          verified: false as const,
          error: "ERR_BINDING_RECOVERY_REQUIRED" as const,
          detail: "binding revoked; relink required",
          binding: currentBinding,
          expectedDeviceIss: currentBinding.deviceIss,
          recoveryAction: "relink" as const,
        };
      }

      if (verification.iss !== currentBinding.deviceIss) {
        const recoverySession = this.config.bindingPolicy?.allowReplacementOnMismatch
          ? (await this.createLinkSessionWithStore(store, {
              serviceId,
              accountId: bindingKey.accountId,
              relinkOfBindingId: currentBinding.bindingId,
              recoveryReason: "binding_mismatch",
              metadata: { recovery: "binding_mismatch" },
            })).session
          : undefined;

        const now = Math.floor(Date.now() / 1000);
        const updatedBinding = {
          ...currentBinding,
          status: recoverySession ? "recovery_pending" as const : "reauth_required" as const,
          updatedAt: now,
          reauthRequiredAt: now,
          recoveryStartedAt: now,
          recoveryReason: "binding_mismatch",
        };
        await store.saveServiceBinding(updatedBinding);
        await this.appendAuditWithStore(store, {
          type: "binding_mismatch",
          serviceId,
          accountId: updatedBinding.accountId,
          bindingId: updatedBinding.bindingId,
          deviceIss: verification.iss,
          reason: "binding_mismatch",
        });

        return {
          verified: false as const,
          error: "ERR_BINDING_RECOVERY_REQUIRED" as const,
          detail: createRecoveryDetail(recoverySession ? "relink" : "reauth", updatedBinding.deviceIss, verification.iss),
          binding: updatedBinding,
          expectedDeviceIss: updatedBinding.deviceIss,
          actualDeviceIss: verification.iss,
          recoveryAction: recoverySession ? "relink" as const : "reauth" as const,
          recoverySession,
        };
      }

      const now = Math.floor(Date.now() / 1000);
      const snapshot = createPresenceSnapshot(verification);
      const updatedBinding = {
        ...currentBinding,
        updatedAt: now,
        status: "linked" as const,
        lastVerifiedAt: now,
        lastAttestedAt: verification.iat,
        lastSnapshot: snapshot,
        reauthRequiredAt: undefined,
        recoveryStartedAt: undefined,
        recoveryReason: undefined,
      };
      await store.saveServiceBinding(updatedBinding);
      await this.appendAuditWithStore(store, {
        type: "reauth_succeeded",
        serviceId,
        accountId: updatedBinding.accountId,
        bindingId: updatedBinding.bindingId,
        deviceIss: updatedBinding.deviceIss,
      });

      return { ...verification, binding: updatedBinding, snapshot };
    });
  }

  async getLinkedAccountReadiness(params: {
    serviceId?: string;
    accountId: string;
    now?: number;
    maxSnapshotAgeSeconds?: number;
    gracePeriodSeconds?: number;
  }): Promise<LinkedAccountReadiness> {
    const serviceId = params.serviceId ?? this.config.serviceId;
    if (!serviceId) {
      throw new Error("serviceId required for getLinkedAccountReadiness");
    }

    const checkedAt = params.now ?? Math.floor(Date.now() / 1000);
    const gracePeriodSeconds = params.gracePeriodSeconds ?? 15 * 60;
    const binding = await this.linkageStore.getServiceBinding(serviceId, params.accountId);
    if (!binding) {
      return {
        ready: false,
        state: "missing_binding",
        serviceId,
        accountId: params.accountId,
        checkedAt,
        reason: "no_linked_binding",
        binding: null,
      };
    }

    if (binding.status === "unlinked") {
      return {
        ready: false,
        state: "unlinked",
        serviceId,
        accountId: params.accountId,
        checkedAt,
        reason: "binding_unlinked",
        binding,
        snapshot: binding.lastSnapshot,
        validUntil: binding.lastSnapshot?.stateValidUntil,
      };
    }

    if (binding.status === "revoked") {
      return {
        ready: false,
        state: "revoked",
        serviceId,
        accountId: params.accountId,
        checkedAt,
        reason: "device_revoked",
        binding,
        snapshot: binding.lastSnapshot,
        validUntil: binding.lastSnapshot?.stateValidUntil,
      };
    }

    if (binding.status === "reauth_required" || binding.status === "recovery_pending") {
      return {
        ready: false,
        state: "recovery_pending",
        serviceId,
        accountId: params.accountId,
        checkedAt,
        reason: binding.recoveryReason ?? "binding_recovery_required",
        binding,
        snapshot: binding.lastSnapshot,
        validUntil: binding.lastSnapshot?.stateValidUntil,
      };
    }

    const snapshot = binding.lastSnapshot;
    if (!snapshot) {
      return {
        ready: false,
        state: "stale",
        serviceId,
        accountId: params.accountId,
        checkedAt,
        reason: "missing_snapshot",
        binding,
      };
    }

    if (!snapshot.pass) {
      const validUntil = snapshot.stateValidUntil;
      const withinGrace = validUntil != null && checkedAt <= validUntil + gracePeriodSeconds;
      return {
        ready: false,
        state: withinGrace ? "stale" : "not_ready",
        serviceId,
        accountId: params.accountId,
        checkedAt,
        reason: snapshot.reason ?? "last_snapshot_failed",
        binding,
        snapshot,
        validUntil,
      };
    }

    if (snapshot.stateValidUntil != null && snapshot.stateValidUntil <= checkedAt) {
      const withinGrace = checkedAt <= snapshot.stateValidUntil + gracePeriodSeconds;
      return {
        ready: false,
        state: withinGrace ? "stale" : "not_ready",
        serviceId,
        accountId: params.accountId,
        checkedAt,
        reason: withinGrace ? "snapshot_expired_grace" : "snapshot_expired",
        binding,
        snapshot,
        validUntil: snapshot.stateValidUntil,
      };
    }

    if (params.maxSnapshotAgeSeconds != null) {
      const freshnessBase = snapshot.attestedAt ?? snapshot.capturedAt ?? binding.lastVerifiedAt;
      if (checkedAt - freshnessBase > params.maxSnapshotAgeSeconds) {
        return {
          ready: false,
          state: "stale",
          serviceId,
          accountId: params.accountId,
          checkedAt,
          reason: "snapshot_too_old",
          binding,
          snapshot,
          validUntil: snapshot.stateValidUntil,
        };
      }
    }

    return {
      ready: true,
      state: "ready",
      serviceId,
      accountId: params.accountId,
      checkedAt,
      reason: "linked_snapshot_ready",
      binding,
      snapshot,
      validUntil: snapshot.stateValidUntil,
    };
  }

  async unlinkAccount(params: { serviceId?: string; accountId: string; reason?: string }): Promise<BindingMutationResult | null> {
    const serviceId = params.serviceId ?? this.config.serviceId;
    if (!serviceId) throw new Error("serviceId required for unlinkAccount");

    const binding = await this.linkageStore.getServiceBinding(serviceId, params.accountId);
    if (!binding) return null;

    return this.runStoreMutation(async (store) => {
      const currentBinding = await store.getServiceBinding(serviceId, params.accountId);
      if (!currentBinding) return null;

      const now = Math.floor(Date.now() / 1000);
      const updated = {
        ...currentBinding,
        status: "unlinked" as const,
        updatedAt: now,
        unlinkedAt: now,
        recoveryReason: params.reason,
      };
      await store.saveServiceBinding(updated);
      const auditEvent = await this.appendAuditWithStore(store, {
        type: "binding_unlinked",
        serviceId,
        accountId: updated.accountId,
        bindingId: updated.bindingId,
        deviceIss: updated.deviceIss,
        reason: params.reason,
      });
      return { binding: updated, auditEvent };
    });
  }

  async revokeDevice(params: { deviceIss: string; reason?: string }): Promise<LinkageAuditEvent[]> {
    const device = await this.linkageStore.getLinkedDevice(params.deviceIss);
    if (!device) return [];

    const now = Math.floor(Date.now() / 1000);
    device.trustState = "revoked";
    device.revokedAt = now;

    const bindings = await this.linkageStore.listBindingsForDevice(params.deviceIss);
    const events: LinkageAuditEvent[] = bindings.map((binding) => createAuditEvent({
      type: "device_revoked",
      serviceId: binding.serviceId,
      accountId: binding.accountId,
      bindingId: binding.bindingId,
      deviceIss: binding.deviceIss,
      reason: params.reason,
    }));
    await this.runStoreMutation(async (store) => {
      await store.saveLinkedDevice(device);
      for (const binding of bindings) {
        const updated = {
          ...binding,
          status: "revoked" as const,
          updatedAt: now,
          revokedAt: now,
          recoveryReason: params.reason,
        };
        await store.saveServiceBinding(updated);
      }
      for (const event of events) {
        await store.appendAuditEvent(event);
      }
    });
    return events;
  }

  async listAuditEvents(filter?: { serviceId?: string; accountId?: string; bindingId?: string }) {
    return this.linkageStore.listAuditEvents(filter);
  }

  cleanupNonces(): void {
    this.managedNonces.cleanup();
  }

  private async appendAudit(event: Omit<LinkageAuditEvent, "eventId" | "occurredAt"> & { occurredAt?: number }) {
    return this.appendAuditWithStore(this.linkageStore, event);
  }

  private async appendAuditWithStore(
    store: LinkageStore,
    event: Omit<LinkageAuditEvent, "eventId" | "occurredAt"> & { occurredAt?: number }
  ) {
    const auditEvent = createAuditEvent(event);
    await store.appendAuditEvent(auditEvent);
    return auditEvent;
  }

  private async runStoreMutation<T>(mutator: (store: LinkageStore) => Promise<T>): Promise<T> {
    if (this.linkageStore.mutate) {
      return this.linkageStore.mutate(mutator);
    }
    return mutator(this.linkageStore);
  }
}
