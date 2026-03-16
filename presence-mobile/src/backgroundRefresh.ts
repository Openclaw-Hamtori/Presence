import { NativeEventEmitter, NativeModules, Platform } from "react-native";

const EVENT_NAME = "PresenceBackgroundRefreshTriggered";

interface PresenceBackgroundRefreshNative {
  isSupported(): Promise<boolean>;
  scheduleRefresh(earliestEpochSeconds: number): Promise<boolean>;
  finish(success: boolean): Promise<boolean>;
  consumePendingTrigger(): Promise<boolean>;
  getDiagnostics(): Promise<BackgroundRefreshDiagnostics>;
}

export interface BackgroundRefreshDiagnostics {
  supported: boolean;
  pendingTrigger: boolean;
  scheduledEarliestEpochSeconds?: number;
  lastTriggeredAt?: number;
  lastFinishedAt?: number;
  lastFinishedSuccess?: boolean;
}

const nativeModule = Platform.OS === "ios"
  ? ((NativeModules.PresenceBackgroundRefresh as PresenceBackgroundRefreshNative | undefined) ?? null)
  : null;

const eventEmitter = nativeModule ? new NativeEventEmitter(NativeModules.PresenceBackgroundRefresh) : null;

export async function isBackgroundRefreshSupported(): Promise<boolean> {
  if (!nativeModule) return false;
  try {
    return await nativeModule.isSupported();
  } catch {
    return false;
  }
}

export async function scheduleBackgroundRefresh(earliestEpochSeconds: number): Promise<boolean> {
  if (!nativeModule) return false;
  try {
    return await nativeModule.scheduleRefresh(earliestEpochSeconds);
  } catch {
    return false;
  }
}

export async function finishBackgroundRefresh(success: boolean): Promise<void> {
  if (!nativeModule) return;
  try {
    await nativeModule.finish(success);
  } catch {
    // best-effort
  }
}

export async function consumePendingBackgroundRefresh(): Promise<boolean> {
  if (!nativeModule) return false;
  try {
    return await nativeModule.consumePendingTrigger();
  } catch {
    return false;
  }
}

export async function getBackgroundRefreshDiagnostics(): Promise<BackgroundRefreshDiagnostics> {
  if (!nativeModule) {
    return {
      supported: false,
      pendingTrigger: false,
    };
  }
  try {
    return await nativeModule.getDiagnostics();
  } catch {
    return {
      supported: false,
      pendingTrigger: false,
    };
  }
}

export function addBackgroundRefreshListener(listener: () => void): () => void {
  if (!eventEmitter) return () => undefined;
  const subscription = eventEmitter.addListener(EVENT_NAME, listener);
  return () => subscription.remove();
}
