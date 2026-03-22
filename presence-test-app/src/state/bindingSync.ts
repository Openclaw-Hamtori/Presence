import type { PresenceBindingSync } from "../types/index";

function normalizeOptionalSyncValue(value?: string): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeBindingSyncMetadata(
  sync: PresenceBindingSync | undefined | null
): PresenceBindingSync | undefined {
  if (!sync) return undefined;

  const normalized: PresenceBindingSync = {};
  const serviceDomain = normalizeOptionalSyncValue(sync.serviceDomain);
  const nonceUrl = normalizeOptionalSyncValue(sync.nonceUrl);
  const verifyUrl = normalizeOptionalSyncValue(sync.verifyUrl);
  const statusUrl = normalizeOptionalSyncValue(sync.statusUrl);
  const pendingRequestsUrl = normalizeOptionalSyncValue(sync.pendingRequestsUrl);

  if (serviceDomain) normalized.serviceDomain = serviceDomain;
  if (nonceUrl) normalized.nonceUrl = nonceUrl;
  if (verifyUrl) normalized.verifyUrl = verifyUrl;
  if (statusUrl) normalized.statusUrl = statusUrl;
  if (pendingRequestsUrl) normalized.pendingRequestsUrl = pendingRequestsUrl;

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function hasRequiredBindingSyncMetadata(
  sync: PresenceBindingSync | undefined | null
): boolean {
  const normalized = normalizeBindingSyncMetadata(sync);
  return !!normalized?.nonceUrl && !!normalized?.verifyUrl;
}

export function mergeBindingSyncMetadata(
  existingSync: PresenceBindingSync | undefined,
  incomingSync: PresenceBindingSync | undefined
): PresenceBindingSync | undefined {
  const normalizedExisting = normalizeBindingSyncMetadata(existingSync);
  const normalizedIncoming = normalizeBindingSyncMetadata(incomingSync);

  if (!normalizedExisting) return normalizedIncoming;
  if (!normalizedIncoming) return normalizedExisting;
  return {
    ...normalizedExisting,
    ...normalizedIncoming,
  };
}
