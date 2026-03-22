/**
 * Canonical backend handler layout for:
 * link once -> stay linked -> request PASS when the service needs proof.
 */

import {
  PresenceClient,
  FileSystemLinkageStore,
  fileLinkageStorePath,
  createCompletionSessionResponse,
  createCompletionSuccessResponse,
  createRecoveryResponse,
  createAuditEventsResponse,
  createLinkedProofRequestResponse,
  createPendingProofRequestResponse,
  createPendingProofRequestListResponse,
  createLinkedAccountReadinessResponse,
  rewriteLinkSessionForPublicBase,
} from "../src/index.js";

const presence = new PresenceClient({
  serviceId: "discord-bot",
  linkageStore: new FileSystemLinkageStore(fileLinkageStorePath("./var/presence")),
});

const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? "https://presence.example.com";
const serviceDomain = process.env.PRESENCE_SERVICE_DOMAIN ?? "presence.example.com";

const endpointContract = {
  createSessionPath: "/presence/link-sessions",
  completeSessionPath: "/presence/link-sessions/:sessionId/complete",
  sessionStatusPath: "/presence/link-sessions/:sessionId",
  linkedNoncePath: "/presence/linked-accounts/:accountId/nonce",
  verifyLinkedAccountPath: "/presence/linked-accounts/:accountId/verify",
  linkedPendingProofRequestsPath: "/presence/linked-accounts/:accountId/pending-proof-requests",
  pendingProofRequestPath: "/presence/pending-proof-requests/:requestId",
  respondPendingProofRequestPath: "/presence/pending-proof-requests/:requestId/respond",
  linkedStatusPath: "/presence/linked-accounts/:accountId/status",
  unlinkAccountPath: "/presence/linked-accounts/:accountId/unlink",
  revokeDevicePath: "/presence/devices/:deviceIss/revoke",
  auditEventsPath: "/presence/audit-events",
  deviceBindingsPath: "/presence/devices/:deviceIss/bindings",
} as const;

export async function createLinkSessionHandler(req: { body: { accountId: string } }) {
  const { session } = await presence.createLinkSession({
    serviceId: "discord-bot",
    accountId: req.body.accountId,
  });

  return createCompletionSessionResponse({
    session: rewriteLinkSessionForPublicBase(session, {
      publicBaseUrl,
      serviceDomain,
    }),
    contract: endpointContract,
  });
}

export async function completeLinkSessionHandler(req: { params: { sessionId: string }; body: unknown }) {
  const result = await presence.completeLinkSession({
    sessionId: req.params.sessionId,
    body: req.body,
  });

  if (!result.verification.verified || !result.binding || !result.device) {
    return {
      ok: false,
      code: result.verification.verified ? "ERR_INVALID_FORMAT" : result.verification.error,
      message: result.verification.verified ? "missing linkage records" : result.verification.detail,
      session: result.session,
    };
  }

  return createCompletionSuccessResponse({
    session: result.session,
    binding: result.binding,
    device: result.device,
  });
}

export async function verifyLinkedAccountHandler(req: { params: { accountId: string }; body: unknown; nonce: string }) {
  const result = await presence.verifyLinkedAccount(req.body, {
    accountId: req.params.accountId,
    nonce: req.nonce,
  });

  if (result.verified) {
    return {
      ok: true,
      state: "linked",
      binding: result.binding,
      snapshot: result.snapshot,
    };
  }

  if (result.error === "ERR_BINDING_RECOVERY_REQUIRED") {
    return createRecoveryResponse(result);
  }

  return {
    ok: false,
    code: result.error,
    message: result.detail,
  };
}

export async function createLinkedProofRequestHandler(req: { params: { accountId: string } }) {
  const request = await presence.createLinkedProofRequest({
    accountId: req.params.accountId,
  });

  if (request.ok) {
    return createLinkedProofRequestResponse({
      binding: request.binding,
      nonce: request.nonce,
      contract: endpointContract,
    });
  }

  switch (request.state) {
    case "missing_binding":
      return {
        ok: false,
        code: "ERR_BINDING_NOT_FOUND",
        message: request.reason,
        state: request.state,
      };
    case "unlinked":
    case "revoked":
    case "recovery_pending":
      return {
        ok: false,
        code: "ERR_LINKED_PROOF_UNAVAILABLE",
        message: request.reason,
        state: request.state,
        bindingId: request.binding?.bindingId,
      };
    default:
      return {
        ok: false,
        code: "ERR_LINKED_PROOF_UNAVAILABLE",
        message: request.reason,
        state: request.state,
        bindingId: request.binding?.bindingId,
      };
  }
}

// Compatibility alias for older examples that still refer to the endpoint as "issue nonce".
export const issueLinkedNonceHandler = createLinkedProofRequestHandler;

export async function createPendingProofRequestHandler(req: { params: { accountId: string } }) {
  const request = await presence.createPendingProofRequest({
    accountId: req.params.accountId,
  });

  if (request.ok) {
    return createPendingProofRequestResponse({
      request: request.request,
      contract: endpointContract,
    });
  }

  switch (request.state) {
    case "missing_binding":
      return {
        ok: false,
        code: "ERR_BINDING_NOT_FOUND",
        message: request.reason,
        state: request.state,
      };
    default:
      return {
        ok: false,
        code: "ERR_LINKED_PROOF_UNAVAILABLE",
        message: request.reason,
        state: request.state,
        bindingId: request.binding?.bindingId,
      };
  }
}

export async function listPendingProofRequestsHandler(req: { params: { accountId: string } }) {
  const requests = await presence.listPendingProofRequests({
    accountId: req.params.accountId,
  });
  return createPendingProofRequestListResponse({
    requests,
    contract: endpointContract,
  });
}

export async function getPendingProofRequestHandler(req: { params: { requestId: string } }) {
  const request = await presence.getPendingProofRequest({
    requestId: req.params.requestId,
  });

  if (!request) {
    return {
      ok: false,
      code: "ERR_PENDING_PROOF_REQUEST_NOT_FOUND",
    };
  }

  return createPendingProofRequestResponse({
    request,
    contract: endpointContract,
  });
}

export async function respondToPendingProofRequestHandler(req: { params: { requestId: string }; body: unknown }) {
  const result = await presence.respondToPendingProofRequest({
    requestId: req.params.requestId,
    body: req.body,
  });

  if (result.verified) {
    return {
      ok: true,
      state: "linked",
      binding: result.binding,
      snapshot: result.snapshot,
      request: result.request,
    };
  }

  if (result.error === "ERR_BINDING_RECOVERY_REQUIRED") {
    return createRecoveryResponse(result);
  }

  return {
    ok: false,
    code: result.error,
    message: result.detail,
    request: result.request,
  };
}

export async function getLinkedAccountStatusHandler(req: { params: { accountId: string } }) {
  const readiness = await presence.getLinkedAccountReadiness({
    accountId: req.params.accountId,
  });
  return createLinkedAccountReadinessResponse(readiness);
}

export async function unlinkLinkedAccountHandler(req: { params: { accountId: string }; body?: { reason?: string } }) {
  const result = await presence.unlinkAccount({
    accountId: req.params.accountId,
    reason: req.body?.reason ?? "user_requested",
  });

  if (!result) {
    return {
      ok: false,
      code: "ERR_BINDING_NOT_FOUND",
      message: "linked account not found",
    };
  }

  return {
    ok: true,
    binding: result.binding,
    auditEvent: result.auditEvent,
  };
}

export async function requireReadyLinkedAccountHandler(req: { params: { accountId: string } }) {
  const readiness = await presence.getLinkedAccountReadiness({
    accountId: req.params.accountId,
  });

  if (!readiness.ready) {
    return {
      ok: false,
      code: "ERR_PRESENCE_NOT_READY",
      readiness,
    };
  }

  return {
    ok: true,
    readiness,
  };
}

export async function listAuditEventsHandler(req: { query: { accountId?: string } }) {
  const events = await presence.listAuditEvents({
    serviceId: "discord-bot",
    accountId: req.query.accountId,
  });
  return createAuditEventsResponse(events);
}

export async function listDeviceBindingsHandler(req: { params: { deviceIss: string } }) {
  const deviceIss = req.params.deviceIss;
  const [device, bindings] = await Promise.all([
    presence.linkageStore.getLinkedDevice(deviceIss),
    presence.linkageStore.listBindingsForDevice(deviceIss),
  ]);

  return {
    ok: true,
    device,
    bindings: bindings
      .filter((binding) => binding.serviceId === "discord-bot")
      .sort((a, b) => (b.lastVerifiedAt ?? b.lastLinkedAt ?? 0) - (a.lastVerifiedAt ?? a.lastLinkedAt ?? 0)),
  };
}
