import { createServer } from "http";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  PresenceClient,
  FileSystemLinkageStore,
  fileLinkageStorePath,
  createCompletionSessionResponse,
  createCompletionSuccessResponse,
  createRecoveryResponse,
  createLinkedNonceResponse,
  createLinkedAccountReadinessResponse,
  createAuditEventsResponse,
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

function rewritePresenceQrUrl(rawUrl, baseUrl, serviceDomain) {
  if (!rawUrl) return rawUrl;
  const [root, query = ""] = rawUrl.split("?");
  if (!query) return rawUrl;

  const params = new URLSearchParams(query);
  for (const key of ["nonce_url", "verify_url", "status_url"]) {
    const value = params.get(key);
    if (value?.startsWith("/")) {
      params.set(key, absolutize(baseUrl, value));
    }
  }
  if (serviceDomain && !params.get("service_domain")) {
    params.set("service_domain", serviceDomain);
  }
  return `${root}?${params.toString()}`;
}

function rewriteSessionForPublicBase(session, baseUrl, serviceDomain) {
  if (!session?.completion) return session;
  return {
    ...session,
    completion: {
      ...session.completion,
      qrUrl: rewritePresenceQrUrl(session.completion.qrUrl, baseUrl, serviceDomain),
      deeplinkUrl: rewritePresenceQrUrl(session.completion.deeplinkUrl, baseUrl, serviceDomain),
      sessionStatusUrl: absolutize(baseUrl, session.completion.sessionStatusUrl),
      completionApiUrl: absolutize(baseUrl, session.completion.completionApiUrl),
      linkedNonceApiUrl: absolutize(baseUrl, session.completion.linkedNonceApiUrl),
      verifyLinkedAccountApiUrl: absolutize(baseUrl, session.completion.verifyLinkedAccountApiUrl),
    },
  };
}

async function main() {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || "127.0.0.1";
  const serviceId = process.env.PRESENCE_SERVICE_ID || "demo-service";
  const publicBaseUrl = (process.env.PUBLIC_BASE_URL || `http://${host}:${port}`).replace(/\/$/, "");
  const serviceDomain = process.env.PRESENCE_SERVICE_DOMAIN || "";
  const root = mkdtempSync(join(tmpdir(), "presence-local-reference-server-"));
  const storePath = fileLinkageStorePath(root);

  const presence = new PresenceClient({
    silent: true,
    serviceId,
    linkageStore: new FileSystemLinkageStore(storePath),
    bindingPolicy: { allowReplacementOnMismatch: true },
  });

  const endpointContract = {
    createSessionPath: "/presence/link-sessions",
    completeSessionPath: "/presence/link-sessions/:sessionId/complete",
    sessionStatusPath: "/presence/link-sessions/:sessionId",
    linkedNoncePath: "/presence/linked-accounts/:accountId/nonce",
    verifyLinkedAccountPath: "/presence/linked-accounts/:accountId/verify",
    linkedStatusPath: "/presence/linked-accounts/:accountId/status",
    unlinkAccountPath: "/presence/linked-accounts/:accountId/unlink",
    revokeDevicePath: "/presence/devices/:deviceIss/revoke",
    auditEventsPath: "/presence/audit-events",
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
        send(200, { ok: true, serviceId, serviceDomain: serviceDomain || undefined, storePath });
        return;
      }

      if (method === "GET" && url.pathname === "/.well-known/presence.json") {
        if (!serviceDomain) {
          send(404, { ok: false, code: "ERR_SERVICE_DOMAIN_NOT_CONFIGURED" });
          return;
        }
        send(200, {
          version: "1",
          service_id: serviceId,
          allowed_url_prefixes: [`${publicBaseUrl}/presence/`],
        });
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
        const publicSession = rewriteSessionForPublicBase(session, publicBaseUrl, serviceDomain);
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
        send(200, { ok: true, session: rewriteSessionForPublicBase(session, publicBaseUrl, serviceDomain) });
        return;
      }

      const linkedNonceMatch = url.pathname.match(/^\/presence\/linked-accounts\/([^/]+)\/nonce$/);
      if (method === "POST" && linkedNonceMatch) {
        const nonce = presence.generateNonce();
        send(200, createLinkedNonceResponse(nonce));
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

      const auditMatch = url.pathname === "/presence/audit-events";
      if (method === "GET" && auditMatch) {
        const accountId = url.searchParams.get("accountId") || undefined;
        const events = await presence.listAuditEvents({ serviceId, accountId });
        send(200, createAuditEventsResponse(events));
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

  server.listen(port, host, () => {
    console.log(JSON.stringify({
      ok: true,
      host,
      port,
      serviceId,
      serviceDomain: serviceDomain || undefined,
      storePath,
      endpoints: {
        health: `${publicBaseUrl}/health`,
        wellKnown: serviceDomain ? `${publicBaseUrl}/.well-known/presence.json` : undefined,
        createSession: `${publicBaseUrl}/presence/link-sessions`,
        publicBaseUrl,
      },
    }, null, 2));
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
