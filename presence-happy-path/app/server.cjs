"use strict";

const { createServer } = require("http");
const { mkdirSync } = require("fs");
const { join } = require("path");
const { resolvePresenceServerConfig } = require("./presence-config.cjs");

function loadPresenceSdk() {
  try {
    return require("presence-sdk");
  } catch (error) {
    if (error && error.code !== "MODULE_NOT_FOUND") {
      throw error;
    }
    return require("../../presence-sdk/dist/index.js");
  }
}

const {
  PresenceClient,
  FileSystemLinkageStore,
  fileLinkageStorePath,
  createCompletionSessionResponse,
  createCompletionSuccessResponse,
  createRecoveryResponse,
  createLinkedProofRequestResponse,
  createPendingProofRequestResponse,
  createPendingProofRequestListResponse,
  createLinkedAccountReadinessResponse,
  createAuditEventsResponse,
  rewriteLinkSessionForPublicBase,
} = loadPresenceSdk();

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function absolutize(baseUrl, value) {
  if (!value) return value;
  if (/^https?:\/\//.test(value)) return value;
  if (!value.startsWith("/")) return value;
  return `${baseUrl}${value}`;
}

function resolvePendingProofSignalTransport() {
  const transportMode = (process.env.PRESENCE_PUSH_TRANSPORT || "").trim().toLowerCase();
  if (transportMode !== "log") {
    return undefined;
  }

  return {
    async deliver({ signal, targets }) {
      const deliveredAt = Math.floor(Date.now() / 1000);
      console.log(
        `[presence-happy-path] pending-proof signal request=${signal.requestId} service=${signal.serviceId} targets=${targets.length}`
      );
      console.log(
        `[presence-happy-path] pending-proof signal payload=${JSON.stringify({ presence_signal: signal })}`
      );
      return {
        provider: "log",
        deliveredAt,
        providerMessageId: `log:${signal.signalId}`,
        targetCount: targets.length,
      };
    },
  };
}

async function main() {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || "127.0.0.1";
  const { iosAppId, iosAppIdSource } = resolvePresenceServerConfig(process.env);
  const serviceId = process.env.PRESENCE_SERVICE_ID || "demo-service";
  const publicBaseUrl = (process.env.PUBLIC_BASE_URL || `http://${host}:${port}`).replace(/\/$/, "");
  const publicPresenceApiBaseUrl = `${publicBaseUrl}/presence`;
  const serviceDomain = process.env.PRESENCE_SERVICE_DOMAIN || "";
  const serviceDomainWellKnownUrl = serviceDomain ? `https://${serviceDomain}/.well-known/presence.json` : null;
  const storageRoot = process.env.PRESENCE_STORAGE_ROOT || join(process.cwd(), "var", "presence");
  mkdirSync(storageRoot, { recursive: true });
  const storePath = fileLinkageStorePath(storageRoot);

  const presence = new PresenceClient({
    silent: true,
    serviceId,
    linkageStore: new FileSystemLinkageStore(storePath),
    iosAppId,
    bindingPolicy: { allowReplacementOnMismatch: true },
    pendingProofSignalTransport: resolvePendingProofSignalTransport(),
  });

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
  };

  const server = createServer(async (req, res) => {
    const send = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload, null, 2));
    };

    try {
      const url = new URL(req.url || "/", `http://${host}:${port}`);
      const method = req.method || "GET";

      if (method === "GET" && url.pathname === "/health") {
        send(200, {
          ok: true,
          serviceId,
          serviceDomain: serviceDomain || undefined,
          storePath,
          iosAppIdSource,
        });
        return;
      }

      if (method === "GET" && url.pathname === "/.well-known/presence.json") {
        if (!serviceDomain) {
          send(404, { ok: false, code: "ERR_SERVICE_DOMAIN_NOT_CONFIGURED" });
          return;
        }
        res.writeHead(200, {
          "content-type": "application/json",
          "Cache-Control": "no-store, no-cache, max-age=0",
          Pragma: "no-cache",
        });
        res.end(JSON.stringify({
          version: "1",
          service_id: serviceId,
          allowed_url_prefixes: [publicPresenceApiBaseUrl],
        }, null, 2));
        return;
      }

      if (method === "POST" && url.pathname === "/presence/link-sessions") {
        const body = await readJson(req);
        const { session } = await presence.createLinkSession({
          serviceId,
          accountId: body.accountId,
          metadata: body.metadata || { source: "presence-happy-path" },
          relinkOfBindingId: body.relinkOfBindingId,
        });
        const publicSession = rewriteLinkSessionForPublicBase(session, {
          publicBaseUrl,
          serviceDomain,
        });
        const response = createCompletionSessionResponse({ session: publicSession, contract: endpointContract });
        if (response.completion && response.completion.endpoints.complete.path) {
          response.completion.endpoints.complete.path = absolutize(publicBaseUrl, response.completion.endpoints.complete.path);
        }
        if (response.completion && response.completion.endpoints.status && response.completion.endpoints.status.path) {
          response.completion.endpoints.status.path = absolutize(publicBaseUrl, response.completion.endpoints.status.path);
        }
        send(200, response);
        return;
      }

      const completeMatch = url.pathname.match(/^\/presence\/link-sessions\/([^/]+)\/complete$/);
      if (method === "POST" && completeMatch) {
        const body = await readJson(req);
        const result = await presence.completeLinkSession({
          sessionId: decodeURIComponent(completeMatch[1]),
          body,
        });

        if (!result.verification.verified || !result.binding || !result.device) {
          send(400, {
            ok: false,
            code: result.verification.verified ? "ERR_INVALID_FORMAT" : result.verification.error,
            message: result.verification.verified ? "missing linkage records" : result.verification.detail,
            session: result.session,
          });
          return;
        }

        send(200, createCompletionSuccessResponse({
          session: result.session,
          binding: result.binding,
          device: result.device,
        }));
        return;
      }

      const sessionMatch = url.pathname.match(/^\/presence\/link-sessions\/([^/]+)$/);
      if (method === "GET" && sessionMatch) {
        const session = await presence.linkageStore.getLinkSession(decodeURIComponent(sessionMatch[1]));
        if (!session) {
          send(404, { ok: false, code: "ERR_SESSION_NOT_FOUND" });
          return;
        }
        send(200, {
          ok: true,
          session: rewriteLinkSessionForPublicBase(session, {
            publicBaseUrl,
            serviceDomain,
          }),
        });
        return;
      }

      const linkedNonceMatch = url.pathname.match(/^\/presence\/linked-accounts\/([^/]+)\/nonce$/);
      if (method === "POST" && linkedNonceMatch) {
        const request = await presence.createLinkedProofRequest({
          accountId: decodeURIComponent(linkedNonceMatch[1]),
        });

        if (request.ok) {
          const response = createLinkedProofRequestResponse({
            binding: request.binding,
            nonce: request.nonce,
            contract: endpointContract,
          });
          response.proofRequest.endpoints.verify.path = absolutize(publicBaseUrl, response.proofRequest.endpoints.verify.path);
          if (response.proofRequest.endpoints.status && response.proofRequest.endpoints.status.path) {
            response.proofRequest.endpoints.status.path = absolutize(publicBaseUrl, response.proofRequest.endpoints.status.path);
          }
          if (response.proofRequest.endpoints.unlink && response.proofRequest.endpoints.unlink.path) {
            response.proofRequest.endpoints.unlink.path = absolutize(publicBaseUrl, response.proofRequest.endpoints.unlink.path);
          }
          send(200, response);
          return;
        }

        switch (request.state) {
          case "missing_binding":
            send(404, {
              ok: false,
              code: "ERR_BINDING_NOT_FOUND",
              message: request.reason,
              state: request.state,
            });
            return;
          case "unlinked":
          case "revoked":
          case "recovery_pending":
          default:
            send(409, {
              ok: false,
              code: "ERR_LINKED_PROOF_UNAVAILABLE",
              message: request.reason,
              state: request.state,
              bindingId: request.binding ? request.binding.bindingId : undefined,
            });
            return;
        }
      }

      const pendingMatch = url.pathname.match(/^\/presence\/linked-accounts\/([^/]+)\/pending-proof-requests$/);
      if (pendingMatch && method === "POST") {
        const request = await presence.createPendingProofRequest({
          accountId: decodeURIComponent(pendingMatch[1]),
        });

        if (!request.ok) {
          switch (request.state) {
            case "missing_binding":
              send(404, {
                ok: false,
                code: "ERR_BINDING_NOT_FOUND",
                message: request.reason,
                state: request.state,
              });
              return;
            default:
              send(409, {
                ok: false,
                code: "ERR_LINKED_PROOF_UNAVAILABLE",
                message: request.reason,
                state: request.state,
                bindingId: request.binding ? request.binding.bindingId : undefined,
              });
              return;
          }
        }

        const response = createPendingProofRequestResponse({
          request: request.request,
          contract: endpointContract,
        });
        response.proofRequest.endpoints.respond.path = absolutize(publicBaseUrl, response.proofRequest.endpoints.respond.path);
        if (response.proofRequest.endpoints.status && response.proofRequest.endpoints.status.path) {
          response.proofRequest.endpoints.status.path = absolutize(publicBaseUrl, response.proofRequest.endpoints.status.path);
        }
        if (response.proofRequest.endpoints.unlink && response.proofRequest.endpoints.unlink.path) {
          response.proofRequest.endpoints.unlink.path = absolutize(publicBaseUrl, response.proofRequest.endpoints.unlink.path);
        }
        send(200, response);
        return;
      }

      if (pendingMatch && method === "GET") {
        const requests = await presence.listPendingProofRequests({
          accountId: decodeURIComponent(pendingMatch[1]),
        });
        const response = createPendingProofRequestListResponse({
          requests,
          contract: endpointContract,
        });
        for (const proofRequest of response.proofRequests) {
          proofRequest.endpoints.respond.path = absolutize(publicBaseUrl, proofRequest.endpoints.respond.path);
          if (proofRequest.endpoints.status && proofRequest.endpoints.status.path) {
            proofRequest.endpoints.status.path = absolutize(publicBaseUrl, proofRequest.endpoints.status.path);
          }
          if (proofRequest.endpoints.unlink && proofRequest.endpoints.unlink.path) {
            proofRequest.endpoints.unlink.path = absolutize(publicBaseUrl, proofRequest.endpoints.unlink.path);
          }
        }
        send(200, response);
        return;
      }

      const pendingRequestMatch = url.pathname.match(/^\/presence\/pending-proof-requests\/([^/]+)$/);
      if (pendingRequestMatch && method === "GET") {
        const request = await presence.getPendingProofRequest({
          requestId: decodeURIComponent(pendingRequestMatch[1]),
        });
        if (!request) {
          send(404, { ok: false, code: "ERR_PENDING_PROOF_REQUEST_NOT_FOUND" });
          return;
        }
        const response = createPendingProofRequestResponse({
          request,
          contract: endpointContract,
        });
        response.proofRequest.endpoints.respond.path = absolutize(publicBaseUrl, response.proofRequest.endpoints.respond.path);
        if (response.proofRequest.endpoints.status && response.proofRequest.endpoints.status.path) {
          response.proofRequest.endpoints.status.path = absolutize(publicBaseUrl, response.proofRequest.endpoints.status.path);
        }
        if (response.proofRequest.endpoints.unlink && response.proofRequest.endpoints.unlink.path) {
          response.proofRequest.endpoints.unlink.path = absolutize(publicBaseUrl, response.proofRequest.endpoints.unlink.path);
        }
        send(200, response);
        return;
      }

      const respondPendingMatch = url.pathname.match(/^\/presence\/pending-proof-requests\/([^/]+)\/respond$/);
      if (respondPendingMatch && method === "POST") {
        const body = await readJson(req);
        const result = await presence.respondToPendingProofRequest({
          requestId: decodeURIComponent(respondPendingMatch[1]),
          body,
        });

        if (result.verified) {
          send(200, {
            ok: true,
            state: "linked",
            binding: result.binding,
            snapshot: result.snapshot,
            request: result.request,
          });
          return;
        }

        if (result.error === "ERR_BINDING_RECOVERY_REQUIRED") {
          send(409, createRecoveryResponse(result));
          return;
        }

        send(400, {
          ok: false,
          code: result.error,
          message: result.detail,
          request: result.request,
        });
        return;
      }

      const verifyMatch = url.pathname.match(/^\/presence\/linked-accounts\/([^/]+)\/verify$/);
      if (method === "POST" && verifyMatch) {
        const body = await readJson(req);
        const nonceHeader = req.headers["x-presence-nonce"];
        const nonce = Array.isArray(nonceHeader) ? nonceHeader[0] : nonceHeader;
        const result = await presence.verifyLinkedAccount(body, {
          accountId: decodeURIComponent(verifyMatch[1]),
          nonce: String(nonce || ""),
        });

        if (result.verified) {
          send(200, {
            ok: true,
            state: "linked",
            binding: result.binding,
            snapshot: result.snapshot,
          });
          return;
        }

        if (result.error === "ERR_BINDING_RECOVERY_REQUIRED") {
          send(409, createRecoveryResponse(result));
          return;
        }

        send(400, {
          ok: false,
          code: result.error,
          message: result.detail,
        });
        return;
      }

      const statusMatch = url.pathname.match(/^\/presence\/linked-accounts\/([^/]+)\/status$/);
      if (method === "GET" && statusMatch) {
        const readiness = await presence.getLinkedAccountReadiness({
          accountId: decodeURIComponent(statusMatch[1]),
        });
        send(200, createLinkedAccountReadinessResponse(readiness));
        return;
      }

      const unlinkMatch = url.pathname.match(/^\/presence\/linked-accounts\/([^/]+)\/unlink$/);
      if (method === "POST" && unlinkMatch) {
        const body = await readJson(req);
        const result = await presence.unlinkAccount({
          accountId: decodeURIComponent(unlinkMatch[1]),
          reason: body.reason || "user_requested",
        });
        if (!result) {
          send(404, {
            ok: false,
            code: "ERR_BINDING_NOT_FOUND",
            message: "linked account not found",
          });
          return;
        }
        send(200, {
          ok: true,
          binding: result.binding,
          auditEvent: result.auditEvent,
        });
        return;
      }

      const revokeMatch = url.pathname.match(/^\/presence\/devices\/([^/]+)\/revoke$/);
      if (method === "POST" && revokeMatch) {
        const body = await readJson(req);
        const events = await presence.revokeDevice({
          deviceIss: decodeURIComponent(revokeMatch[1]),
          reason: body.reason || "manual_revoke",
        });
        send(200, { ok: true, events });
        return;
      }

      if (method === "GET" && url.pathname === "/presence/audit-events") {
        const accountId = url.searchParams.get("accountId") || undefined;
        const events = await presence.listAuditEvents({ serviceId, accountId });
        send(200, createAuditEventsResponse(events));
        return;
      }

      const deviceBindingsMatch = url.pathname.match(/^\/presence\/devices\/([^/]+)\/bindings$/);
      if (method === "GET" && deviceBindingsMatch) {
        const deviceIss = decodeURIComponent(deviceBindingsMatch[1]);
        const [device, bindings] = await Promise.all([
          presence.linkageStore.getLinkedDevice(deviceIss),
          presence.linkageStore.listBindingsForDevice(deviceIss),
        ]);
        send(200, {
          ok: true,
          device,
          bindings: bindings
            .filter((binding) => binding.serviceId === serviceId)
            .sort((a, b) => (b.lastVerifiedAt || b.lastLinkedAt || 0) - (a.lastVerifiedAt || a.lastLinkedAt || 0)),
        });
        return;
      }

      const devicePushTokensMatch = url.pathname.match(/^\/presence\/devices\/([^/]+)\/push-tokens$/);
      if (method === "POST" && devicePushTokensMatch) {
        const deviceIss = decodeURIComponent(devicePushTokensMatch[1]);
        const body = await readJson(req);

        try {
          const registration = await presence.registerDevicePushToken({
            deviceIss,
            token: String(body.token || ""),
            platform: "ios_apns",
            environment: body.environment === "production" ? "production" : "development",
            bundleId: body.bundleId ? String(body.bundleId) : undefined,
          });
          send(200, {
            ok: true,
            device: registration.device,
            pushToken: registration.pushToken,
            replacedTokens: registration.replacedTokens,
          });
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const notFound = message.startsWith("linked device not found:");
          send(notFound ? 404 : 400, {
            ok: false,
            code: notFound ? "ERR_DEVICE_NOT_FOUND" : "ERR_PUSH_TOKEN_INVALID",
            message,
          });
          return;
        }
      }

      send(404, { ok: false, code: "ERR_NOT_FOUND" });
    } catch (error) {
      send(500, {
        ok: false,
        code: "ERR_INTERNAL",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  console.log(`[presence-happy-path] listening on ${publicBaseUrl}`);
  console.log(`[presence-happy-path] public Presence API base: ${publicPresenceApiBaseUrl}`);
  console.log(`[presence-happy-path] linkage store: ${storePath}`);
  if (serviceDomainWellKnownUrl) {
    console.log(
      `[presence-happy-path] service-domain trust metadata: ${serviceDomainWellKnownUrl} -> allowed_url_prefixes includes ${publicPresenceApiBaseUrl}`
    );
  }
}

main().catch((error) => {
  console.error("[presence-happy-path] failed to start", error);
  process.exitCode = 1;
});
