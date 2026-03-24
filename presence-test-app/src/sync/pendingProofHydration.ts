import { mergeBindingSyncMetadata } from "../state/bindingSync.ts";
import type { PendingProofRequest, ServiceBinding } from "../types/index.ts";

const ACTIVE_BINDING_STATUSES: Set<ServiceBinding["status"]> = new Set([
  "linked",
  "recovery_pending",
  "reauth_required",
]);

function isActiveBinding(binding: ServiceBinding): boolean {
  return ACTIVE_BINDING_STATUSES.has(binding.status);
}

function normalizePresenceApiBaseUrl(value: string): string {
  return value.replace(/\/$/, "");
}

function buildCanonicalBindingSync(params: {
  accountId?: string;
  apiBaseUrl: string;
}): ServiceBinding["sync"] | undefined {
  if (!params.accountId) {
    return undefined;
  }

  const apiBaseUrl = normalizePresenceApiBaseUrl(params.apiBaseUrl);
  const encodedAccountId = encodeURIComponent(params.accountId);
  const serviceDomain = apiBaseUrl.replace(/^https?:\/\//, "").split("/")[0];

  return {
    serviceDomain,
    nonceUrl: `${apiBaseUrl}/linked-accounts/${encodedAccountId}/nonce`,
    verifyUrl: `${apiBaseUrl}/linked-accounts/${encodedAccountId}/verify`,
    statusUrl: `${apiBaseUrl}/linked-accounts/${encodedAccountId}/status`,
    pendingRequestsUrl: `${apiBaseUrl}/linked-accounts/${encodedAccountId}/pending-proof-requests`,
  };
}

export function hydrateBindingWithCanonicalSync(
  binding: ServiceBinding,
  apiBaseUrl: string
): ServiceBinding {
  const canonicalSync = buildCanonicalBindingSync({
    accountId: binding.accountId,
    apiBaseUrl,
  });

  return canonicalSync
    ? {
        ...binding,
        sync: mergeBindingSyncMetadata(canonicalSync, binding.sync),
      }
    : binding;
}

export function selectPendingProofRequestsForBindings(params: {
  requests: PendingProofRequest[];
  bindings: ServiceBinding[];
  deviceIss?: string | null;
  statuses?: PendingProofRequest["status"][];
}): PendingProofRequest[] {
  const allowedStatuses = params.statuses ? new Set(params.statuses) : null;
  const actionableBindingIds = new Set(
    params.bindings
      .filter((binding) => isActiveBinding(binding) && (!params.deviceIss || binding.linkedDeviceIss === params.deviceIss))
      .map((binding) => binding.bindingId)
  );

  return [...params.requests]
    .filter((request) => actionableBindingIds.has(request.bindingId))
    .filter((request) => !params.deviceIss || !request.deviceIss || request.deviceIss === params.deviceIss)
    .filter((request) => !allowedStatuses || allowedStatuses.has(request.status))
    .sort((a, b) => b.requestedAt - a.requestedAt);
}
