"use strict";

const { createSign, createPrivateKey } = require("crypto");
const { connect } = require("http2");
const { readFileSync, existsSync } = require("fs");
const { resolve: resolvePath } = require("path");

const DEFAULT_APNS_HOSTS = {
  production: "api.push.apple.com",
  development: "api.sandbox.push.apple.com",
};
const DEFAULT_APNS_TIMEOUT_MS = 5000;

function base64UrlEncode(value) {
  return value
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function normalizePem(raw) {
  if (typeof raw !== "string") {
    return "";
  }
  return raw
    .replace(/\\n/g, "\n")
    .trim();
}

function resolvePrivateKey(env) {
  const keyPath = env.PRESENCE_APNS_KEY_PATH ? resolvePath(env.PRESENCE_APNS_KEY_PATH) : null;
  if (keyPath) {
    if (!existsSync(keyPath)) {
      throw new Error(`PRESENCE_APNS_KEY_PATH not found: ${keyPath}`);
    }
    return normalizePem(readFileSync(keyPath, "utf8"));
  }

  const inlineBase64 = env.PRESENCE_APNS_KEY_B64 || env.PRESENCE_APNS_KEY_BASE64;
  if (inlineBase64) {
    try {
      return normalizePem(Buffer.from(inlineBase64, "base64").toString("utf8"));
    } catch (error) {
      throw new Error(`Failed to decode PRESENCE_APNS_KEY_B64: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (env.PRESENCE_APNS_KEY) {
    return normalizePem(env.PRESENCE_APNS_KEY);
  }

  throw new Error("Missing APNs private key (set PRESENCE_APNS_KEY_PATH or PRESENCE_APNS_KEY/PRESENCE_APNS_KEY_B64)");
}

function resolveTransportConfig(env, options = {}) {
  const teamId = (env.PRESENCE_APNS_TEAM_ID || "").trim();
  const keyId = (env.PRESENCE_APNS_KEY_ID || "").trim();
  const defaultTopic = (options.defaultTopic || env.PRESENCE_APNS_TOPIC || "").trim();

  if (!teamId) {
    throw new Error("Missing PRESENCE_APNS_TEAM_ID");
  }

  if (!keyId) {
    throw new Error("Missing PRESENCE_APNS_KEY_ID");
  }

  const key = resolvePrivateKey(env);
  if (!key.includes("BEGIN PRIVATE KEY") && !key.includes("BEGIN EC PRIVATE KEY")) {
    throw new Error("PRESENCE_APNS_KEY does not look like a PEM private key");
  }

  const timeoutMs = Number.parseInt(env.PRESENCE_APNS_TIMEOUT_MS || "", 10);

  return {
    teamId,
    keyId,
    defaultTopic,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_APNS_TIMEOUT_MS,
    privateKey: key,
  };
}

function createJwt({ teamId, keyId, privateKey }) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(Buffer.from(JSON.stringify({ alg: "ES256", kid: keyId }), "utf8"));
  const claim = base64UrlEncode(Buffer.from(JSON.stringify({
    iss: teamId,
    iat: now,
  }), "utf8"));
  const token = `${header}.${claim}`;
  const signer = createSign("SHA256");
  signer.update(token);
  signer.end();
  const signature = signer.sign(createPrivateKey(privateKey));
  return `${token}.${base64UrlEncode(signature)}`;
}

function parseApnsResponse(stream) {
  return new Promise((resolve, reject) => {
    let body = "";
    const responseHeaders = {};

    stream.on("response", (headers) => {
      Object.assign(responseHeaders, headers);
    });

    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      body += chunk;
    });

    stream.on("end", () => {
      const status = Number(responseHeaders[":status"] || 0);
      let payload = null;
      if (body) {
        try {
          payload = JSON.parse(body);
        } catch {
          payload = body;
        }
      }
      resolve({
        status,
        providerMessageId: responseHeaders["apns-id"] || null,
        payload,
      });
    });

    stream.on("error", reject);
  });
}

function createApnsDeliveryRequest({ sessionHost, token, topic, payload, authToken, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const client = connect(`https://${sessionHost}`);
    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${encodeURIComponent(token)}`,
      "content-type": "application/json",
      "authorization": `bearer ${authToken}`,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-topic": topic,
      "apns-expiration": "0",
    });

    const timeout = setTimeout(() => {
      req.close();
      client.close();
      reject(new Error(`APNs request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    parseApnsResponse(req)
      .then((result) => {
        clearTimeout(timeout);
        req.close();
        client.close();
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timeout);
        req.close();
        client.close();
        reject(error);
      });

    req.end(JSON.stringify(payload));
  });
}

function createApnsPendingProofSignalTransport(env = process.env, options = {}) {
  const config = resolveTransportConfig(env, options);
  const logger = options.logger || { warn: () => {}, error: () => {} };

  return {
    async deliver({ signal, targets }) {
      if (!targets?.length) {
        return { provider: "apns", targetCount: 0 };
      }

      const now = Math.floor(Date.now() / 1000);
      const authToken = createJwt({
        teamId: config.teamId,
        keyId: config.keyId,
        privateKey: config.privateKey,
      });

      const payload = {
        aps: {
          alert: {
            title: "Presence action needed",
            body: "A Presence proof request is waiting.",
          },
          sound: "default",
        },
        presence_signal: signal,
      };

      const results = await Promise.allSettled(targets.map((target) => {
        const topic = (target.bundleId || config.defaultTopic || "").trim();
        const environment = target.environment === "production" ? "production" : "development";
        const endpoint = DEFAULT_APNS_HOSTS[environment] || DEFAULT_APNS_HOSTS.development;

        if (!topic) {
          return Promise.reject(new Error(`Cannot send APNs for token ${target.token}: missing topic/bundleId`));
        }

        return createApnsDeliveryRequest({
          sessionHost: endpoint,
          token: target.token,
          topic,
          payload,
          authToken,
          timeoutMs: config.timeoutMs,
        });
      }));

      const delivered = [];
      const failures = [];

      for (const result of results) {
        if (result.status !== "fulfilled") {
          failures.push(result.reason?.message || String(result.reason));
          continue;
        }

        const response = result.value;
        if (response.status !== 200) {
          const detail = response.payload && response.payload.reason
            ? response.payload.reason
            : response.payload
              ? JSON.stringify(response.payload)
              : "unknown";
          failures.push(`APNs status=${response.status}, reason=${detail}`);
          continue;
        }

        delivered.push(response.providerMessageId || "ok");
      }

      if (!delivered.length) {
        throw new Error(`APNs delivery failed for all targets: ${failures.join("; ") || "unknown"}`);
      }

      if (failures.length > 0) {
        logger.warn(`APNs partial delivery for request=${signal.requestId}: ${failures.join("; ")}`);
      }

      return {
        provider: "apns",
        deliveredAt: now,
        providerMessageId: delivered[0],
        targetCount: delivered.length,
      };
    },
  };
}

module.exports = {
  createApnsPendingProofSignalTransport,
  resolveTransportConfig,
};
