/**
 * presence-sdk — Type Definitions
 * Service integration layer over presence-verifier
 */

import type {
  VerifierResult,
  ServicePolicy,
  Platform,
  NonceStore,
  TofuStore,
} from "presence-verifier";
import type {
  LinkageStore,
  BindingPolicy,
  LinkSessionStatus,
  ServiceBindingStatus,
  PendingProofRequestStatus,
  DevicePushTokenPlatform,
  DevicePushTokenEnvironment,
  DevicePushTokenStatus,
  LinkSession,
  LinkedDevice,
  DevicePushToken,
  ServiceBinding,
  PendingProofRequest,
  PendingProofSignalKind,
  PendingProofSignalDispatchState,
  PendingProofSignal,
  PendingProofSignalDispatch,
  PresenceSnapshot,
  CreateLinkSessionOptions,
  CreateLinkSessionResult,
  CompleteLinkSessionInput,
  CompleteLinkSessionResult,
  LinkedVerificationSuccess,
  LinkedVerificationRecovery,
  LinkedAccountReadiness,
  LinkedAccountReadinessState,
  BindingMutationResult,
  LinkageAuditEvent,
  LinkageStoreCapabilities,
  LinkCompletion,
  LinkCompletionMethod,
} from "./linkage.js";
import type {
  PresenceBackendFlow,
  PresenceCompletionEndpointContract,
  CompletionEndpointDescriptor,
  PresenceCompletionDescriptor,
  PresenceCompletionSessionResponse,
  PresenceRecoveryDescriptor,
  PresenceRecoveryResponse,
  PresenceCompletionSuccessResponse,
  PresenceAdminBindingSummary,
  PresenceAdminBindingsResponse,
  PresenceAuditEventsResponse,
  PresenceLinkedNonceResponse,
  PresenceLinkedProofRequestDescriptor,
  PresenceLinkedProofRequestResponse,
  PresencePendingProofRequestDescriptor,
  PresencePendingProofRequestResponse,
  PresencePendingProofRequestListResponse,
  PresenceLinkedAccountReadinessResponse,
  LinkSessionPublicBaseOptions,
} from "./api.js";
import type {
  RedisLikeClient,
} from "./redis.js";
import type {
  SqliteLinkageStoreOptions,
  SqliteSchemaArtifact,
  SqliteLinkageMappingRow,
} from "./sqlite-store.js";

export type {
  VerifierResult,
  VerifierSuccess,
  VerifierFailure,
  ServicePolicy,
  Platform,
  NonceStore,
  TofuStore,
  PresenceAttestation,
  PresenceErrorCode,
} from "presence-verifier";

export interface GeneratedNonce {
  value: string;
  issuedAt: number;
  expiresAt: number;
}

export interface NonceOptions {
  bytes?: number;
  ttlSeconds?: number;
}

export interface NonceIssuer {
  issue(nonce: string, now?: number): void;
}

export type ManagedNonceStore = NonceStore & NonceIssuer;

export interface RawPresenceRequestBody {
  attestation: unknown;
  device_attestation: string;
  signing_public_key?: string;
  platform?: "ios" | "android";
  link_context?: {
    service_id?: string;
    link_session_id?: string;
    binding_id?: string;
    /**
     * Stable mobile/backend flow labels.
     * `reauth` is still the transport value for linked "request PASS now"
     * operations even though product docs phrase that as proof on demand.
     */
    flow?: "initial_link" | "reauth" | "relink" | "recovery";
    recovery_code?: string;
    completion?: {
      method?: LinkCompletionMethod;
      return_url?: string;
      code?: string;
    };
  };
}

export interface ParsedPresenceRequest {
  attestation: import("presence-verifier").PresenceAttestation;
  deviceAttestationRawBytes: Uint8Array;
  signingPublicKey?: Uint8Array;
  platform: Platform;
  platformExplicit: boolean;
}

export interface PresenceClientConfig {
  policy?: ServicePolicy;
  linkageStore?: LinkageStore;
  serviceId?: string;
  bindingPolicy?: BindingPolicy;
  nonceStore?: NonceStore;
  tofuStore?: TofuStore;
  iosAppId?: string;
  iosAppleRootCA?: Uint8Array | string;
  androidPackageName?: string;
  nonceTtlSeconds?: number;
  requireExplicitPlatform?: boolean;
  pendingProofSignalTransport?: PendingProofSignalTransport;
  logger?: {
    warn?: (msg: string) => void;
  };
  silent?: boolean;
}

export type PresenceVerifyResult = VerifierResult;
export type LinkedVerificationResult = VerifierResult | LinkedVerificationSuccess | LinkedVerificationRecovery;
export type LinkedProofRequestState =
  | "linked"
  | "missing_binding"
  | "unlinked"
  | "revoked"
  | "recovery_pending";

export interface LinkedProofRequestReady {
  ok: true;
  state: "linked";
  serviceId: string;
  accountId: string;
  binding: ServiceBinding;
  nonce: GeneratedNonce;
}

export interface LinkedProofRequestUnavailable {
  ok: false;
  state: Exclude<LinkedProofRequestState, "linked">;
  serviceId: string;
  accountId: string;
  binding: ServiceBinding | null;
  reason: string;
}

export type CreateLinkedProofRequestResult = LinkedProofRequestReady | LinkedProofRequestUnavailable;

export interface PendingProofRequestReady {
  ok: true;
  state: "linked";
  serviceId: string;
  accountId: string;
  binding: ServiceBinding;
  request: PendingProofRequest;
}

export type CreatePendingProofRequestResult = PendingProofRequestReady | LinkedProofRequestUnavailable;

export interface RegisterDevicePushTokenOptions {
  deviceIss: string;
  token: string;
  platform?: DevicePushTokenPlatform;
  environment?: DevicePushTokenEnvironment;
  bundleId?: string;
  confirmedAt?: number;
}

export interface RegisterDevicePushTokenResult {
  device: LinkedDevice;
  pushToken: DevicePushToken;
  replacedTokens: DevicePushToken[];
}

export interface PendingProofSignalTransportPayload {
  request: PendingProofRequest;
  binding: ServiceBinding;
  device: LinkedDevice;
  signal: PendingProofSignal;
  targets: DevicePushToken[];
}

export interface PendingProofSignalTransportResult {
  provider?: string;
  deliveredAt?: number;
  providerMessageId?: string;
  targetCount?: number;
}

export interface PendingProofSignalTransport {
  deliver(
    params: PendingProofSignalTransportPayload
  ): Promise<PendingProofSignalTransportResult | void>;
}

export type {
  LinkSessionStatus,
  ServiceBindingStatus,
  PendingProofRequestStatus,
  DevicePushTokenPlatform,
  DevicePushTokenEnvironment,
  DevicePushTokenStatus,
  LinkSession,
  LinkedDevice,
  DevicePushToken,
  ServiceBinding,
  PendingProofRequest,
  PendingProofSignalKind,
  PendingProofSignalDispatchState,
  PendingProofSignal,
  PendingProofSignalDispatch,
  PresenceSnapshot,
  LinkageStore,
  BindingPolicy,
  CreateLinkSessionOptions,
  CreateLinkSessionResult,
  CompleteLinkSessionInput,
  CompleteLinkSessionResult,
  LinkedVerificationSuccess,
  LinkedVerificationRecovery,
  LinkedAccountReadiness,
  LinkedAccountReadinessState,
  BindingMutationResult,
  LinkageAuditEvent,
  LinkageStoreCapabilities,
  LinkCompletion,
  LinkCompletionMethod,
  PresenceBackendFlow,
  PresenceCompletionEndpointContract,
  CompletionEndpointDescriptor,
  PresenceCompletionDescriptor,
  PresenceCompletionSessionResponse,
  PresenceRecoveryDescriptor,
  PresenceRecoveryResponse,
  PresenceCompletionSuccessResponse,
  PresenceAdminBindingSummary,
  PresenceAdminBindingsResponse,
  PresenceAuditEventsResponse,
  PresenceLinkedNonceResponse,
  PresenceLinkedProofRequestDescriptor,
  PresenceLinkedProofRequestResponse,
  PresencePendingProofRequestDescriptor,
  PresencePendingProofRequestResponse,
  PresencePendingProofRequestListResponse,
  PresenceLinkedAccountReadinessResponse,
  LinkSessionPublicBaseOptions,
  RedisLikeClient,
  SqliteLinkageStoreOptions,
  SqliteSchemaArtifact,
  SqliteLinkageMappingRow,
};
