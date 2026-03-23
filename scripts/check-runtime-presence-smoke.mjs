#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const BASE_WAIT_MS = 12_000;

function log(message) {
  console.log(`[runtime-smoke] ${message}`);
}

function fail(message, status = 1) {
  console.error(`[runtime-smoke] FAILED: ${message}`);
  process.exit(status);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function normalizeRouteBasePath(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  return `/${trimmed.replace(/^\/+/, "").replace(/\/+$/, "")}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    fail(`invalid JSON response from ${response.url}: ${text.slice(0, 120)}`);
  }
  return { response, payload };
}

async function startServer(config) {
  const tmpStorage = mkdtempSync(join(tmpdir(), "presence-runtime-smoke-"));
  const { port, host, routeBasePath, publicBaseUrl, serviceDomain } = config;

  const child = spawn(
    "node",
    ["presence-happy-path/app/server.cjs"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PORT: String(port),
        HOST: host,
        PRESENCE_STORAGE_ROOT: join(tmpStorage, "presence-storage"),
        ROUTE_BASE_PATH: routeBasePath,
        PUBLIC_BASE_URL: publicBaseUrl,
        PRESENCE_SERVICE_DOMAIN: serviceDomain,
        PRESENCE_CLEANUP_INTERVAL_SECONDS: "2",
      },
    }
  );

  const deadline = Date.now() + BASE_WAIT_MS;
  let startupError;

  child.stderr.on("data", (chunk) => {
    const message = String(chunk).trim();
    if (!message) return;
    console.error(`[presence-happy-path] ${message}`);
    if (message.includes("failed to start")) {
      startupError = message;
    }
  });

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${publicBaseUrl}${routeBasePath}/health`);
      if (res.ok) {
        const payload = await res.json();
        if (payload?.ok === true) {
          return { child, tmpStorage };
        }
      }
    } catch {
      // wait for server startup
    }

    if (startupError) {
      child.kill("SIGTERM");
      fail(`local server startup failed: ${startupError}`);
    }

    await sleep(250);
  }

  child.kill("SIGTERM");
  fail(`timed out waiting for local server startup (${BASE_WAIT_MS}ms)`);
}

async function stopServer(server) {
  if (!server) return;
  const { child, tmpStorage } = server;
  if (child && !child.killed) {
    child.kill("SIGTERM");
    await sleep(150);
  }
  if (tmpStorage) {
    rmSync(tmpStorage, { recursive: true, force: true });
  }
}

async function main() {
  const explicitUrl = process.env.PRESENCE_SMOKE_URL;
  const shouldRunLocal = process.env.PRESENCE_SMOKE_LOCAL === "1";

  if (!explicitUrl && !shouldRunLocal) {
    log("skipped. Set PRESENCE_SMOKE_URL or PRESENCE_SMOKE_LOCAL=1 to run this check.");
    return;
  }

  const routeBasePath = normalizeRouteBasePath(process.env.PRESENCE_SMOKE_ROUTE_BASE || "");
  const host = process.env.PRESENCE_SMOKE_HOST || "127.0.0.1";
  const port = Number(process.env.PRESENCE_SMOKE_PORT || "18920");
  const publicBaseUrl = process.env.PRESENCE_SMOKE_PUBLIC_BASE_URL || `http://${host}:${port}`;
  const serviceDomain = process.env.PRESENCE_SMOKE_SERVICE_DOMAIN || "presence.example";
  const shouldRunPendingProofProbe = process.env.PRESENCE_SMOKE_PENDING_PROOF_PROBE === "1";

  // NOTE: This probe only validates error-shape + contract reachability for pending-proof.
  // End-to-end success-path respond validation still requires a real linked account/request
  // captured from an actual device flow.

  const baseUrl = explicitUrl
    ? `${String(explicitUrl).replace(/\/$/, "")}`
    : String(publicBaseUrl).replace(/\/$/, "");

  let server = null;
  if (!explicitUrl) {
    server = await startServer({
      port,
      host,
      routeBasePath,
      publicBaseUrl: baseUrl,
      serviceDomain,
    });
  }

  const accountId = `smoke-${randomBytes(4).toString("hex")}`;

  try {
    log(`running runtime smoke against ${baseUrl}`);

    const health = await requestJson(baseUrl, `${routeBasePath}/health`);
    assert(health.response.status === 200, "health endpoint should return HTTP 200");
    assert(health.payload?.ok === true, "health response should include ok=true");
    assert(typeof health.payload?.serviceId === "string", "health response should include serviceId string");
    assert(typeof health.payload?.cleanup === "object", "health response should expose cleanup config");
    assert(typeof health.payload?.cleanup?.intervalSeconds === "number", "cleanup config should include intervalSeconds");
    assert(typeof health.payload?.cleanup?.enabled === "boolean", "cleanup config should include enabled");
    if (!explicitUrl) {
      assert(health.payload?.cleanup?.intervalSeconds === 2, "local runtime smoke should run cleanup every 2 seconds for verification");
    }

    const wellKnown = await requestJson(baseUrl, `${routeBasePath}/.well-known/presence.json`);
    assert(wellKnown.response.status === 200, "well-known endpoint should be reachable");
    assert(wellKnown.payload?.version === "1", "well-known response should expose version");
    const allowed = String(publicBaseUrl).replace(/\/$/, "");
    assert(
      Array.isArray(wellKnown.payload?.allowed_url_prefixes) &&
      wellKnown.payload.allowed_url_prefixes.includes(`${allowed}/presence`),
      "well-known allowed_url_prefixes should include expected public Presence API base"
    );

    const createSession = await requestJson(baseUrl, `${routeBasePath}/presence/link-sessions`, {
      method: "POST",
      body: {
        accountId,
        metadata: { source: "runtime-smoke" },
      },
    });
    assert(createSession.response.status === 200, "link session creation should return 200");
    assert(createSession.payload?.ok === true, "link session response should be ok=true");

    const session = createSession.payload?.session;
    assert(session?.id, "link session payload should include a session id");
    assert(
      createSession.payload?.completion?.endpoints?.complete?.method === "POST",
      "completion endpoint should include a POST verb"
    );
    assert(
      String(createSession.payload?.completion?.endpoints?.status?.path || "") !== "",
      "completion status endpoint should be present"
    );

    const sessionStatus = await requestJson(
      baseUrl,
      `${routeBasePath}/presence/link-sessions/${encodeURIComponent(session.id)}`
    );
    assert(sessionStatus.response.status === 200, "session status endpoint should return 200");
    assert(sessionStatus.payload?.session?.id === session.id, "session status should return the same session id");

    const readiness = await requestJson(
      baseUrl,
      `${routeBasePath}/presence/linked-accounts/${encodeURIComponent(accountId)}/status`
    );
    assert(readiness.response.status === 200, "linked account status endpoint should return 200");
    assert(readiness.payload?.ok === true, "linked account status should return ok=true");
    assert(readiness.payload?.readiness?.accountId === accountId, "linked account status should include accountId");
    assert(
      readiness.payload?.readiness?.state === "missing_binding",
      "unlinked account should report missing_binding state"
    );

    const nonce = await requestJson(
      baseUrl,
      `${routeBasePath}/presence/linked-accounts/${encodeURIComponent(accountId)}/nonce`,
      { method: "POST", body: {} }
    );
    assert(nonce.response.status === 404, "linked account nonce endpoint should return 404 for missing binding");
    assert(nonce.payload?.code === "ERR_BINDING_NOT_FOUND", "missing binding nonce should return ERR_BINDING_NOT_FOUND");

    const pendingList = await requestJson(
      baseUrl,
      `${routeBasePath}/presence/linked-accounts/${encodeURIComponent(accountId)}/pending-proof-requests`
    );
    assert(pendingList.response.status === 200, "pending-proof list endpoint should return 200");
    assert(Array.isArray(pendingList.payload?.proofRequests), "pending-proof list should include proofRequests array");

    if (shouldRunPendingProofProbe) {
      log("running optional pending-proof write-path probe.");

      const createProbe = await requestJson(
        baseUrl,
        `${routeBasePath}/presence/linked-accounts/${encodeURIComponent(accountId)}/pending-proof-requests`,
        { method: "POST", body: {} }
      );
      assert(
        createProbe.response.status === 404,
        "pending-proof create probe should return 404 for missing binding"
      );
      assert(
        createProbe.payload?.ok === false,
        "pending-proof create probe should include ok=false"
      );
      assert(
        createProbe.payload?.code === "ERR_BINDING_NOT_FOUND",
        "pending-proof create probe should return ERR_BINDING_NOT_FOUND"
      );
      assert(
        createProbe.payload?.state === "missing_binding",
        "pending-proof create probe should report missing_binding state"
      );

      const fakeRequestId = `probe-${randomBytes(4).toString("hex")}`;
      const statusProbe = await requestJson(
        baseUrl,
        `${routeBasePath}/presence/pending-proof-requests/${encodeURIComponent(fakeRequestId)}`
      );
      assert(statusProbe.response.status === 404, "pending-proof status probe should return 404 for unknown request");
      assert(
        statusProbe.payload?.code === "ERR_PENDING_PROOF_REQUEST_NOT_FOUND",
        "pending-proof status probe should return ERR_PENDING_PROOF_REQUEST_NOT_FOUND"
      );

      const respondProbe = await requestJson(
        baseUrl,
        `${routeBasePath}/presence/pending-proof-requests/${encodeURIComponent(fakeRequestId)}/respond`,
        {
          method: "POST",
          body: {},
        }
      );
      assert(
        respondProbe.response.status === 400,
        "pending-proof respond probe should return 400 for unknown request + malformed proof"
      );
      assert(
        respondProbe.payload?.ok === false,
        "pending-proof respond probe should include ok=false"
      );
      assert(
        respondProbe.payload?.code === "ERR_INVALID_FORMAT",
        "pending-proof respond probe should return ERR_INVALID_FORMAT for probe payload"
      );
    }

    const audits = await requestJson(baseUrl, `${routeBasePath}/presence/audit-events`);
    assert(audits.response.status === 200, "audit events endpoint should return 200");
    assert(Array.isArray(audits.payload?.events), "audit-events response should include events array");

    log("runtime smoke checks passed.");
  } finally {
    await stopServer(server);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
