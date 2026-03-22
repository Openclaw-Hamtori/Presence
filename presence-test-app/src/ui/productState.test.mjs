import test from "node:test";
import assert from "node:assert/strict";

import { buildRequestedProofKey, getProductState } from "./productState.ts";

test("buildRequestedProofKey() scopes linked proof UI state to the active request", () => {
  assert.equal(
    buildRequestedProofKey({
      requestId: "ppreq_123",
      bindingId: "pbind_456",
      serviceId: "presence-demo",
      accountId: "acct-1",
    }),
    "ppreq_123:pbind_456:presence-demo:acct-1"
  );
  assert.equal(
    buildRequestedProofKey({
      sessionId: "plink_123",
      bindingId: "pbind_456",
      serviceId: "presence-demo",
      accountId: "acct-1",
    }),
    "plink_123:pbind_456:presence-demo:acct-1"
  );
  assert.equal(buildRequestedProofKey({ sessionId: null, bindingId: "pbind_456" }), null);
});

test("getProductState() does not show PASS while linked proof is still being verified", () => {
  const state = getProductState({
    phase: "ready",
    pass: true,
    hasLocalMeasurement: true,
    hasRecovery: false,
    linkedServiceCount: 2,
    requestedServiceId: "presence-demo",
    requestedProofStatus: "submitting",
  });

  assert.equal(state.label, "VERIFY");
  assert.equal(state.heading, "Submitting proof");
  assert.match(state.detail, /reserved for server-verified success/i);
});

test("getProductState() holds FAIL after linked proof verification fails even if local PASS exists", () => {
  const state = getProductState({
    phase: "ready",
    pass: true,
    hasLocalMeasurement: true,
    hasRecovery: false,
    linkedServiceCount: 1,
    requestedServiceId: "presence-demo",
    requestedProofStatus: "failed",
  });

  assert.equal(state.label, "FAIL");
  assert.equal(state.heading, "Proof request failed");
  assert.match(state.action, /submit proof/i);
});

test("getProductState() treats requestless local success as local-only instead of PASS", () => {
  const state = getProductState({
    phase: "ready",
    pass: true,
    hasLocalMeasurement: true,
    hasRecovery: false,
    linkedServiceCount: 2,
    requestedServiceId: null,
    requestedProofStatus: null,
  });

  assert.equal(state.label, "LOCAL");
  assert.equal(state.heading, "No active request");
  assert.match(state.detail, /nothing has been server-verified/i);
  assert.match(state.summary, /No active request/i);
});

test("getProductState() shows READY instead of PASS when a request exists but only local measurement succeeded", () => {
  const state = getProductState({
    phase: "ready",
    pass: true,
    hasLocalMeasurement: true,
    hasRecovery: false,
    linkedServiceCount: 1,
    requestedServiceId: "presence-demo",
    requestedProofStatus: null,
  });

  assert.equal(state.label, "READY");
  assert.equal(state.heading, "Ready to submit proof");
  assert.match(state.detail, /nothing is server-verified yet/i);
});

test("getProductState() surfaces expired request state explicitly", () => {
  const state = getProductState({
    phase: "ready",
    pass: true,
    hasLocalMeasurement: true,
    hasRecovery: false,
    linkedServiceCount: 1,
    requestedServiceId: "presence-demo",
    requestedProofStatus: "expired",
  });

  assert.equal(state.label, "EXPIRED");
  assert.equal(state.heading, "Request expired");
  assert.match(state.action, /fresh service request/i);
});
