#!/usr/bin/env node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

function assert(condition, message) {
  if (!condition) {
    console.error(`[server-auth-check] FAILED: ${message}`);
    process.exit(1);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function addAuthHeaders(baseHeaders, key) {
  if (!key) return baseHeaders;
  return {
    ...(baseHeaders || {}),
    Authorization: `Bearer ${key}`,
    "content-type": "application/json",
  };
}

async function requestJson(baseUrl, path, options = {}, apiKey) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers: addAuthHeaders({
      "content-type": "application/json",
      ...(options.headers || {}),
    }, apiKey),
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    assert(false, `invalid JSON from ${response.url}: ${text.slice(0, 160)}`);
  }

  return { response, payload };
}

async function startServer({ port, host, serviceApiKey }) {
  const tmpStorage = mkdtempSync(join(tmpdir(), "presence-server-auth-"));
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
        PRESENCE_SERVICE_API_KEY: serviceApiKey,
      },
    }
  );

  child.stdout?.on("data", (chunk) => {
    const message = String(chunk).toString().trim();
    if (message) console.log(`[presence-happy-path] ${message}`);
  });

  child.stderr.on("data", (chunk) => {
    const message = String(chunk).toString().trim();
    if (message) console.error(`[presence-happy-path] ${message}`);
  });

  const baseUrl = `http://${host}:${port}`;
  const deadline = Date.now() + 12_000;

  while (Date.now() < deadline) {
    try {
      const health = await requestJson(baseUrl, "/health");
      if (health.response.ok && health.payload?.ok === true) {
        return { child, tmpStorage };
      }
    } catch {
      // allow startup jitter
    }

    await sleep(200);
  }

  child.kill("SIGTERM");
  throw new Error("server startup timeout");
}

async function stopServer(state) {
  if (!state) return;
  const { child, tmpStorage } = state;
  if (child && !child.killed) {
    child.kill("SIGTERM");
    await sleep(120);
  }
  if (tmpStorage) {
    rmSync(tmpStorage, { recursive: true, force: true });
  }
}

async function main() {
  const key = "presence-min-boundary-test-key";
  const baseUrl = "http://127.0.0.1:18930";
  const host = "127.0.0.1";
  const port = 18930;

  const server = await startServer({ port, host, serviceApiKey: key });

  try {
    const accountId = `auth-check-${Math.random().toString(16).slice(2, 8)}`;

    const health = await requestJson(baseUrl, "/health");
    assert(health.response.status === 200, "health should stay public when auth is enabled");

    const createNoAuth = await requestJson(baseUrl, "/presence/link-sessions", {
      method: "POST",
      body: { accountId },
    });
    assert(createNoAuth.response.status === 401, "createSession should require auth");
    assert(createNoAuth.payload.code === "ERR_AUTH_REQUIRED", "createSession should return auth error code");

    const createWithAuth = await requestJson(baseUrl, "/presence/link-sessions", {
      method: "POST",
      body: { accountId, metadata: { source: "auth-check" } },
    }, key);
    assert(createWithAuth.response.status === 200, "authenticated createSession should succeed");
    const sessionId = String(createWithAuth.payload?.session?.id || "");
    assert(sessionId, "createSession should return session id");

    const createWithAuthAltHeader = await requestJson(baseUrl, "/presence/link-sessions", {
      method: "POST",
      body: { accountId, metadata: { source: "auth-check-alt" } },
      headers: { "x-presence-service-api-key": key },
    });
    assert(createWithAuthAltHeader.response.status === 200, "x-presence-service-api-key should also authenticate");

    const createWithWrongAuth = await requestJson(baseUrl, "/presence/link-sessions", {
      method: "POST",
      body: { accountId, metadata: { source: "auth-check" } },
    }, `${key}bad`);
    assert(createWithWrongAuth.response.status === 401, "wrong service API key should fail");

    const createWithShortAuth = await requestJson(baseUrl, "/presence/link-sessions", {
      method: "POST",
      headers: { "x-presence-service-api-key": key.slice(0, -1) },
      body: { accountId, metadata: { source: "auth-check" } },
    });
    assert(createWithShortAuth.response.status === 401, "shorter service API key should fail");

    const sessionGetNoAuth = await requestJson(baseUrl, `/presence/link-sessions/${encodeURIComponent(sessionId)}`);
    assert(sessionGetNoAuth.response.status === 401, "session status route should require auth");

    const statusNoAuth = await requestJson(baseUrl, `/presence/linked-accounts/${encodeURIComponent(accountId)}/status`);
    assert(statusNoAuth.response.status === 401, "linked account status should require auth");

    const auditsNoAuth = await requestJson(baseUrl, "/presence/audit-events");
    assert(auditsNoAuth.response.status === 401, "audit-events should require auth");

    const completeNoAuth = await requestJson(baseUrl, `/presence/link-sessions/${encodeURIComponent(sessionId)}/complete`, {
      method: "POST",
      body: { bad: "proof" },
    });
    assert(completeNoAuth.response.status !== 401, "completion callback should remain public");
    assert(completeNoAuth.payload?.ok === false, "completion callback should still fail validation with invalid payload");

    console.log("[server-auth-check] all auth boundary checks passed");
  } finally {
    await stopServer(server);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
