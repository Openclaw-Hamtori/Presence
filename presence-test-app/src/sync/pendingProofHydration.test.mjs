import test from "node:test";
import assert from "node:assert/strict";

import {
  hydrateBindingWithCanonicalSync,
  selectPendingProofRequestsForBindings,
} from "./pendingProofHydration.ts";

const API_BASE_URL = "https://noctu.link/presence-demo/presence";

test("hydrateBindingWithCanonicalSync() fills canonical linked-account sync URLs for recovered bindings", () => {
  const hydrated = hydrateBindingWithCanonicalSync({
    bindingId: "bind_1",
    serviceId: "presence-demo",
    accountId: "acct 1",
    linkedDeviceIss: "iss_current",
    linkedAt: 100,
    status: "linked",
  }, API_BASE_URL);

  assert.deepEqual(hydrated.sync, {
    serviceDomain: "noctu.link",
    nonceUrl: "https://noctu.link/presence-demo/presence/linked-accounts/acct%201/nonce",
    verifyUrl: "https://noctu.link/presence-demo/presence/linked-accounts/acct%201/verify",
    statusUrl: "https://noctu.link/presence-demo/presence/linked-accounts/acct%201/status",
    pendingRequestsUrl: "https://noctu.link/presence-demo/presence/linked-accounts/acct%201/pending-proof-requests",
  });
});

test("hydrateBindingWithCanonicalSync() preserves existing sync values while backfilling missing ones", () => {
  const hydrated = hydrateBindingWithCanonicalSync({
    bindingId: "bind_1",
    serviceId: "presence-demo",
    accountId: "acct-1",
    linkedDeviceIss: "iss_current",
    linkedAt: 100,
    status: "linked",
    sync: {
      serviceDomain: "presence.example.com",
      pendingRequestsUrl: "https://presence.example.com/custom/pending",
    },
  }, API_BASE_URL);

  assert.equal(hydrated.sync?.serviceDomain, "presence.example.com");
  assert.equal(hydrated.sync?.pendingRequestsUrl, "https://presence.example.com/custom/pending");
  assert.equal(hydrated.sync?.verifyUrl, "https://noctu.link/presence-demo/presence/linked-accounts/acct-1/verify");
});

test("selectPendingProofRequestsForBindings() keeps only actionable requests for the current device and bindings", () => {
  const bindings = [
    {
      bindingId: "bind_active",
      serviceId: "presence-demo",
      accountId: "acct-1",
      linkedDeviceIss: "iss_current",
      linkedAt: 100,
      status: "linked",
    },
    {
      bindingId: "bind_revoked",
      serviceId: "presence-demo",
      accountId: "acct-2",
      linkedDeviceIss: "iss_current",
      linkedAt: 100,
      status: "revoked",
    },
    {
      bindingId: "bind_other_device",
      serviceId: "presence-demo",
      accountId: "acct-3",
      linkedDeviceIss: "iss_other",
      linkedAt: 100,
      status: "linked",
    },
  ];

  const requests = [
    {
      requestId: "req_other_device",
      serviceId: "presence-demo",
      accountId: "acct-3",
      bindingId: "bind_other_device",
      deviceIss: "iss_other",
      nonce: "nonce-3",
      requestedAt: 300,
      expiresAt: 900,
      status: "pending",
      respondUrl: "https://example.com/respond-3",
    },
    {
      requestId: "req_active_newer",
      serviceId: "presence-demo",
      accountId: "acct-1",
      bindingId: "bind_active",
      deviceIss: "iss_current",
      nonce: "nonce-2",
      requestedAt: 250,
      expiresAt: 900,
      status: "pending",
      respondUrl: "https://example.com/respond-2",
    },
    {
      requestId: "req_revoked",
      serviceId: "presence-demo",
      accountId: "acct-2",
      bindingId: "bind_revoked",
      deviceIss: "iss_current",
      nonce: "nonce-4",
      requestedAt: 240,
      expiresAt: 900,
      status: "pending",
      respondUrl: "https://example.com/respond-4",
    },
    {
      requestId: "req_active_older",
      serviceId: "presence-demo",
      accountId: "acct-1",
      bindingId: "bind_active",
      nonce: "nonce-1",
      requestedAt: 200,
      expiresAt: 900,
      status: "pending",
      respondUrl: "https://example.com/respond-1",
    },
    {
      requestId: "req_active_expired",
      serviceId: "presence-demo",
      accountId: "acct-1",
      bindingId: "bind_active",
      deviceIss: "iss_current",
      nonce: "nonce-5",
      requestedAt: 150,
      expiresAt: 900,
      status: "expired",
      respondUrl: "https://example.com/respond-5",
    },
  ];

  const pending = selectPendingProofRequestsForBindings({
    requests,
    bindings,
    deviceIss: "iss_current",
    statuses: ["pending"],
  });
  const expired = selectPendingProofRequestsForBindings({
    requests,
    bindings,
    deviceIss: "iss_current",
    statuses: ["expired"],
  });

  assert.deepEqual(
    pending.map((request) => request.requestId),
    ["req_active_newer", "req_active_older"]
  );
  assert.deepEqual(
    expired.map((request) => request.requestId),
    ["req_active_expired"]
  );
});
