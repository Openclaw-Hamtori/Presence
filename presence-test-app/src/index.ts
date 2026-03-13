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

// ─── Core service ─────────────────────────────────────────────────────────────
export { measure, prove, proveMeasured } from "./service";
export type { MeasureOptions, MeasureResult, ProveOptions, ProveResult } from "./service";

// ─── State ────────────────────────────────────────────────────────────────────
export {
  loadPresenceState,
  savePresenceState,
  clearPresenceState,
  computeStateStatus,
  isStateUsable,
  shouldRenew,
  formatTimeRemaining,
  secondsUntilNextMeasurement,
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
export { PresenceStatusCard } from "./ui/components/PresenceStatusCard";
export { isQrScannerSupported, scanQrCode } from "./qrScanner";
export { syncLinkedBindings, flushQueuedLinkedBindingSyncs } from "./sync/linkedBindings";
export { hasPendingLinkedBindingSyncJobs, clearLinkedBindingSyncQueue } from "./sync/queue";
export type { LinkedBindingSyncError, LinkedBindingSyncResult } from "./sync/linkedBindings";
export type { LinkedBindingSyncJob, LinkedBindingSyncJobKind } from "./sync/queue";

// ─── Types ────────────────────────────────────────────────────────────────────
export type {
  PresenceAttestation,
  PresenceSignal,
  PresenceState,
  PresenceStateStatus,
  PresenceBindingSync,
  PresenceTransportPayload,
  PresenceMobileErrorCode,
  BiometricWindow,
  PassResult,
  Result,
} from "./types/index";
export { PresenceMobileError, ok, err } from "./types/index";
