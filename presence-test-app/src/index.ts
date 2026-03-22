/**
 * presence-mobile
 * Presence — Mobile Client
 * iOS implementation (React Native CLI)
 *
 * Based on:
 *   - Presence Signal Spec v0.4
 *   - Presence Mobile Client Flow v0.4
 *   - Presence Android Platform Appendix v0.1 (iOS path)
 */

// INTENTIONAL_FORK: test app export surface includes app-only debugging and validation helpers.

// ─── Core service ─────────────────────────────────────────────────────────────
export { measure, prove, proveMeasured } from "./service";
export type { MeasureOptions, MeasureResult, ProveOptions, ProveResult } from "./service";

// ─── State ────────────────────────────────────────────────────────────────────
export {
  loadPresenceState,
  savePresenceState,
  clearPresenceState,
  isStateUsable,
  replacePendingProofRequests,
  upsertPendingProofRequest,
  removePendingProofRequest,
  getActivePendingProofRequests,
} from "./state/presenceState";

// ─── Health ───────────────────────────────────────────────────────────────────
export {
  isHealthKitAvailable,
  requestHealthKitPermissions,
  readBiometricWindow,
} from "./health/healthkit";
export { evaluatePass } from "./health/pass";

// ─── Crypto ───────────────────────────────────────────────────────────────────
export { ensureDeviceKey, deleteDeviceKey, deriveIss } from "./crypto/index";

// ─── UI ───────────────────────────────────────────────────────────────────────
export { usePresenceState } from "./ui/usePresenceState";
export type { UsePresenceStateResult, PresenceHookPhase } from "./ui/usePresenceState";
export {
  isPushNotificationsSupported,
  getPushAuthorizationStatus,
  ensurePushNotificationsRegistered,
  consumeInitialPushNotificationResponse,
  addPushNotificationListener,
  extractPendingProofWakeSignal,
} from "./pushNotifications";
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
export { PresenceStatusCard } from "./ui/components/PresenceStatusCard";
export { isQrScannerSupported, scanQrCode } from "./qrScanner";
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
  PresencePushAuthorizationStatus,
  PresencePushRegistrationRequestResult,
  PresencePushTokenRegistration,
  PresencePushRegistrationError,
  PresencePushNotificationEvent,
  PresencePendingProofWakeSignal,
} from "./pushNotifications";

// ─── Types ────────────────────────────────────────────────────────────────────
export type {
  PresenceAttestation,
  PresenceSignal,
  PresenceState,
  PresenceBindingSync,
  PendingProofRequest,
  PresenceTransportPayload,
  PresenceMobileErrorCode,
  BiometricWindow,
  PassResult,
  Result,
  PendingProofRequestStatus,
} from "./types/index";
export { PresenceMobileError, ok, err } from "./types/index";
