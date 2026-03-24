import test from "node:test";
import assert from "node:assert/strict";

import {
  buildProveOptionsFromEnvelope,
  resolveRequestedLinkedBinding,
  shouldUseLinkedVerifyRoute,
  syncFromEnvelope,
  hydrateLinkCompletionEnvelopeFromSession,
} from "./requestedBinding.ts";

test("hydrateLinkCompletionEnvelopeFromSession() enriches a short pointer payload", () => {
  const hydrated = hydrateLinkCompletionEnvelopeFromSession(
    {
      id: "plink_abc",
      serviceId: "presence-demo",
      accountId: "acct-1",
      issuedNonce: "n0nce",
      status: "pending",
      expiresAt: Math.floor(Date.now() / 1000) + 120,
      completion: {
        sessionStatusUrl: "https://demo.presence.local/presence/link-sessions/plink_abc",
        linkedNonceApiUrl: "https://demo.presence.local/presence/linked-accounts/acct-1/nonce",
        verifyLinkedAccountApiUrl: "https://demo.presence.local/presence/linked-accounts/acct-1/verify",
        pendingProofRequestsApiUrl: "https://demo.presence.local/presence/linked-accounts/acct-1/pending-proof-requests",
        fallbackCode: "ABC123",
      },
    }
  );

  assert.equal(hydrated.ok, true);
  if (!hydrated.ok) {
    return;
  }

  assert.equal(hydrated.value.nonce, "n0nce");
  assert.equal(hydrated.value.serviceDomain, "demo.presence.local");
  assert.equal(hydrated.value.statusUrl, "https://demo.presence.local/presence/link-sessions/plink_abc");
  assert.equal(hydrated.value.nonceUrl, "https://demo.presence.local/presence/linked-accounts/acct-1/nonce");
  assert.equal(hydrated.value.verifyUrl, "https://demo.presence.local/presence/linked-accounts/acct-1/verify");
  assert.equal(hydrated.value.code, "ABC123");
});

test("hydrateLinkCompletionEnvelopeFromSession() fails when session is consumed or expired", () => {
  const expired = hydrateLinkCompletionEnvelopeFromSession({
    id: "plink_expired",
    serviceId: "presence-demo",
    accountId: "acct-1",
    issuedNonce: "n0nce",
    status: "pending",
    expiresAt: Math.floor(Date.now() / 1000) - 1,
    completion: {},
  });
  assert.equal(expired.ok, false);
  if (expired.ok) {
    return;
  }
  assert.equal(expired.code, "ERR_LINK_SESSION_EXPIRED");

  const consumed = hydrateLinkCompletionEnvelopeFromSession({
    id: "plink_consumed",
    serviceId: "presence-demo",
    accountId: "acct-1",
    issuedNonce: "n0nce",
    status: "consumed",
    completion: {
      sessionStatusUrl: "https://demo.presence.local/presence/link-sessions/plink_consumed",
    },
  });
  assert.equal(consumed.ok, false);
  if (consumed.ok) {
    return;
  }
  assert.equal(consumed.code, "ERR_LINK_SESSION_CONSUMED");
});

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

test("resolveRequestedLinkedBinding() preserves linked-state precedence for explicit initial_link", () => {
  const binding = {
    bindingId: "pbind_current",
    serviceId: "presence-demo",
    accountId: "acct-1",
    linkedDeviceIss: "presence:device:abc",
    linkedAt: 1,
    lastVerifiedAt: 2,
    status: "linked",
  };

  const explicitInitialLink = resolveRequestedLinkedBinding({
    sessionId: "plink_explicit_initial",
    serviceId: "presence-demo",
    accountId: "acct-1",
    bindingId: "pbind_current",
    flow: "initial_link",
  }, [binding]);

  assert.equal(explicitInitialLink, null);
});

test("shouldUseLinkedVerifyRoute() prefers initial-link flow even with binding_hint", () => {
  const binding = {
    bindingId: "pbind_existing",
    serviceId: "presence-demo",
    accountId: "acct-1",
    linkedDeviceIss: "presence:device:abc",
    linkedAt: 1,
    lastVerifiedAt: 2,
    status: "linked",
  };

  const explicitInitialLinkDecision = shouldUseLinkedVerifyRoute({
    envelope: {
      sessionId: "plink_initial_with_hint",
      serviceId: "presence-demo",
      accountId: "acct-1",
      bindingId: "pbind_existing",
      flow: "initial_link",
      nonce: "n",
      nonceUrl: "https://demo.presence.local/presence/nonce",
      verifyUrl: "https://demo.presence.local/presence/verify",
      statusUrl: "https://demo.presence.local/presence/status",
    },
    openedRequestedBinding: binding,
  });

  assert.equal(explicitInitialLinkDecision, false);
});

test("shouldUseLinkedVerifyRoute() treats malformed explicit flow as explicit non-reauth", () => {
  const binding = {
    bindingId: "pbind_existing",
    serviceId: "presence-demo",
    accountId: "acct-1",
    linkedDeviceIss: "presence:device:abc",
    linkedAt: 1,
    lastVerifiedAt: 2,
    status: "linked",
  };

  assert.equal(
    shouldUseLinkedVerifyRoute({
      envelope: {
        sessionId: "plink_malformed_flow",
        flow: "",
        serviceId: "presence-demo",
        accountId: "acct-1",
        bindingId: "pbind_existing",
        nonce: "n",
      },
      openedRequestedBinding: binding,
    }),
    false
  );
});

test("buildProveOptionsFromEnvelope() preserves trust sync in initial-link completion path", () => {
  const options = buildProveOptionsFromEnvelope({
    sessionId: "plink_initial_trust",
    serviceId: "presence-demo",
    accountId: "acct-trust",
    nonce: "n0nce",
    serviceDomain: "demo.presence.local",
    statusUrl: "https://demo.presence.local/presence/link-sessions/plink_initial_trust",
    nonceUrl: "https://demo.presence.local/presence/nonce",
    verifyUrl: "https://demo.presence.local/presence/verify",
  });

  assert.equal(options?.flow, "initial_link");
  assert.equal(options?.bindingHint, undefined);
  assert.equal(options?.linkSession.completion.sync?.serviceDomain, "demo.presence.local");
  assert.equal(options?.linkSession.completion.sync?.statusUrl, "https://demo.presence.local/presence/link-sessions/plink_initial_trust");
  assert.equal(options?.linkSession.completion.sync?.nonceUrl, "https://demo.presence.local/presence/nonce");
  assert.equal(options?.linkSession.completion.sync?.verifyUrl, "https://demo.presence.local/presence/verify");
});

test("syncFromEnvelope() drops empty sync values", () => {
  const sync = syncFromEnvelope({
    sessionId: "plink_789",
    serviceId: "presence-demo",
    nonce: "n",
    nonceUrl: "  ",
    verifyUrl: "https://demo.presence.local/presence/linked-accounts/acct-1/verify",
    serviceDomain: " demo.presence.local ",
  });

  assert.deepEqual(sync, {
    serviceDomain: "demo.presence.local",
    verifyUrl: "https://demo.presence.local/presence/linked-accounts/acct-1/verify",
  });
});
