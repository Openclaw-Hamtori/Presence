import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPresenceLinkUrl,
  parsePresenceLinkUrl,
} from "../../presence-mobile/src/deeplink.ts";

test("parsePresenceLinkUrl() parses short canonical presence links", () => {
  const built = buildPresenceLinkUrl({ sessionId: "plink_abc123", serviceDomain: "demo.presence.local" });

  const parsed = parsePresenceLinkUrl(built);
  assert.equal(parsed?.sessionId, "plink_abc123");
  assert.equal(parsed?.serviceDomain, "demo.presence.local");
  assert.equal(parsed?.flow, undefined);
  assert.equal(parsed?.nonce, undefined);
  assert.equal((new URL(built)).searchParams.get("s"), "plink_abc123");
  assert.equal((new URL(built)).searchParams.get("d"), "demo.presence.local");
  assert.equal((new URL(built)).searchParams.has("service_domain"), false);
  assert.equal((new URL(built)).searchParams.has("session_id"), false);
});

test("parsePresenceLinkUrl() parses fragment-based short links", () => {
  const raw = "presence://link#s=plink_frag&service_domain=noctu.link";

  const parsed = parsePresenceLinkUrl(raw);
  assert.equal(parsed?.sessionId, "plink_frag");
  assert.equal(parsed?.serviceDomain, "noctu.link");
});

test("parsePresenceLinkUrl() can recover percent-encoded short payloads", () => {
  const encoded = "presence://link%3Fs%3Dplink_encoded%26d%3Dnoctu.link";

  const parsed = parsePresenceLinkUrl(encoded);
  assert.equal(parsed?.sessionId, "plink_encoded");
  assert.equal(parsed?.serviceDomain, "noctu.link");
});

test("parsePresenceLinkUrl() accepts explicit legacy service_domain param", () => {
  const raw = "presence://link?s=plink_legacy&service_domain=noctu.link";

  const parsed = parsePresenceLinkUrl(raw);
  assert.equal(parsed?.sessionId, "plink_legacy");
  assert.equal(parsed?.serviceDomain, "noctu.link");
});
