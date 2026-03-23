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

function normalizeRouteBasePath(value) {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  return `/${trimmed.replace(/^\/+/, "").replace(/\/+$/, "")}`;
}

function stripRouteBase(pathname, basePath) {
  if (!basePath || !pathname.startsWith(basePath)) {
    return pathname;
  }

  if (pathname === basePath) {
    return "/";
  }

  const prefix = `${basePath}/`;
  if (pathname.startsWith(prefix)) {
    return pathname.slice(basePath.length);
  }

  return pathname;
}

function normalizePushToken(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  if (normalized.length < 64 || normalized.length % 2 === 1) {
    return null;
  }

  return normalized;
}

function getServiceApiKey() {
  return process.env.PRESENCE_SERVICE_API_KEY || process.env.PRESENCE_API_KEY || "";
}

function extractServiceApiKey(req) {
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (typeof authHeader === "string") {
    const trimmed = authHeader.trim();
    if (trimmed.toLowerCase().startsWith("bearer ")) {
      return trimmed.slice(7).trim();
    }
    return trimmed;
  }

  const apiKeyHeader = req.headers["x-presence-service-api-key"] || req.headers["x-presence-api-key"];
  if (Array.isArray(apiKeyHeader)) {
    return apiKeyHeader[0] || "";
  }
  if (typeof apiKeyHeader === "string") {
    return apiKeyHeader.trim();
  }

  return "";
}

function isProtectedServiceRoute(method, pathname) {
  if (!pathname.startsWith("/presence/") && pathname !== "/presence") {
    return false;
  }

  // Callback endpoints are intentionally public for end-user app traffic.
  if (method === "POST" && /^\/presence\/link-sessions\/[^/]+\/complete$/.test(pathname)) {
    return false;
  }
  if (method === "POST" && /^\/presence\/linked-accounts\/[^/]+\/verify$/.test(pathname)) {
    return false;
  }
  if (method === "POST" && /^\/presence\/pending-proof-requests\/[^/]+\/respond$/.test(pathname)) {
    return false;
  }

  return true;
}

function isAuthorizedServiceRequest(req, pathname) {
  const serviceApiKey = getServiceApiKey();
  if (!serviceApiKey) {
    return true;
  }

  const method = (req.method || "").toUpperCase();
  if (!isProtectedServiceRoute(method, pathname)) {
    return true;
  }

  const provided = extractServiceApiKey(req);
  return Boolean(provided) && provided === serviceApiKey;
}

function resolvePendingProofSignalTransport({ iosAppId }) {
  const transportMode = (process.env.PRESENCE_PUSH_TRANSPORT || "").trim().toLowerCase();

  if (transportMode === "log") {
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

  if (transportMode === "apns") {
    try {
      const { createApnsPendingProofSignalTransport } = require("./pending-proof-apns-transport.cjs");
      return createApnsPendingProofSignalTransport(process.env, {
        defaultTopic: iosAppId,
        logger: {
          warn: (message) => console.warn(`[presence-happy-path] ${message}`),
          error: (message) => console.error(`[presence-happy-path] ${message}`),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[presence-happy-path] APNs transport disabled: ${message}`);
      return {
        async deliver() {
          throw new Error(message);
        },
      };
    }
  }

  return undefined;
}

async function main() {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || "127.0.0.1";
  const { iosAppId, iosAppIdSource } = resolvePresenceServerConfig(process.env);
  const serviceId = process.env.PRESENCE_SERVICE_ID || "demo-service";
  const serviceAuthEnabled = Boolean(getServiceApiKey());
  const routeBasePath = normalizeRouteBasePath(process.env.ROUTE_BASE_PATH || "");
  const publicBaseUrl = (process.env.PUBLIC_BASE_URL || `http://${host}:${port}`).replace(/\/$/, "");
  const publicPresenceApiBaseUrl = `${publicBaseUrl}/presence`;
  const serviceDomain = process.env.PRESENCE_SERVICE_DOMAIN || "";
  const serviceDomainWellKnownUrl = serviceDomain ? `https://${serviceDomain}/.well-known/presence.json` : null;
  const storageRoot = process.env.PRESENCE_STORAGE_ROOT || join(process.cwd(), "var", "presence");
  mkdirSync(storageRoot, { recursive: true });
  const storePath = fileLinkageStorePath(storageRoot);
  // Keep mismatch replacement enabled by default for the happy-path demo/server:
  // it keeps recovery recoverable via relink flow without changing server runtime.
  // Set PRESENCE_ALLOW_REPLACEMENT_ON_MISMATCH=false for stricter behavior.
  const allowReplacementOnMismatch =
    (process.env.PRESENCE_ALLOW_REPLACEMENT_ON_MISMATCH ?? "true") !== "false";

  const presence = new PresenceClient({
    silent: true,
    serviceId,
    linkageStore: new FileSystemLinkageStore(storePath),
    iosAppId,
    bindingPolicy: { allowReplacementOnMismatch },
    pendingProofSignalTransport: resolvePendingProofSignalTransport({ iosAppId }),
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
      const requestPath = stripRouteBase(url.pathname, routeBasePath);

      if (!isAuthorizedServiceRequest(req, requestPath)) {
        send(401, { ok: false, code: "ERR_AUTH_REQUIRED", message: "invalid or missing service API key" });
        return;
      }

      if (method === "GET" && requestPath === "/health") {
        send(200, {
          ok: true,
          serviceId,
          serviceDomain: serviceDomain || undefined,
          storePath,
          iosAppIdSource,
        });
        return;
      }

      if (method === "GET" && requestPath === "/.well-known/presence.json") {
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

      if (method === "POST" && requestPath === "/presence/link-sessions") {
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

      const completeMatch = requestPath.match(/^\/presence\/link-sessions\/([^/]+)\/complete$/);
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

      const sessionMatch = requestPath.match(/^\/presence\/link-sessions\/([^/]+)$/);
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

      const linkedNonceMatch = requestPath.match(/^\/presence\/linked-accounts\/([^/]+)\/nonce$/);
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

      const pendingMatch = requestPath.match(/^\/presence\/linked-accounts\/([^/]+)\/pending-proof-requests$/);
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

      const pendingRequestMatch = requestPath.match(/^\/presence\/pending-proof-requests\/([^/]+)$/);
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

      const respondPendingMatch = requestPath.match(/^\/presence\/pending-proof-requests\/([^/]+)\/respond$/);
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

      const verifyMatch = requestPath.match(/^\/presence\/linked-accounts\/([^/]+)\/verify$/);
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

      const statusMatch = requestPath.match(/^\/presence\/linked-accounts\/([^/]+)\/status$/);
      if (method === "GET" && statusMatch) {
        const readiness = await presence.getLinkedAccountReadiness({
          accountId: decodeURIComponent(statusMatch[1]),
        });
        send(200, createLinkedAccountReadinessResponse(readiness));
        return;
      }

      const unlinkMatch = requestPath.match(/^\/presence\/linked-accounts\/([^/]+)\/unlink$/);
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

      const revokeMatch = requestPath.match(/^\/presence\/devices\/([^/]+)\/revoke$/);
      if (method === "POST" && revokeMatch) {
        const body = await readJson(req);
        const events = await presence.revokeDevice({
          deviceIss: decodeURIComponent(revokeMatch[1]),
          reason: body.reason || "manual_revoke",
        });
        send(200, { ok: true, events });
        return;
      }

      if (method === "GET" && requestPath === "/presence/audit-events") {
        const accountId = url.searchParams.get("accountId") || undefined;
        const events = await presence.listAuditEvents({ serviceId, accountId });
        send(200, createAuditEventsResponse(events));
        return;
      }

      const deviceBindingsMatch = requestPath.match(/^\/presence\/devices\/([^/]+)\/bindings$/);
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

      const devicePushTokensMatch = requestPath.match(/^\/presence\/devices\/([^/]+)\/push-tokens$/);
      if (method === "POST" && devicePushTokensMatch) {
        const deviceIss = decodeURIComponent(devicePushTokensMatch[1]);
        const body = await readJson(req);
        const environment = body.environment === "production" ? "production" : "development";
        const normalizedToken = normalizePushToken(body?.token);

        if (!normalizedToken) {
          send(400, {
            ok: false,
            code: "ERR_PUSH_TOKEN_INVALID",
            message: "Invalid APNs token format",
          });
          return;
        }

        try {
          const registration = await presence.registerDevicePushToken({
            deviceIss,
            token: normalizedToken,
            platform: "ios_apns",
            environment,
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
  if (serviceAuthEnabled) {
    console.log(`[presence-happy-path] service API auth: enabled via PRESENCE_SERVICE_API_KEY`);
  }
  console.log(`[presence-happy-path] service API auth header: x-presence-service-api-key or Authorization: Bearer <key>`);
  console.log(
    `[presence-happy-path] optional pending-proof push transport (best-effort wake): ${
      process.env.PRESENCE_PUSH_TRANSPORT || "off"
    }`
  );
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
