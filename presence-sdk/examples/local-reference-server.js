import { createServer } from "http";
import { mkdirSync } from "fs";
import { timingSafeEqual } from "node:crypto";
import { join } from "path";
import {
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
} from "../dist/index.js";

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
function getServiceApiKey() {
  return process.env.PRESENCE_SERVICE_API_KEY || process.env.PRESENCE_API_KEY || "";
}

function getReferenceAuthMode() {
  const mode = String(process.env.PRESENCE_REFERENCE_AUTH_MODE || "demo").toLowerCase();

  if (mode === "strict") {
    return "strict";
  }

  if (mode === "demo") {
    return "demo";
  }

  return "demo";
}

function getCleanupIntervalSeconds() {
  const defaultInterval = 300;
  const maxInterval = 3_600;
  const value = process.env.PRESENCE_CLEANUP_INTERVAL_SECONDS;
  if (value === undefined || value === "") {
    return defaultInterval;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return defaultInterval;
  }
  return Math.min(maxInterval, parsed);
}

function parseCleanupIntervalConfig() {
  const intervalSeconds = getCleanupIntervalSeconds();
  return {
    intervalSeconds,
    enabled: intervalSeconds > 0,
    runAtStartup: true,
  };
}

async function runNonceCleanupOnce(presence) {
  const report = await presence.cleanupPersistedNonces();
  if (report.totalExpired > 0) {
    console.log(`[presence-sdk] cleanup sweep removed ${report.totalExpired} expired nonce artifacts`, JSON.stringify(report));
  }
}

function startCleanupScheduler(presence, { intervalSeconds }) {
  if (intervalSeconds <= 0) {
    return null;
  }

  const runSweep = () => {
    runNonceCleanupOnce(presence).catch((error) => {
      console.error("[presence-sdk] cleanup sweep failed", error instanceof Error ? error.message : String(error));
    });
  };

  runSweep();
  const intervalMs = intervalSeconds * 1000;
  const timer = setInterval(runSweep, intervalMs);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  return timer;
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
  if (!pathname.startsWith("/presence/")) {
    return false;
  }

  // Callback endpoints stay public for end-user app traffic.
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
  if (!provided) {
    return false;
  }

  const providedBytes = Buffer.from(provided, "utf8");
  const expectedBytes = Buffer.from(serviceApiKey, "utf8");
  if (providedBytes.length !== expectedBytes.length) {
    return false;
  }

  return timingSafeEqual(providedBytes, expectedBytes);
}


async function main() {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || "127.0.0.1";
  const serviceId = process.env.PRESENCE_SERVICE_ID || "demo-service";
  const publicBaseUrl = (process.env.PUBLIC_BASE_URL || `http://${host}:${port}`).replace(/\/$/, "");
  const serviceDomain = process.env.PRESENCE_SERVICE_DOMAIN || "";
  const referenceAuthMode = getReferenceAuthMode();
  const serviceApiKeyEnv = process.env.PRESENCE_SERVICE_API_KEY;
  const serviceAuthEnabled = Boolean(getServiceApiKey());
  if (!serviceAuthEnabled && referenceAuthMode === "strict") {
    console.error(
      "[presence-sdk] FAILED: PRESENCE_REFERENCE_AUTH_MODE=strict requires PRESENCE_SERVICE_API_KEY to be set."
    );
    console.error("[presence-sdk] Set a random shared secret and resend, or run with PRESENCE_REFERENCE_AUTH_MODE=demo for local/dev.");
    process.exit(1);
  }
  if (!serviceAuthEnabled) {
    console.warn(
      "[presence-sdk] Insecure-by-default reference mode active: service-to-service endpoints are currently unprotected (PRESENCE_REFERENCE_AUTH_MODE=demo)."
    );
    console.warn(
      "[presence-sdk] Set PRESENCE_SERVICE_API_KEY and PRESENCE_REFERENCE_AUTH_MODE=strict for a production-hardened service boundary."
    );
  }
  const storageRoot = process.env.PRESENCE_STORAGE_ROOT || join(process.cwd(), "var", "presence");
  mkdirSync(storageRoot, { recursive: true });
  const storePath = fileLinkageStorePath(storageRoot);
  const linkageStore = new FileSystemLinkageStore(storePath);
  const storeCapabilities = typeof linkageStore.getCapabilities === "function"
    ? linkageStore.getCapabilities()
    : null;
  const storeKind = storeCapabilities?.kind || "file";
  const storeSchema = {
    file: "presence-linkage-store-file-json-v1",
    sqlite: "presence-linkage-store-sqlite-v1",
    redis: "presence-linkage-store-redis-v1",
    in_memory: "presence-linkage-store-memory-v1",
    custom: "presence-linkage-store-custom-v1",
  }[storeKind] || "presence-linkage-store-unknown-v1";
  const storeSurface = storeKind === "file" ? "path" : "surface";

  const presence = new PresenceClient({
    silent: true,
    serviceId,
    linkageStore,
    bindingPolicy: { allowReplacementOnMismatch: true },
  });
  const cleanupConfig = parseCleanupIntervalConfig();
  const cleanupTimer = startCleanupScheduler(presence, cleanupConfig);

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

      if (!isAuthorizedServiceRequest(req, url.pathname)) {
        send(401, { ok: false, code: "ERR_AUTH_REQUIRED", message: "invalid or missing service API key" });
        return;
      }

      if (method === "GET" && url.pathname === "/health") {
        send(200, {
          ok: true,
          serviceId,
          serviceDomain: serviceDomain || undefined,
          storePath,
          store: {
            kind: storeKind,
            schema: storeSchema,
            path: storePath,
            surface: storeSurface,
            capabilities: storeCapabilities ?? undefined,
          },
          cleanup: {
            enabled: cleanupConfig.enabled,
            intervalSeconds: cleanupConfig.intervalSeconds,
            runAtStartup: cleanupConfig.runAtStartup,
          },
          security: {
            serviceAuthMode: referenceAuthMode,
            serviceApiKeyConfigured: serviceAuthEnabled,
            callbackEndpointsPublic: [
              "POST /presence/link-sessions/:sessionId/complete",
              "POST /presence/linked-accounts/:accountId/verify",
              "POST /presence/pending-proof-requests/:requestId/respond",
            ],
          },
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
          allowed_url_prefixes: [`${publicBaseUrl}/presence`],
        }, null, 2));
        return;
      }

      if (method === "POST" && url.pathname === "/presence/link-sessions") {
        const body = await readJson(req);
        const { session } = await presence.createLinkSession({
          serviceId,
          accountId: body.accountId,
          metadata: body.metadata || { source: "local-reference-server" },
          relinkOfBindingId: body.relinkOfBindingId,
        });
        const publicSession = rewriteLinkSessionForPublicBase(session, {
          publicBaseUrl,
          serviceDomain,
        });
        const response = createCompletionSessionResponse({ session: publicSession, contract: endpointContract });
        if (response.completion?.endpoints?.complete?.path) {
          response.completion.endpoints.complete.path = absolutize(publicBaseUrl, response.completion.endpoints.complete.path);
        }
        if (response.completion?.endpoints?.status?.path) {
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
          if (response.proofRequest.endpoints.status?.path) {
            response.proofRequest.endpoints.status.path = absolutize(publicBaseUrl, response.proofRequest.endpoints.status.path);
          }
          if (response.proofRequest.endpoints.unlink?.path) {
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
            send(409, {
              ok: false,
              code: "ERR_LINKED_PROOF_UNAVAILABLE",
              message: request.reason,
              state: request.state,
              bindingId: request.binding?.bindingId,
            });
            return;
          default:
            send(409, {
              ok: false,
              code: "ERR_LINKED_PROOF_UNAVAILABLE",
              message: request.reason,
              state: request.state,
              bindingId: request.binding?.bindingId,
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
                bindingId: request.binding?.bindingId,
              });
              return;
          }
        }

        const response = createPendingProofRequestResponse({
          request: request.request,
          contract: endpointContract,
        });
        response.proofRequest.endpoints.respond.path = absolutize(publicBaseUrl, response.proofRequest.endpoints.respond.path);
        if (response.proofRequest.endpoints.status?.path) {
          response.proofRequest.endpoints.status.path = absolutize(publicBaseUrl, response.proofRequest.endpoints.status.path);
        }
        if (response.proofRequest.endpoints.unlink?.path) {
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
          if (proofRequest.endpoints.status?.path) {
            proofRequest.endpoints.status.path = absolutize(publicBaseUrl, proofRequest.endpoints.status.path);
          }
          if (proofRequest.endpoints.unlink?.path) {
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
        if (response.proofRequest.endpoints.status?.path) {
          response.proofRequest.endpoints.status.path = absolutize(publicBaseUrl, response.proofRequest.endpoints.status.path);
        }
        if (response.proofRequest.endpoints.unlink?.path) {
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
  console.log(`[presence-sdk] local reference server listening on ${publicBaseUrl}`);
  console.log(`[presence-sdk] authoritative store: kind=${storeKind} schema=${storeSchema} surface=${storeSurface} path=${storePath}`);
  console.log(`[presence-sdk] linkage store: ${storePath}`);
  if (cleanupConfig.enabled) {
    console.log(`[presence-sdk] automatic nonce/request sweep: every ${cleanupConfig.intervalSeconds}s`);
  } else {
    console.log("[presence-sdk] automatic nonce/request sweep: disabled");
  }
  if (serviceAuthEnabled) {
    console.log(`[presence-sdk] service API auth: enabled via PRESENCE_SERVICE_API_KEY`);
  } else {
    console.log(`[presence-sdk] reference server auth posture: demo mode (service API auth disabled)`);
  }
  console.log(`[presence-sdk] service API auth header: x-presence-service-api-key or Authorization: Bearer <key>`);
  console.log(`[presence-sdk] reference auth mode env: PRESENCE_REFERENCE_AUTH_MODE=${referenceAuthMode}`);
  if (serviceDomain) {
    console.log(`[presence-sdk] trust metadata: ${publicBaseUrl}/.well-known/presence.json`);
  }

  const stopCleanupScheduler = () => {
    if (cleanupTimer) {
      clearInterval(cleanupTimer);
    }
  };
  process.on("SIGINT", stopCleanupScheduler);
  process.on("SIGTERM", stopCleanupScheduler);
}

main().catch((error) => {
  console.error("[presence-sdk] failed to start local reference server", error);
  process.exitCode = 1;
});
