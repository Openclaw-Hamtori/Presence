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
  LinkSession,
  LinkedDevice,
  ServiceBinding,
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
  PresenceLinkedAccountReadinessResponse,
} from "./api.js";
import type { RedisLikeClient } from "./redis.js";

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
  androidPackageName?: string;
  nonceTtlSeconds?: number;
  requireExplicitPlatform?: boolean;
  logger?: {
    warn?: (msg: string) => void;
  };
  silent?: boolean;
}

export type PresenceVerifyResult = VerifierResult;
export type LinkedVerificationResult = VerifierResult | LinkedVerificationSuccess | LinkedVerificationRecovery;

export type {
  LinkSessionStatus,
  ServiceBindingStatus,
  LinkSession,
  LinkedDevice,
  ServiceBinding,
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
  PresenceLinkedAccountReadinessResponse,
  RedisLikeClient,
};
