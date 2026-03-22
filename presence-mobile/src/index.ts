/**
 * presence-mobile
 * Presence — Mobile Client
 */

export { measure, prove, proveMeasured, markBindingMismatchForRecovery, locallyUnlinkBinding } from "./service";
export type { MeasureOptions, MeasureResult, ProveOptions, ProveResult } from "./service";

export {
  loadPresenceState,
  savePresenceState,
  clearPresenceState,
  isStateUsable,
  updatePresenceSnapshot,
  addOrUpdateServiceBinding,
  attachLinkSession,
  replacePendingProofRequests,
  upsertPendingProofRequest,
  removePendingProofRequest,
  getActivePendingProofRequests,
  markBindingForRecovery,
  unlinkServiceBinding,
} from "./state/presenceState";

export { buildPresenceLinkUrl, parsePresenceLinkUrl } from "./deeplink";
export type { LinkCompletionEnvelope } from "./deeplink";
export { getInitialPresenceLink, subscribeToPresenceLinks } from "./ui/connectionLinking";

export {
  isHealthKitAvailable,
  requestHealthKitPermissions,
  readBiometricWindow,
} from "./health/healthkit";
export { evaluatePass } from "./health/pass";
export { ensureDeviceKey, deleteDeviceKey, deriveIss } from "./crypto/index";
export { usePresenceState } from "./ui/usePresenceState";
export type { UsePresenceStateResult, PresenceHookPhase } from "./ui/usePresenceState";
export { usePresenceBackgroundSync } from "./ui/usePresenceBackgroundSync";
export {
  isBackgroundRefreshSupported,
  scheduleBackgroundRefresh,
  finishBackgroundRefresh,
  consumePendingBackgroundRefresh,
  addBackgroundRefreshListener,
  getBackgroundRefreshDiagnostics,
} from "./backgroundRefresh";
export type { BackgroundRefreshDiagnostics } from "./backgroundRefresh";
export { OnboardingScreen } from "./ui/screens/OnboardingScreen";
export { ConnectionFlowScreen } from "./ui/screens/ConnectionFlowScreen";
export { PresenceStatusCard } from "./ui/components/PresenceStatusCard";
export { syncLinkedBindings, flushQueuedLinkedBindingSyncs, submitLinkedBindingProof } from "./sync/linkedBindings";
export { syncPendingProofRequests, submitPendingProofRequest } from "./sync/pendingProofRequests";
export { hasPendingLinkedBindingSyncJobs, clearLinkedBindingSyncQueue } from "./sync/queue";
export type {
  LinkedBindingSyncError,
  LinkedBindingSyncResult,
  LinkedBindingProofSubmissionStatus,
  LinkedBindingProofSubmissionResult,
} from "./sync/linkedBindings";
export type {
  PendingProofRequestSyncError,
  PendingProofRequestSyncResult,
  PendingProofRequestSubmissionResult,
} from "./sync/pendingProofRequests";
export type { LinkedBindingSyncJob, LinkedBindingSyncJobKind } from "./sync/queue";

export type {
  PresenceAttestation,
  PresenceSignal,
  PresenceState,
  LinkedDevice,
  LinkSession,
  ServiceBinding,
  PendingProofRequest,
  PresenceSnapshot,
  PresenceTransportPayload,
  PresenceBindingSync,
  PresenceMobileErrorCode,
  BiometricWindow,
  PassResult,
  Result,
  LinkFlow,
  LinkCompletionMethod,
  PendingProofRequestStatus,
} from "./types/index";
export { PresenceMobileError, ok, err } from "./types/index";
