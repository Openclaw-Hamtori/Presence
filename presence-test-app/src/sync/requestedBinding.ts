import type { LinkCompletionEnvelope } from "../deeplink";
import type { ProveOptions } from "../service";
import { mergeBindingSyncMetadata, normalizeBindingSyncMetadata } from "../state/bindingSync.ts";
import type { ServiceBinding } from "../types/index";

interface LinkSessionHydrationState {
  ok: true;
  value: LinkCompletionEnvelope;
}

interface LinkSessionHydrationFailure {
  ok: false;
  code: string;
  message: string;
}

interface LinkSessionFromServer {
  id: string;
  serviceId: string;
  accountId?: string;
  issuedNonce: string;
  requestedAt?: number;
  expiresAt?: number;
  status?: string;
  relinkOfBindingId?: string;
  recoveryReason?: string;
  completion?: {
    method?: string;
    fallbackCode?: string;
    sessionStatusUrl?: string;
    completionApiUrl?: string;
    linkedNonceApiUrl?: string;
    verifyLinkedAccountApiUrl?: string;
    pendingProofRequestsApiUrl?: string;
  };
}

export type LinkSessionHydrationResult = LinkSessionHydrationState | LinkSessionHydrationFailure;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function inferServiceDomain(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.hostname;
  } catch {
    return undefined;
  }
}

export function hydrateLinkCompletionEnvelopeFromSession(
  session: LinkSessionFromServer,
  existing?: LinkCompletionEnvelope | null,
  now: number = nowSeconds()
): LinkSessionHydrationResult {
  const effectiveSessionId = session.id ?? existing?.sessionId;
  if (!effectiveSessionId) {
    return {
      ok: false,
      code: "ERR_LINK_SESSION_MISSING_ID",
      message: "Session payload was missing a session id."
    };
  }

  if (!session.issuedNonce) {
    return {
      ok: false,
      code: "ERR_LINK_SESSION_MISSING_NONCE",
      message: "This Presence link was already stripped of session credentials and cannot be completed safely."
    };
  }

  if (typeof session.expiresAt === "number" && now >= session.expiresAt) {
    return {
      ok: false,
      code: "ERR_LINK_SESSION_EXPIRED",
      message: "This Presence link has expired."
    };
  }

  if (session.status && session.status !== "pending") {
    return {
      ok: false,
      code: `ERR_LINK_SESSION_${String(session.status).toUpperCase()}`,
      message: session.status === "consumed"
        ? "This Presence link was already used. Ask for a new link from the service."
        : `This Presence link is no longer usable (status=${session.status}). Ask for a new link from the service.`,
    };
  }

  const completion = session.completion || {};
  const serviceDomain = existing?.serviceDomain
    ?? inferServiceDomain(completion.sessionStatusUrl)
    ?? inferServiceDomain(completion.linkedNonceApiUrl)
    ?? inferServiceDomain(completion.verifyLinkedAccountApiUrl)
    ?? inferServiceDomain(completion.pendingProofRequestsApiUrl);

  return {
    ok: true,
    value: {
      sessionId: effectiveSessionId,
      serviceId: session.serviceId || existing?.serviceId,
      serviceDomain,
      accountId: session.accountId,
      bindingId: session.relinkOfBindingId,
      flow: session.recoveryReason ? "recovery" : session.relinkOfBindingId ? "relink" : undefined,
      method: existing?.method ?? "deeplink",
      nonce: session.issuedNonce,
      code: completion.fallbackCode || existing?.code,
      statusUrl: completion.sessionStatusUrl || existing?.statusUrl,
      nonceUrl: completion.linkedNonceApiUrl || existing?.nonceUrl,
      verifyUrl: completion.verifyLinkedAccountApiUrl || existing?.verifyUrl,
      pendingRequestsUrl: completion.pendingProofRequestsApiUrl || existing?.pendingRequestsUrl,
      returnUrl: existing?.returnUrl,
    },
  };
}



function isKnownFlow(flow: string | undefined): LinkCompletionEnvelope["flow"] | "invalid" | undefined {
  if (flow === undefined) {
    return undefined;
  }

  const normalizedFlow = flow.trim().toLowerCase();

  if (!normalizedFlow) {
    return "invalid";
  }

  switch (normalizedFlow) {
    case "initial_link":
    case "reauth":
    case "relink":
    case "recovery":
      return normalizedFlow as LinkCompletionEnvelope["flow"];
    default:
      return "invalid";
  }
}

/**
 * Infer effective flow for request binding resolution.
 *
 * Explicit flow is authoritative; missing/blank flow follows legacy behavior.
 */
export function inferEnvelopeFlow(envelope: LinkCompletionEnvelope): NonNullable<LinkCompletionEnvelope["flow"]> | "initial_link" {
  const explicit = isKnownFlow(envelope.flow);
  if (envelope.flow !== undefined && explicit !== undefined && explicit !== "invalid") {
    return explicit;
  }
  return envelope.bindingId ? "reauth" : "initial_link";
}

function isLinkedBinding(binding: ServiceBinding): boolean {
  return binding.status === "linked";
}

export function hasExplicitNonReauthFlow(envelope: LinkCompletionEnvelope): boolean {
  if (envelope.flow === undefined) {
    return false;
  }

  const normalizedFlow = isKnownFlow(envelope.flow);
  return normalizedFlow !== "reauth";
}

export function syncFromEnvelope(
  envelope: LinkCompletionEnvelope | null
): ServiceBinding["sync"] | undefined {
  if (!envelope) return undefined;
  return normalizeBindingSyncMetadata({
    serviceDomain: envelope.serviceDomain,
    nonceUrl: envelope.nonceUrl,
    verifyUrl: envelope.verifyUrl,
    statusUrl: envelope.statusUrl,
    pendingRequestsUrl: envelope.pendingRequestsUrl,
  });
}

function isMatchingDeviceBinding(
  binding: ServiceBinding,
  currentDeviceIss?: string | null
): boolean {
  if (!currentDeviceIss) {
    return true;
  }
  return binding.linkedDeviceIss === currentDeviceIss;
}

export function resolveRequestedLinkedBinding(
  envelope: LinkCompletionEnvelope | null,
  bindings: ServiceBinding[],
  currentDeviceIss?: string | null
): ServiceBinding | null {
  if (!envelope) return null;

  // Explicit flow should be authoritative, so do not auto-resolve legacy
  // linked-account hints when the URL explicitly asks for a non-reauth flow.
  if (hasExplicitNonReauthFlow(envelope)) {
    return null;
  }

  const matchingBinding = envelope.bindingId
    ? bindings.find((binding) => (
      binding.bindingId === envelope.bindingId
      && isLinkedBinding(binding)
      && isMatchingDeviceBinding(binding, currentDeviceIss)
    ))
    : undefined;

  const resolvedBinding = matchingBinding
    || (!envelope.bindingId && envelope.serviceId && envelope.accountId
      ? bindings.find((binding) => (
        binding.serviceId === envelope.serviceId
        && binding.accountId === envelope.accountId
        && isLinkedBinding(binding)
        && isMatchingDeviceBinding(binding, currentDeviceIss)
      ))
      : undefined);

  if (!resolvedBinding) {
    return null;
  }

  return {
    ...resolvedBinding,
    sync: mergeBindingSyncMetadata(resolvedBinding.sync, syncFromEnvelope(envelope)),
  };
}

export function shouldUseLinkedVerifyRoute(args: {
  envelope: LinkCompletionEnvelope | null;
  openedRequestedBinding: ServiceBinding | null;
}): boolean {
  if (!args.envelope || !args.openedRequestedBinding) {
    return false;
  }

  return !hasExplicitNonReauthFlow(args.envelope);
}

export function buildProveOptionsFromEnvelope(envelope: LinkCompletionEnvelope): ProveOptions | null {
  if (!envelope.nonce) {
    return null;
  }

  const envelopeSync = syncFromEnvelope(envelope);
  const explicitFlow = isKnownFlow(envelope.flow);
  const hasExplicitFlow = envelope.flow !== undefined;
  const flow = hasExplicitFlow
    ? explicitFlow === "invalid" || explicitFlow === undefined
      ? "initial_link"
      : explicitFlow
    : (envelope.bindingId ? "reauth" : "initial_link");

  return {
    nonce: envelope.nonce,
    flow,
    linkSession: {
      id: envelope.sessionId,
      serviceId: envelope.serviceId ?? "presence-demo",
      accountId: envelope.accountId,
      recoveryCode: envelope.code,
      completion: {
        method: envelope.method ?? "deeplink",
        returnUrl: envelope.returnUrl,
        fallbackCode: envelope.code,
        sync: envelopeSync,
      },
    },
    ...(flow === "initial_link"
      ? {}
      : {
        bindingHint: envelope.bindingId
          ? {
            bindingId: envelope.bindingId,
            serviceId: envelope.serviceId ?? "presence-demo",
            accountId: envelope.accountId,
            sync: envelopeSync,
          }
          : undefined,
      }
    ),
  };
}
