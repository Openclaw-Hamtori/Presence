/**
 * presence-sdk
 * Presence SDK — Service Integration Layer
 *
 * Based on:
 *   - Presence Signal Spec v0.4
 *   - Presence Verifier Spec v0.4
 *   - Presence Android Platform Appendix v0.1
 */

export { PresenceClient } from "./client.js";
export { createNonce, generateNonce, InMemoryManagedNonceStore } from "./nonce.js";
export { parsePresenceRequest, ParseError } from "./transport.js";
export {
  InMemoryLinkageStore,
  FileSystemLinkageStore,
  createPresenceSnapshot,
  createAuditEvent,
  defaultLinkCompletion,
  fileLinkageStorePath,
} from "./linkage.js";
export { RedisLinkageStore } from "./redis.js";
export {
  createCompletionDescriptor,
  createCompletionSessionResponse,
  createRecoveryResponse,
  createCompletionSuccessResponse,
  createAuditEventsResponse,
  createLinkedNonceResponse,
  createLinkedAccountReadinessResponse,
} from "./api.js";

export type {
  PresenceClientConfig,
  PresenceVerifyResult,
  LinkedVerificationResult,
  GeneratedNonce,
  NonceOptions,
  NonceIssuer,
  ManagedNonceStore,
  RawPresenceRequestBody,
  ParsedPresenceRequest,
  ServicePolicy,
  Platform,
  PresenceAttestation,
  PresenceErrorCode,
  VerifierResult,
  VerifierSuccess,
  VerifierFailure,
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
  LinkSession,
  LinkedDevice,
  ServiceBinding,
  PresenceSnapshot,
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
} from "./types.js";
