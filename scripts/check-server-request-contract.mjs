#!/usr/bin/env node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

function assert(condition, message) {
  if (!condition) {
    console.error(`[server-request-check] FAILED: ${message}`);
    process.exit(1);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function addAuthHeaders(headers, key) {
  if (!key) {
    return headers;
  }
  return {
    ...headers,
    Authorization: `Bearer ${key}`,
  };
}

async function requestWithBody(baseUrl, path, { body, headers = {}, method = "GET", key } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: addAuthHeaders({
      "content-type": "application/json",
      ...headers,
    }, key),
    body,
  });

  const text = await response.text();
  let payload = {};

  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    assert(false, `invalid JSON response from ${response.url}: ${text.slice(0, 120)}`);
  }

  return { response, payload };
}

async function requestJson(baseUrl, path, options = {}) {
  return requestWithBody(baseUrl, path, {
    ...options,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers: options.headers || {},
  });
}


async function startServer({ host, port, serviceApiKey, maxBodyBytes }) {
  const tmpStorage = mkdtempSync(join(tmpdir(), "presence-server-request-check-"));

  const child = spawn(
    "node",
    ["presence-happy-path/app/server.cjs"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOST: host,
        PORT: String(port),
        PRESENCE_STORAGE_ROOT: join(tmpStorage, "presence-storage"),
        PRESENCE_SERVICE_API_KEY: serviceApiKey,
        PRESENCE_REFERENCE_AUTH_MODE: "strict",
        ...(maxBodyBytes ? { PRESENCE_MAX_BODY_BYTES: String(maxBodyBytes) } : {}),
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

    await sleep(150);
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
  const host = "127.0.0.1";
  const port = 18890;
  const baseUrl = `http://${host}:${port}`;
  const apiKey = "presence-parse-contract-key";

  const server = await startServer({
    host,
    port,
    serviceApiKey: apiKey,
    maxBodyBytes: 64,
  });

  try {
    const badJson = await requestWithBody(baseUrl, "/presence/link-sessions", {
      method: "POST",
      key: apiKey,
      body: "{\"accountId\":\"x\"",
    });
    assert(badJson.response.status === 400, "malformed JSON should return 400");
    assert(
      badJson.payload?.code === "ERR_INVALID_JSON",
      "malformed JSON should map to ERR_INVALID_JSON"
    );

    const nonObjectBody = await requestJson(baseUrl, "/presence/link-sessions", {
      method: "POST",
      key: apiKey,
      body: ["not", "an", "object"],
    });
    assert(nonObjectBody.response.status === 400, "non-object body should return 400");
    assert(
      nonObjectBody.payload?.code === "ERR_INVALID_BODY",
      "non-object body should map to ERR_INVALID_BODY"
    );

    const emptyBody = await requestWithBody(baseUrl, "/presence/link-sessions", {
      method: "POST",
      key: apiKey,
      body: "",
    });
    assert(emptyBody.response.status === 400, "empty body should return 400");
    assert(
      emptyBody.payload?.code === "ERR_EMPTY_BODY",
      "empty body should map to ERR_EMPTY_BODY"
    );

    const oversized = await requestWithBody(baseUrl, "/presence/link-sessions", {
      method: "POST",
      key: apiKey,
      body: JSON.stringify({ accountId: "x".repeat(100) }),
    });
    assert(oversized.response.status === 413, "oversized request should return 413");
    assert(
      oversized.payload?.code === "ERR_REQUEST_BODY_TOO_LARGE",
      "oversized request should map to ERR_REQUEST_BODY_TOO_LARGE"
    );

    const invalidParam = await requestJson(baseUrl, "/presence/link-sessions/%E0%A0", {
      method: "GET",
      key: apiKey,
    });
    assert(invalidParam.response.status === 400, "invalid path param should return 400");
    assert(
      invalidParam.payload?.code === "ERR_INVALID_PATH_PARAM",
      "invalid path param should map to ERR_INVALID_PATH_PARAM"
    );

    const completeWithBadPath = await requestJson(baseUrl, "/presence/link-sessions/%ZZ/complete", {
      method: "POST",
      body: {},
    });
    assert(
      completeWithBadPath.response.status === 400,
      "malformed callback path should return 400 instead of 500"
    );
    assert(
      completeWithBadPath.payload?.code === "ERR_INVALID_PATH_PARAM",
      "callback malformed path should map to ERR_INVALID_PATH_PARAM"
    );

    console.log("[server-request-check] request parsing/error contract checks passed.");
  } finally {
    await stopServer(server);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
