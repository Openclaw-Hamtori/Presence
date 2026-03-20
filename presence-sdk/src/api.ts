import type {
  LinkCompletion,
  LinkSession,
  ServiceBinding,
  LinkedDevice,
  LinkageAuditEvent,
  LinkedVerificationRecovery,
  LinkedAccountReadiness,
} from "./types.js";

export type PresenceBackendFlow = "initial_link" | "reauth" | "relink" | "recovery";

export interface PresenceCompletionEndpointContract {
  createSessionPath: string;
  completeSessionPath: string;
  sessionStatusPath?: string;
  linkedNoncePath?: string;
  verifyLinkedAccountPath?: string;
  linkedStatusPath?: string;
  unlinkAccountPath?: string;
  revokeDevicePath?: string;
  auditEventsPath?: string;
  deviceBindingsPath?: string;
}

export interface CompletionEndpointDescriptor {
  method: "POST" | "GET";
  path: string;
}

export interface PresenceCompletionDescriptor {
  flow: PresenceBackendFlow;
  sessionId: string;
  serviceId: string;
  accountId: string;
  expiresAt: number;
  completion: LinkCompletion;
  endpoints: {
    complete: CompletionEndpointDescriptor;
    status?: CompletionEndpointDescriptor;
  };
}

export interface PresenceCompletionSessionResponse {
  ok: true;
  session: LinkSession;
  completion: PresenceCompletionDescriptor;
}

export interface PresenceRecoveryDescriptor {
  action: "reauth" | "relink" | "contact_support";
  reason: string;
  expectedDeviceIss: string;
  actualDeviceIss?: string;
  relinkSession?: PresenceCompletionDescriptor;
}

export interface PresenceRecoveryResponse {
  ok: false;
  code: "ERR_BINDING_RECOVERY_REQUIRED";
  message: string;
  binding: ServiceBinding;
  recovery: PresenceRecoveryDescriptor;
}

export interface PresenceCompletionSuccessResponse {
  ok: true;
  state: "linked";
  session: LinkSession;
  binding: ServiceBinding;
  device: LinkedDevice;
}

export interface PresenceAdminBindingSummary {
  binding: ServiceBinding;
  device?: LinkedDevice | null;
}

export interface PresenceAdminBindingsResponse {
  ok: true;
  bindings: PresenceAdminBindingSummary[];
}

export interface PresenceAuditEventsResponse {
  ok: true;
  events: LinkageAuditEvent[];
}

export interface PresenceLinkedNonceResponse {
  ok: true;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}

export interface PresenceLinkedAccountReadinessResponse {
  ok: true;
  readiness: LinkedAccountReadiness;
}


function completionEndpointPath(completion?: LinkCompletion, sessionId?: string): string | undefined {
  return completion?.completionApiUrl ?? (sessionId ? `/presence/link-sessions/${encodeURIComponent(sessionId)}/complete` : undefined);
}

function completionStatusEndpointPath(completion?: LinkCompletion, sessionId?: string): string | undefined {
  return completion?.sessionStatusUrl ?? (sessionId ? `/presence/link-sessions/${encodeURIComponent(sessionId)}` : undefined);
}

export function createCompletionDescriptor(params: {
  session: LinkSession;
  contract: PresenceCompletionEndpointContract;
}): PresenceCompletionDescriptor {
  const { session, contract } = params;
  const completion = session.completion ?? { method: "deeplink" };
  return {
    flow: session.relinkOfBindingId || session.recoveryReason ? "relink" : "initial_link",
    sessionId: session.id,
    serviceId: session.serviceId,
    accountId: session.accountId,
    expiresAt: session.expiresAt,
    completion,
    endpoints: {
      complete: { method: "POST", path: completionEndpointPath(session.completion, session.id) ?? contract.completeSessionPath },
      status: completionStatusEndpointPath(session.completion, session.id)
        ? { method: "GET", path: completionStatusEndpointPath(session.completion, session.id)! }
        : contract.sessionStatusPath
          ? { method: "GET", path: contract.sessionStatusPath }
          : undefined,
    },
  };
}

export function createCompletionSessionResponse(params: {
  session: LinkSession;
  contract: PresenceCompletionEndpointContract;
}): PresenceCompletionSessionResponse {
  return {
    ok: true,
    session: params.session,
    completion: createCompletionDescriptor(params),
  };
}

export function createRecoveryResponse(result: LinkedVerificationRecovery): PresenceRecoveryResponse {
  const relinkSession = result.recoverySession
    ? (() => {
        const completePath = completionEndpointPath(result.recoverySession?.completion, result.recoverySession.id)
          ?? `/presence/link-sessions/${encodeURIComponent(result.recoverySession.id)}/complete`;
        const statusPath = completionStatusEndpointPath(result.recoverySession?.completion, result.recoverySession.id);
        return {
          flow: (result.recoverySession.relinkOfBindingId || result.recoveryAction === "relink" ? "relink" : "recovery") as PresenceBackendFlow,
          sessionId: result.recoverySession.id,
          serviceId: result.recoverySession.serviceId,
          accountId: result.recoverySession.accountId,
          expiresAt: result.recoverySession.expiresAt,
          completion: result.recoverySession.completion ?? { method: "deeplink" },
          endpoints: {
            complete: { method: "POST" as const, path: completePath },
            status: statusPath ? { method: "GET" as const, path: statusPath } : undefined,
          },
        };
      })()
    : undefined;

  return {
    ok: false,
    code: "ERR_BINDING_RECOVERY_REQUIRED",
    message: result.detail,
    binding: result.binding,
    recovery: {
      action: result.recoveryAction,
      reason: result.binding.recoveryReason ?? "binding_recovery_required",
      expectedDeviceIss: result.expectedDeviceIss,
      actualDeviceIss: result.actualDeviceIss,
      relinkSession,
    },
  };
}

export function createCompletionSuccessResponse(params: {
  session: LinkSession;
  binding: ServiceBinding;
  device: LinkedDevice;
}): PresenceCompletionSuccessResponse {
  return {
    ok: true,
    state: "linked",
    session: params.session,
    binding: params.binding,
    device: params.device,
  };
}

export function createAuditEventsResponse(events: LinkageAuditEvent[]): PresenceAuditEventsResponse {
  return { ok: true, events };
}

export function createLinkedNonceResponse(params: {
  value: string;
  issuedAt: number;
  expiresAt: number;
}): PresenceLinkedNonceResponse {
  return {
    ok: true,
    nonce: params.value,
    issuedAt: params.issuedAt,
    expiresAt: params.expiresAt,
  };
}

export function createLinkedAccountReadinessResponse(
  readiness: LinkedAccountReadiness
): PresenceLinkedAccountReadinessResponse {
  return {
    ok: true,
    readiness,
  };
}
