import http from "node:http";
import {
  PresenceClient,
  SqliteLinkageStore,
  createCompletionSessionResponse,
  createPendingProofRequestListResponse,
  createPendingProofRequestResponse,
  createLinkedAccountReadinessResponse,
  rewriteLinkSessionForPublicBase,
} from "presence-sdk";

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`;
const SERVICE_DOMAIN = process.env.PRESENCE_SERVICE_DOMAIN ?? "localhost";

const presence = new PresenceClient({
  serviceId: "demo-service",
  linkageStore: new SqliteLinkageStore("./var/presence.sqlite"),
  iosAppId: process.env.PRESENCE_IOS_APP_ID ?? "TEAMID.com.example.presence",
  androidPackageName:
    process.env.PRESENCE_ANDROID_PACKAGE_NAME ?? "com.example.presence",
  bindingPolicy: {
    allowReplacementOnMismatch: true,
    allowRelinkAfterUnlink: true,
  },
  policy: {
    max_attestation_age: 600,
    max_state_age: 86400,
  },
});

const endpointContract = {
  createSessionPath: "/presence/link-sessions",
  completeSessionPath: "/presence/link-sessions/:sessionId/complete",
  sessionStatusPath: "/presence/link-sessions/:sessionId",
  linkedPendingProofRequestsPath: "/presence/linked-accounts/:accountId/pending-proof-requests",
  pendingProofRequestPath: "/presence/pending-proof-requests/:requestId",
  respondPendingProofRequestPath: "/presence/pending-proof-requests/:requestId/respond",
  linkedStatusPath: "/presence/linked-accounts/:accountId/status",
};

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function notFound(res) {
  json(res, 404, { ok: false, code: "ERR_NOT_FOUND" });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", PUBLIC_BASE_URL);
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "POST" && path === "/presence/link-sessions") {
      const body = await readJson(req);
      const { session } = await presence.createLinkSession({
        accountId: String(body.accountId ?? "acct_demo"),
      });

      return json(
        res,
        200,
        createCompletionSessionResponse({
          session: rewriteLinkSessionForPublicBase(session, {
            publicBaseUrl: PUBLIC_BASE_URL,
            serviceDomain: SERVICE_DOMAIN,
          }),
          contract: endpointContract,
        }),
      );
    }

    const completeMatch = path.match(/^\/presence\/link-sessions\/([^/]+)\/complete$/);
    if (method === "POST" && completeMatch) {
      const body = await readJson(req);
      const result = await presence.completeLinkSession({
        sessionId: decodeURIComponent(completeMatch[1]),
        body,
      });
      return json(res, result.verification.verified ? 200 : 400, result);
    }

    const createPendingMatch = path.match(/^\/presence\/linked-accounts\/([^/]+)\/pending-proof-requests$/);
    if (method === "POST" && createPendingMatch) {
      const accountId = decodeURIComponent(createPendingMatch[1]);
      const result = await presence.createPendingProofRequest({ accountId });
      if (!result.ok) {
        return json(res, 409, {
          ok: false,
          state: result.state,
          message: result.reason,
        });
      }
      return json(
        res,
        200,
        createPendingProofRequestResponse({
          request: result.request,
          contract: endpointContract,
        }),
      );
    }

    if (method === "GET" && createPendingMatch) {
      const accountId = decodeURIComponent(createPendingMatch[1]);
      const requests = await presence.listPendingProofRequests({ accountId });
      return json(
        res,
        200,
        createPendingProofRequestListResponse({
          requests,
          contract: endpointContract,
        }),
      );
    }

    const respondPendingMatch = path.match(/^\/presence\/pending-proof-requests\/([^/]+)\/respond$/);
    if (method === "POST" && respondPendingMatch) {
      const body = await readJson(req);
      const result = await presence.respondToPendingProofRequest({
        requestId: decodeURIComponent(respondPendingMatch[1]),
        body,
      });
      return json(res, result.verified ? 200 : 400, result);
    }

    const statusMatch = path.match(/^\/presence\/linked-accounts\/([^/]+)\/status$/);
    if (method === "GET" && statusMatch) {
      const accountId = decodeURIComponent(statusMatch[1]);
      const readiness = await presence.getLinkedAccountReadiness({ accountId });
      return json(res, 200, createLinkedAccountReadinessResponse(readiness));
    }

    return notFound(res);
  } catch (error) {
    return json(res, 500, {
      ok: false,
      code: "ERR_INTERNAL",
      message: error instanceof Error ? error.message : "unknown error",
    });
  }
});

server.listen(PORT, () => {
  console.log(`presence-sdk minimal server listening on ${PUBLIC_BASE_URL}`);
});
