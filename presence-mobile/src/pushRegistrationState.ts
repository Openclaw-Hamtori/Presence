import type {
  PresencePushAuthorizationStatus,
  PresencePushTokenRegistration,
} from "./pushNotifications";

const STORAGE_KEY = "@presence:push-setup:v1";

type AsyncStorageLike = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
};

export interface StoredPushTokenRegistration extends PresencePushTokenRegistration {
  receivedAt: number;
}

export interface DevicePushSetupState {
  deviceIss: string;
  confirmedRegistrationSignature?: string;
  lastUploadAttemptedAt?: number;
  lastUploadConfirmedAt?: number;
  lastUploadError?: string;
}

export interface PresencePushSetupState {
  authorizationStatus?: PresencePushAuthorizationStatus;
  latestToken?: StoredPushTokenRegistration;
  devices: DevicePushSetupState[];
}

export function createEmptyPushSetupState(): PresencePushSetupState {
  return {
    devices: [],
  };
}

export async function loadPushSetupState(): Promise<PresencePushSetupState> {
  try {
    const storage = await getAsyncStorage();
    const raw = await storage.getItem(STORAGE_KEY);
    if (!raw) {
      return createEmptyPushSetupState();
    }
    return normalizePushSetupState(JSON.parse(raw));
  } catch {
    return createEmptyPushSetupState();
  }
}

export async function savePushSetupState(state: PresencePushSetupState): Promise<void> {
  const storage = await getAsyncStorage();
  await storage.setItem(STORAGE_KEY, JSON.stringify(normalizePushSetupState(state)));
}

export function notePushAuthorizationStatus(
  state: PresencePushSetupState,
  status: PresencePushAuthorizationStatus
): PresencePushSetupState {
  return {
    ...normalizePushSetupState(state),
    authorizationStatus: normalizeAuthorizationStatus(status),
  };
}

export function notePushTokenReceived(
  state: PresencePushSetupState,
  registration: PresencePushTokenRegistration,
  params: { receivedAt?: number } = {}
): PresencePushSetupState {
  const token = normalizeRegistration(registration);
  if (!token) {
    return normalizePushSetupState(state);
  }

  return {
    ...normalizePushSetupState(state),
    latestToken: {
      ...token,
      receivedAt: params.receivedAt ?? Math.floor(Date.now() / 1000),
    },
  };
}

export function notePushUploadAttempt(
  state: PresencePushSetupState,
  params: {
    deviceIss: string;
    registration: PresencePushTokenRegistration;
    attemptedAt?: number;
    error?: string;
  }
): PresencePushSetupState {
  const deviceIss = normalizeString(params.deviceIss);
  const registration = normalizeRegistration(params.registration);
  if (!deviceIss || !registration) {
    return normalizePushSetupState(state);
  }

  const nextState = normalizePushSetupState(state);
  const device = getOrCreateDeviceState(nextState, deviceIss);
  const signature = pushRegistrationSignature({
    deviceIss,
    registration,
  });

  device.lastUploadAttemptedAt = params.attemptedAt ?? Math.floor(Date.now() / 1000);
  if (device.confirmedRegistrationSignature !== signature) {
    device.lastUploadConfirmedAt = undefined;
  }
  device.lastUploadError = normalizeString(params.error) ?? undefined;
  return nextState;
}

export function notePushUploadConfirmed(
  state: PresencePushSetupState,
  params: {
    deviceIss: string;
    registration: PresencePushTokenRegistration;
    confirmedAt?: number;
  }
): PresencePushSetupState {
  const deviceIss = normalizeString(params.deviceIss);
  const registration = normalizeRegistration(params.registration);
  if (!deviceIss || !registration) {
    return normalizePushSetupState(state);
  }

  const nextState = normalizePushSetupState(state);
  const device = getOrCreateDeviceState(nextState, deviceIss);
  const confirmedAt = params.confirmedAt ?? Math.floor(Date.now() / 1000);

  device.confirmedRegistrationSignature = pushRegistrationSignature({
    deviceIss,
    registration,
  });
  device.lastUploadAttemptedAt = confirmedAt;
  device.lastUploadConfirmedAt = confirmedAt;
  device.lastUploadError = undefined;
  return nextState;
}

export function isPushUploadConfirmed(
  state: PresencePushSetupState,
  params: {
    deviceIss: string;
    registration: PresencePushTokenRegistration;
  }
): boolean {
  const deviceIss = normalizeString(params.deviceIss);
  const registration = normalizeRegistration(params.registration);
  if (!deviceIss || !registration) {
    return false;
  }

  const signature = pushRegistrationSignature({
    deviceIss,
    registration,
  });
  const device = findDeviceState(normalizePushSetupState(state), deviceIss);
  return device?.confirmedRegistrationSignature === signature;
}

export function getLatestPushToken(
  state: PresencePushSetupState
): PresencePushTokenRegistration | null {
  const token = normalizePushSetupState(state).latestToken;
  if (!token) {
    return null;
  }

  return {
    token: token.token,
    platform: "ios_apns",
    environment: token.environment,
    bundleId: token.bundleId,
  };
}

export function pushRegistrationSignature(params: {
  deviceIss: string;
  registration: Pick<PresencePushTokenRegistration, "token" | "environment" | "bundleId">;
}): string {
  return [
    normalizeString(params.deviceIss) ?? "-",
    normalizeToken(params.registration.token) ?? "-",
    params.registration.environment === "production" ? "production" : "development",
    normalizeString(params.registration.bundleId) ?? "-",
  ].join(":");
}

function normalizePushSetupState(value: unknown): PresencePushSetupState {
  const record = asRecord(value);
  const rawDevices = record?.devices;
  const deviceRecords = Array.isArray(rawDevices) ? rawDevices : [];
  const latestToken = normalizeStoredToken(record?.latestToken);
  const devices = deviceRecords
    .map((item) => normalizeDeviceState(item))
    .filter((item): item is DevicePushSetupState => !!item);

  return {
    authorizationStatus: normalizeAuthorizationStatus(record?.authorizationStatus),
    latestToken,
    devices: dedupeDevices(devices),
  };
}

function normalizeStoredToken(value: unknown): StoredPushTokenRegistration | undefined {
  const record = asRecord(value);
  const registration = normalizeRegistration(record);
  if (!registration) {
    return undefined;
  }

  return {
    ...registration,
    receivedAt: readNumber(record?.receivedAt) ?? Math.floor(Date.now() / 1000),
  };
}

function normalizeDeviceState(value: unknown): DevicePushSetupState | null {
  const record = asRecord(value);
  const deviceIss = normalizeString(record?.deviceIss);
  if (!deviceIss) {
    return null;
  }

  return {
    deviceIss,
    confirmedRegistrationSignature: normalizeString(record?.confirmedRegistrationSignature) ?? undefined,
    lastUploadAttemptedAt: readNumber(record?.lastUploadAttemptedAt) ?? undefined,
    lastUploadConfirmedAt: readNumber(record?.lastUploadConfirmedAt) ?? undefined,
    lastUploadError: normalizeString(record?.lastUploadError) ?? undefined,
  };
}

function normalizeRegistration(value: unknown): PresencePushTokenRegistration | null {
  const record = asRecord(value);
  const token = normalizeToken(record?.token);
  if (!token) {
    return null;
  }

  return {
    token,
    platform: "ios_apns",
    environment: record?.environment === "production" ? "production" : "development",
    bundleId: normalizeString(record?.bundleId) ?? undefined,
  };
}

function normalizeAuthorizationStatus(value: unknown): PresencePushAuthorizationStatus | undefined {
  switch (value) {
    case "not_determined":
    case "denied":
    case "authorized":
    case "provisional":
    case "ephemeral":
    case "unsupported":
      return value;
    default:
      return undefined;
  }
}

function findDeviceState(
  state: PresencePushSetupState,
  deviceIss: string
): DevicePushSetupState | undefined {
  return state.devices.find((item) => item.deviceIss === deviceIss);
}

function getOrCreateDeviceState(
  state: PresencePushSetupState,
  deviceIss: string
): DevicePushSetupState {
  const existing = findDeviceState(state, deviceIss);
  if (existing) {
    return existing;
  }

  const created: DevicePushSetupState = { deviceIss };
  state.devices = [...state.devices, created];
  return created;
}

function dedupeDevices(devices: DevicePushSetupState[]): DevicePushSetupState[] {
  const byDevice = new Map<string, DevicePushSetupState>();
  for (const device of devices) {
    byDevice.set(device.deviceIss, device);
  }
  return [...byDevice.values()].sort((a, b) => a.deviceIss.localeCompare(b.deviceIss));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeToken(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/[^0-9a-f]/gi, "").toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function getAsyncStorage(): Promise<AsyncStorageLike> {
  const module = require("@react-native-async-storage/async-storage");
  return (module.default ?? module) as AsyncStorageLike;
}
