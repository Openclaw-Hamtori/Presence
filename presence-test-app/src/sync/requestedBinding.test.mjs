import test from "node:test";
import assert from "node:assert/strict";

import { resolveRequestedLinkedBinding, syncFromEnvelope } from "./requestedBinding.ts";

test("resolveRequestedLinkedBinding() reuses the existing linked binding and merges sync metadata from the request", () => {
  const binding = {
    bindingId: "pbind_123",
    serviceId: "presence-demo",
    accountId: "acct-1",
    linkedDeviceIss: "presence:device:abc",
    linkedAt: 1,
    lastVerifiedAt: 2,
    status: "linked",
    sync: {
      serviceDomain: "demo.presence.local",
      nonceUrl: "https://demo.presence.local/presence/linked-accounts/acct-1/nonce",
    },
  };

  const resolved = resolveRequestedLinkedBinding({
    sessionId: "plink_123",
    serviceId: "presence-demo",
    accountId: "acct-1",
    nonceUrl: "https://demo.presence.local/presence/linked-accounts/acct-1/nonce-next",
    verifyUrl: "https://demo.presence.local/presence/linked-accounts/acct-1/verify",
    statusUrl: "https://demo.presence.local/presence/link-sessions/plink_123",
  }, [binding]);

  assert.equal(resolved?.bindingId, "pbind_123");
  assert.deepEqual(resolved?.sync, {
    serviceDomain: "demo.presence.local",
    nonceUrl: "https://demo.presence.local/presence/linked-accounts/acct-1/nonce-next",
    verifyUrl: "https://demo.presence.local/presence/linked-accounts/acct-1/verify",
    statusUrl: "https://demo.presence.local/presence/link-sessions/plink_123",
  });
});

test("resolveRequestedLinkedBinding() prefers binding_id matching for linked proof requests", () => {
  const bindings = [
    {
      bindingId: "pbind_old",
      serviceId: "presence-demo",
      accountId: "acct-1",
      linkedDeviceIss: "presence:device:abc",
      linkedAt: 1,
      lastVerifiedAt: 2,
      status: "linked",
    },
    {
      bindingId: "pbind_target",
      serviceId: "presence-demo",
      accountId: "acct-2",
      linkedDeviceIss: "presence:device:abc",
      linkedAt: 1,
      lastVerifiedAt: 2,
      status: "linked",
    },
  ];

  const resolved = resolveRequestedLinkedBinding({
    sessionId: "plink_456",
    serviceId: "presence-demo",
    bindingId: "pbind_target",
    flow: "reauth",
    verifyUrl: "https://demo.presence.local/presence/linked-accounts/acct-2/verify",
  }, bindings);

  assert.equal(resolved?.bindingId, "pbind_target");
});

test("resolveRequestedLinkedBinding() does not hijack relink/recovery sessions", () => {
  const binding = {
    bindingId: "pbind_relink",
    serviceId: "presence-demo",
    accountId: "acct-1",
    linkedDeviceIss: "presence:device:abc",
    linkedAt: 1,
    lastVerifiedAt: 2,
    status: "linked",
  };

  const relink = resolveRequestedLinkedBinding({
    sessionId: "plink_relink",
    serviceId: "presence-demo",
    accountId: "acct-1",
    flow: "relink",
  }, [binding]);

  const recovery = resolveRequestedLinkedBinding({
    sessionId: "plink_recovery",
    serviceId: "presence-demo",
    accountId: "acct-1",
    flow: "recovery",
  }, [binding]);

  assert.equal(relink, null);
  assert.equal(recovery, null);
});

test("syncFromEnvelope() drops empty sync values", () => {
  const sync = syncFromEnvelope({
    sessionId: "plink_789",
    serviceId: "presence-demo",
    nonceUrl: "  ",
    verifyUrl: "https://demo.presence.local/presence/linked-accounts/acct-1/verify",
    serviceDomain: " demo.presence.local ",
  });

  assert.deepEqual(sync, {
    serviceDomain: "demo.presence.local",
    verifyUrl: "https://demo.presence.local/presence/linked-accounts/acct-1/verify",
  });
});
