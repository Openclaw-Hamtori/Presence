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
    hasRecovery: false,
    linkedServiceCount: 2,
    requestedServiceId: "presence-demo",
    requestedProofStatus: "submitting",
  });

  assert.equal(state.label, "CHECK");
  assert.equal(state.heading, "Submitting proof");
  assert.match(state.detail, /only after the service verifies/i);
});

test("getProductState() holds FAIL after linked proof verification fails even if local PASS exists", () => {
  const state = getProductState({
    phase: "ready",
    pass: true,
    hasRecovery: false,
    linkedServiceCount: 1,
    requestedServiceId: "presence-demo",
    requestedProofStatus: "failed",
  });

  assert.equal(state.label, "FAIL");
  assert.equal(state.heading, "Proof request failed");
  assert.match(state.action, /fresh local check/i);
});
