import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPresenceLinkUrl,
  parsePresenceLinkUrl,
} from "../../presence-mobile/src/deeplink.ts";

test("parsePresenceLinkUrl() parses standard presence links", () => {
  const built = buildPresenceLinkUrl({
    sessionId: "plink_abc123",
    serviceId: "presence-demo",
    serviceDomain: "noctu.link",
    accountId: "acct-demo",
    bindingId: "pbind_demo",
    flow: "initial_link",
    method: "deeplink",
    nonce: "n0nce",
    nonceUrl: "https://noctu.link/presence/nonce",
    verifyUrl: "https://noctu.link/presence/verify",
    statusUrl: "https://noctu.link/presence/link-sessions/plink_abc123",
  });

  const parsed = parsePresenceLinkUrl(built);
  assert.equal(parsed?.sessionId, "plink_abc123");
  assert.equal(parsed?.serviceDomain, "noctu.link");
  assert.equal(parsed?.statusUrl, "https://noctu.link/presence/link-sessions/plink_abc123");
  assert.equal(parsed?.flow, "initial_link");
});

test("parsePresenceLinkUrl() can parse fragment-based deep links (cold-start path)", () => {
  const raw = "presence://link#session_id=plink_frag&service_domain=noctu.link&status_url=https%3A%2F%2Fnoctu.link%2Fpresence%2Fstatus";

  const parsed = parsePresenceLinkUrl(raw);
  assert.equal(parsed?.sessionId, "plink_frag");
  assert.equal(parsed?.serviceDomain, "noctu.link");
  assert.equal(parsed?.statusUrl, "https://noctu.link/presence/status");
});

test("parsePresenceLinkUrl() can recover percent-encoded query payloads", () => {
  const encoded = "presence://link%3Fsession_id%3Dplink_encoded%26service_domain%3Dnoctu.link%26status_url%3Dhttps%253A%252F%252Fnoctu.link%252Fpresence%252Fstatus";

  const parsed = parsePresenceLinkUrl(encoded);
  assert.equal(parsed?.sessionId, "plink_encoded");
  assert.equal(parsed?.serviceDomain, "noctu.link");
  assert.equal(parsed?.statusUrl, "https://noctu.link/presence/status");
});
