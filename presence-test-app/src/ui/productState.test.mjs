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

  assert.equal(state.label, "IDLE");
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

test("getProductState() shows PASS briefly after server-verified success when no request remains", () => {
  const state = getProductState({
    phase: "ready",
    pass: true,
    hasLocalMeasurement: true,
    hasRecovery: false,
    linkedServiceCount: 2,
    requestedServiceId: null,
    requestedProofStatus: null,
    recentVerifiedServiceId: "presence-demo",
  });

  assert.equal(state.label, "PASS");
  assert.equal(state.heading, "PASS verified");
  assert.match(state.detail, /completed server verification/i);
  assert.match(state.summary, /Recently verified/i);
});

test("getProductState() shows CONNECTED! briefly after initial link success", () => {
  const state = getProductState({
    phase: "ready",
    pass: false,
    hasLocalMeasurement: false,
    hasRecovery: false,
    linkedServiceCount: 1,
    requestedServiceId: null,
    requestedProofStatus: null,
    connectedServiceId: "presence-demo",
  });

  assert.equal(state.label, "CONNECTED!");
  assert.equal(state.heading, "Linked to presence-demo");
  assert.match(state.action, /briefly/i);
});

test("getProductState() does not let a recent verified proof override a new active request", () => {
  const state = getProductState({
    phase: "ready",
    pass: true,
    hasLocalMeasurement: true,
    hasRecovery: false,
    linkedServiceCount: 2,
    requestedServiceId: "presence-demo",
    requestedProofStatus: null,
    recentVerifiedServiceId: "presence-demo",
  });

  assert.equal(state.label, "IDLE");
  assert.equal(state.heading, "Ready to submit proof");
  assert.match(state.detail, /nothing is server-verified yet/i);
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

  assert.equal(state.label, "IDLE");
  assert.equal(state.heading, "No active request");
  assert.match(state.detail, /nothing has been server-verified/i);
  assert.match(state.summary, /No active request/i);
});

test("getProductState() keeps a request in IDLE when only local measurement succeeded", () => {
  const state = getProductState({
    phase: "ready",
    pass: true,
    hasLocalMeasurement: true,
    hasRecovery: false,
    linkedServiceCount: 1,
    requestedServiceId: "presence-demo",
    requestedProofStatus: null,
  });

  assert.equal(state.label, "IDLE");
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

  assert.equal(state.label, "FAIL");
  assert.equal(state.heading, "Request expired");
  assert.match(state.action, /fresh service request/i);
});

test("getProductState() keeps a newly loaded request idle until a local check actually runs", () => {
  const state = getProductState({
    phase: "ready",
    pass: false,
    hasLocalMeasurement: false,
    hasRecovery: false,
    linkedServiceCount: 1,
    requestedServiceId: "presence-demo",
    requestedProofStatus: null,
  });

  assert.equal(state.label, "IDLE");
  assert.equal(state.heading, "Request loaded");
  assert.match(state.action, /run a local check/i);
});

test("getProductState() treats requestless local measurement failure as FAIL", () => {
  const state = getProductState({
    phase: "not_ready",
    pass: false,
    hasLocalMeasurement: true,
    hasRecovery: false,
    linkedServiceCount: 0,
    requestedServiceId: null,
    requestedProofStatus: null,
  });

  assert.equal(state.label, "FAIL");
  assert.equal(state.heading, "Local check failed");
  assert.match(state.detail, /nothing was submitted to a server/i);
});
