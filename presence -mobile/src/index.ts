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
  computeStateStatus,
  isStateUsable,
  shouldRenew,
  formatTimeRemaining,
  secondsUntilNextMeasurement,
  updatePresenceSnapshot,
  addOrUpdateServiceBinding,
  attachLinkSession,
  markBindingForRecovery,
  unlinkServiceBinding,
} from "./state/presenceState";

export { buildPresenceLinkUrl, parsePresenceLinkUrl } from "./deeplink";
export type { LinkCompletionEnvelope } from "./deeplink";

export {
  isHealthKitAvailable,
  requestHealthKitPermissions,
  readBiometricWindow,
} from "./health/healthkit";
export { evaluatePass } from "./health/pass";
export { ensureDeviceKey, deleteDeviceKey, deriveIss } from "./crypto/index";
export { usePresenceState } from "./ui/usePresenceState";
export type { UsePresenceStateResult, PresenceHookPhase } from "./ui/usePresenceState";
export { usePresenceRenewal } from "./ui/usePresenceRenewal";
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
export { syncLinkedBindings, flushQueuedLinkedBindingSyncs } from "./sync/linkedBindings";
export { hasPendingLinkedBindingSyncJobs, clearLinkedBindingSyncQueue } from "./sync/queue";
export type { LinkedBindingSyncError, LinkedBindingSyncResult } from "./sync/linkedBindings";
export type { LinkedBindingSyncJob, LinkedBindingSyncJobKind } from "./sync/queue";

export type {
  PresenceAttestation,
  PresenceSignal,
  PresenceState,
  PresenceStateStatus,
  LinkedDevice,
  LinkSession,
  ServiceBinding,
  PresenceSnapshot,
  PresenceTransportPayload,
  PresenceBindingSync,
  PresenceMobileErrorCode,
  BiometricWindow,
  PassResult,
  Result,
  LinkFlow,
  LinkCompletionMethod,
} from "./types/index";
export { PresenceMobileError, ok, err } from "./types/index";
