import { strict as assert } from "assert";
import { createServer } from "http";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { generateKeyPairSync, createSign } from "crypto";
import {
  PresenceClient,
  FileSystemLinkageStore,
  fileLinkageStorePath,
  createCompletionSessionResponse,
  createCompletionSuccessResponse,
  createRecoveryResponse,
  createLinkedAccountReadinessResponse,
} from "../index.js";
import { jcsSerialize, sha256Hex, deriveIss } from "presence-verifier";

function base64urlEncode(buf: Buffer): string {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64urlDecode(value: string): Buffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${padding}`, "base64");
}

function generateTestKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  return {
    privateKeyDer: privateKey as unknown as Buffer,
    publicKeyDer: publicKey as unknown as Buffer,
  };
}

function makeFakeDeviceAttestation() {
  const rawBytes = Buffer.from("fake-device-attestation-for-local-reference-server");
  return {
    rawBytes,
    digest: sha256Hex(rawBytes),
  };
}

function buildAttestation(publicKeyDer: Buffer, privateKeyDer: Buffer, nonce: string) {
  const now = Math.floor(Date.now() / 1000);
  const { digest } = makeFakeDeviceAttestation();
  const base = {
    pol_version: "1.0" as const,
    iss: deriveIss(publicKeyDer),
    iat: now,
    state_created_at: now - 60,
    state_valid_until: now + 600,
    human: true,
    pass: true,
    signals: ["heart_rate", "steps"] as const,
    nonce,
    device_attestation_digest: digest,
  };

  const canonical = jcsSerialize(base);
  const signer = createSign("SHA256");
  signer.update(Buffer.from(canonical, "utf8"));
  const signature = base64urlEncode(
    signer.sign({ key: privateKeyDer, format: "der", type: "pkcs8" })
  );

  return { ...base, signature };
}

function buildAndroidBody(publicKeyDer: Buffer, privateKeyDer: Buffer, nonce: string) {
  const { rawBytes } = makeFakeDeviceAttestation();
  return {
    platform: "android",
    attestation: buildAttestation(publicKeyDer, privateKeyDer, nonce),
    device_attestation: base64urlEncode(rawBytes),
    signing_public_key: base64urlEncode(publicKeyDer),
  };
}

async function readJson(req: import("http").IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), "presence-reference-server-"));
  const store = new FileSystemLinkageStore(fileLinkageStorePath(root));
  const presence = new PresenceClient({
    silent: true,
    serviceId: "demo-service",
    linkageStore: store,
    bindingPolicy: { allowReplacementOnMismatch: true },
  });

  const originalVerify = presence.verify.bind(presence);
  (presence as unknown as { verify: typeof presence.verify }).verify = async (body: unknown, expectedNonce: string) => {
    const request = body as { signing_public_key?: string };
    const signingPublicKey = request.signing_public_key ? base64urlDecode(request.signing_public_key) : Buffer.from("missing-key");
    return {
      verified: true as const,
      pol_version: "1.0" as const,
      iss: deriveIss(signingPublicKey),
      iat: Math.floor(Date.now() / 1000),
      state_created_at: Math.floor(Date.now() / 1000) - 60,
      state_valid_until: Math.floor(Date.now() / 1000) + 600,
      human: true,
      pass: true,
      signals: ["heart_rate", "steps"] as const,
      nonce: expectedNonce,
    };
  };

  const endpointContract = {
    createSessionPath: "/presence/link-sessions",
    completeSessionPath: "/presence/link-sessions/:sessionId/complete",
    sessionStatusPath: "/presence/link-sessions/:sessionId",
    verifyLinkedAccountPath: "/presence/linked-accounts/:accountId/verify",
    linkedStatusPath: "/presence/linked-accounts/:accountId/status",
  } as const;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const method = req.method ?? "GET";

      if (method === "POST" && url.pathname === "/presence/link-sessions") {
        const body = await readJson(req);
        const { session } = await presence.createLinkSession({
          serviceId: "demo-service",
          accountId: body.accountId,
          metadata: { source: "local-reference-test" },
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(createCompletionSessionResponse({ session, contract: endpointContract })));
        return;
      }

      const completeMatch = url.pathname.match(/^\/presence\/link-sessions\/([^/]+)\/complete$/);
      if (method === "POST" && completeMatch) {
        const body = await readJson(req);
        const result = await presence.completeLinkSession({ sessionId: decodeURIComponent(completeMatch[1]), body });
        const payload = !result.verification.verified || !result.binding || !result.device
          ? {
              ok: false,
              code: result.verification.verified ? "ERR_INVALID_FORMAT" : result.verification.error,
              message: result.verification.verified ? "missing linkage records" : result.verification.detail,
              session: result.session,
            }
          : createCompletionSuccessResponse({
              session: result.session,
              binding: result.binding,
              device: result.device,
            });
        res.writeHead(payload.ok ? 200 : 400, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
        return;
      }

      const verifyMatch = url.pathname.match(/^\/presence\/linked-accounts\/([^/]+)\/verify$/);
      if (method === "POST" && verifyMatch) {
        const body = await readJson(req);
        const nonceHeader = req.headers["x-presence-nonce"];
        const nonce = Array.isArray(nonceHeader) ? nonceHeader[0] : nonceHeader;
        const result = await presence.verifyLinkedAccount(body, {
          accountId: decodeURIComponent(verifyMatch[1]),
          nonce: String(nonce ?? ""),
        });
        let payload;
        if (result.verified && "binding" in result) {
          payload = {
            ok: true,
            state: "linked",
            binding: result.binding,
            snapshot: result.snapshot,
          };
        } else if (!result.verified && result.error === "ERR_BINDING_RECOVERY_REQUIRED") {
          payload = createRecoveryResponse(result);
        } else if (!result.verified) {
          payload = {
            ok: false,
            code: result.error,
            message: result.detail,
          };
        } else {
          payload = {
            ok: false,
            code: "ERR_INVALID_FORMAT",
            message: "linked verification response missing binding snapshot",
          };
        }
        res.writeHead(payload.ok ? 200 : 400, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
        return;
      }

      const statusMatch = url.pathname.match(/^\/presence\/linked-accounts\/([^/]+)\/status$/);
      if (method === "GET" && statusMatch) {
        const readiness = await presence.getLinkedAccountReadiness({
          accountId: decodeURIComponent(statusMatch[1]),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(createLinkedAccountReadinessResponse(readiness)));
        return;
      }

      const protectedMatch = url.pathname.match(/^\/protected\/([^/]+)$/);
      if (method === "GET" && protectedMatch) {
        const readiness = await presence.getLinkedAccountReadiness({
          accountId: decodeURIComponent(protectedMatch[1]),
        });
        const payload = { ok: readiness.ready, readiness };
        res.writeHead(readiness.ready ? 200 : 403, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, code: "ERR_NOT_FOUND" }));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, code: "ERR_INTERNAL", message: error instanceof Error ? error.message : String(error) }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind local server");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const device = generateTestKeyPair();

    const createRes = await fetch(`${baseUrl}/presence/link-sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: "acct-local-http" }),
    });
    assert.equal(createRes.status, 200);
    const created = await createRes.json() as { ok: true; session: { id: string }; completion: { sessionId: string } };
    assert.equal(created.ok, true);
    assert.equal(created.session.id, created.completion.sessionId);

    const storedSession = await store.getLinkSession(created.session.id);
    assert.ok(storedSession?.issuedNonce);

    const proofBody = buildAndroidBody(device.publicKeyDer, device.privateKeyDer, storedSession!.issuedNonce);

    const completeRes = await fetch(`${baseUrl}/presence/link-sessions/${created.session.id}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(proofBody),
    });
    assert.equal(completeRes.status, 200);
    const completed = await completeRes.json() as { ok: true; binding: { deviceIss: string; status: string } };
    assert.equal(completed.ok, true);
    assert.equal(completed.binding.status, "linked");

    const verifyNonce = presence.generateNonce().value;
    const verifyRes = await fetch(`${baseUrl}/presence/linked-accounts/acct-local-http/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-presence-nonce": verifyNonce,
      },
      body: JSON.stringify(buildAndroidBody(device.publicKeyDer, device.privateKeyDer, verifyNonce)),
    });
    assert.equal(verifyRes.status, 200);
    const verified = await verifyRes.json() as { ok: true; state: string; binding: { status: string } };
    assert.equal(verified.ok, true);
    assert.equal(verified.state, "linked");
    assert.equal(verified.binding.status, "linked");

    const protectedReadyRes = await fetch(`${baseUrl}/protected/acct-local-http`);
    assert.equal(protectedReadyRes.status, 200);

    const persistedBinding = await store.getServiceBinding("demo-service", "acct-local-http");
    assert.equal(persistedBinding?.status, "linked");
    assert.equal(persistedBinding?.deviceIss, completed.binding.deviceIss);
    assert.ok(persistedBinding?.lastSnapshot);
    if (!persistedBinding?.lastSnapshot) {
      throw new Error("missing persisted linked snapshot");
    }

    persistedBinding.lastSnapshot = {
      ...persistedBinding.lastSnapshot,
      pass: true,
      source: "verified_proof",
      stateValidUntil: Math.floor(Date.now() / 1000) - 1,
    };
    await store.saveServiceBinding(persistedBinding);

    const staleStatusRes = await fetch(`${baseUrl}/presence/linked-accounts/acct-local-http/status`);
    assert.equal(staleStatusRes.status, 200);
    const staleStatus = await staleStatusRes.json() as {
      ok: true;
      readiness: { ready: boolean; state: string; reason: string };
    };
    assert.equal(staleStatus.readiness.ready, false);
    assert.equal(staleStatus.readiness.state, "stale");
    assert.equal(staleStatus.readiness.reason, "snapshot_expired_grace");

    const protectedStaleRes = await fetch(`${baseUrl}/protected/acct-local-http`);
    assert.equal(protectedStaleRes.status, 403);

    console.log("  ✓ local reference server round-trip (create -> complete -> binding saved -> verify linked account)");
  } finally {
    (presence as unknown as { verify: typeof presence.verify }).verify = originalVerify;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("  ✗ local reference server round-trip:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
