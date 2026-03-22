type ReactNativeBridge = {
  NativeModules?: Record<string, unknown>;
  NativeEventEmitter?: new (nativeModule?: unknown) => {
    addListener: (eventName: string, listener: (payload: unknown) => void) => {
      remove: () => void;
    };
  };
  Platform?: {
    OS?: string;
  };
};

type NativePushNotificationsModule = {
  getAuthorizationStatus?: () => Promise<PresencePushAuthorizationStatus>;
  registerForPushNotifications?: (
    prompt: boolean
  ) => Promise<PresencePushRegistrationRequestResult>;
  consumeInitialNotificationResponse?: () => Promise<unknown>;
};

const EVENT_TOKEN_REGISTERED = "PresencePushTokenRegistered";
const EVENT_REGISTRATION_FAILED = "PresencePushRegistrationFailed";
const EVENT_NOTIFICATION_RECEIVED = "PresencePushNotificationReceived";
const EVENT_NOTIFICATION_RESPONSE = "PresencePushNotificationResponse";

export type PresencePushAuthorizationStatus =
  | "not_determined"
  | "denied"
  | "authorized"
  | "provisional"
  | "ephemeral"
  | "unsupported";

export interface PresencePushRegistrationRequestResult {
  status: PresencePushAuthorizationStatus;
  registrationRequested: boolean;
}

export interface PresencePushTokenRegistration {
  token: string;
  platform: "ios_apns";
  environment: "development" | "production";
  bundleId?: string;
}

export interface PresencePushRegistrationError {
  message: string;
}

export interface PresencePushNotificationEvent {
  payload: Record<string, unknown>;
  source: string;
}

export interface PresencePendingProofWakeSignal {
  version: "1";
  kind: "pending_proof_request.available";
  signalId?: string;
  serviceId: string;
  accountId?: string;
  bindingId: string;
  deviceIss?: string;
  requestId: string;
  requestedAt?: number;
  expiresAt?: number;
}

export function isPushNotificationsSupported(): boolean {
  return !!getNativePushNotificationsModule();
}

export async function getPushAuthorizationStatus(): Promise<PresencePushAuthorizationStatus> {
  const nativeModule = getNativePushNotificationsModule();
  if (!nativeModule?.getAuthorizationStatus) {
    return "unsupported";
  }
  return nativeModule.getAuthorizationStatus();
}

export async function ensurePushNotificationsRegistered(
  params: { prompt?: boolean } = {}
): Promise<PresencePushRegistrationRequestResult> {
  const nativeModule = getNativePushNotificationsModule();
  if (!nativeModule?.registerForPushNotifications) {
    return {
      status: "unsupported",
      registrationRequested: false,
    };
  }
  return nativeModule.registerForPushNotifications(params.prompt ?? true);
}

export async function consumeInitialPushNotificationResponse(): Promise<PresencePushNotificationEvent | null> {
  const nativeModule = getNativePushNotificationsModule();
  if (!nativeModule?.consumeInitialNotificationResponse) {
    return null;
  }
  const payload = await nativeModule.consumeInitialNotificationResponse();
  return normalizeNotificationEvent(payload, "initial_notification_response");
}

export function addPushNotificationListener(handlers: {
  onTokenRegistered?: (registration: PresencePushTokenRegistration) => void;
  onRegistrationError?: (error: PresencePushRegistrationError) => void;
  onNotificationReceived?: (event: PresencePushNotificationEvent) => void;
  onNotificationResponse?: (event: PresencePushNotificationEvent) => void;
}): () => void {
  const bridge = getReactNativeBridge();
  const nativeModule = getNativePushNotificationsModule();
  if (!bridge?.NativeEventEmitter || !nativeModule) {
    return () => undefined;
  }

  const emitter = new bridge.NativeEventEmitter(nativeModule);
  const subscriptions = [
    emitter.addListener(EVENT_TOKEN_REGISTERED, (payload: unknown) => {
      const registration = normalizePushTokenRegistration(payload);
      if (registration) {
        handlers.onTokenRegistered?.(registration);
      }
    }),
    emitter.addListener(EVENT_REGISTRATION_FAILED, (payload: unknown) => {
      const error = normalizePushRegistrationError(payload);
      if (error) {
        handlers.onRegistrationError?.(error);
      }
    }),
    emitter.addListener(EVENT_NOTIFICATION_RECEIVED, (payload: unknown) => {
      const event = normalizeNotificationEvent(payload, "notification_received");
      if (event) {
        handlers.onNotificationReceived?.(event);
      }
    }),
    emitter.addListener(EVENT_NOTIFICATION_RESPONSE, (payload: unknown) => {
      const event = normalizeNotificationEvent(payload, "notification_response");
      if (event) {
        handlers.onNotificationResponse?.(event);
      }
    }),
  ];

  return () => {
    for (const subscription of subscriptions) {
      subscription.remove();
    }
  };
}

export function extractPendingProofWakeSignal(value: unknown): PresencePendingProofWakeSignal | null {
  const record = asRecord(value);
  const candidate = asRecord(record?.presence_signal) ?? record;
  if (!candidate) {
    return null;
  }

  const kind = readString(candidate.kind) ?? readString(candidate.presence_signal_kind);
  if (kind !== "pending_proof_request.available") {
    return null;
  }
  const version = readString(candidate.version);
  if (version && version !== "1") {
    return null;
  }

  const serviceId = readString(candidate.serviceId) ?? readString(candidate.service_id);
  const bindingId = readString(candidate.bindingId) ?? readString(candidate.binding_id);
  const requestId = readString(candidate.requestId) ?? readString(candidate.request_id);
  if (!serviceId || !bindingId || !requestId) {
    return null;
  }

  return {
    version: "1",
    kind: "pending_proof_request.available",
    signalId: readString(candidate.signalId) ?? readString(candidate.signal_id) ?? undefined,
    serviceId,
    accountId: readString(candidate.accountId) ?? readString(candidate.account_id) ?? undefined,
    bindingId,
    deviceIss: readString(candidate.deviceIss) ?? readString(candidate.device_iss) ?? undefined,
    requestId,
    requestedAt: readNumber(candidate.requestedAt) ?? readNumber(candidate.requested_at) ?? undefined,
    expiresAt: readNumber(candidate.expiresAt) ?? readNumber(candidate.expires_at) ?? undefined,
  };
}

function getReactNativeBridge(): ReactNativeBridge | null {
  try {
    return require("react-native") as ReactNativeBridge;
  } catch {
    return null;
  }
}

function getNativePushNotificationsModule(): NativePushNotificationsModule | null {
  const bridge = getReactNativeBridge();
  if (!bridge?.Platform?.OS || bridge.Platform.OS !== "ios") {
    return null;
  }
  return (bridge.NativeModules?.PresencePushNotifications ?? null) as NativePushNotificationsModule | null;
}

function normalizePushTokenRegistration(value: unknown): PresencePushTokenRegistration | null {
  const record = asRecord(value);
  const token = readString(record?.token);
  if (!token) {
    return null;
  }

  return {
    token,
    platform: "ios_apns",
    environment: readString(record?.environment) === "production" ? "production" : "development",
    bundleId: readString(record?.bundleId) ?? readString(record?.bundle_id) ?? undefined,
  };
}

function normalizePushRegistrationError(value: unknown): PresencePushRegistrationError | null {
  const record = asRecord(value);
  const message = readString(record?.message);
  return message ? { message } : null;
}

function normalizeNotificationEvent(
  value: unknown,
  fallbackSource: string
): PresencePushNotificationEvent | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const payload = asRecord(record.payload) ?? record;
  return {
    payload,
    source: readString(record.source) ?? fallbackSource,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
