/**
 * JCS Serialization Tests (RFC 8785)
 *
 * Tests confirm our jcsSerialize() produces correct canonical output.
 * These vectors are derived from RFC 8785 Appendix B test cases.
 */

import { strict as assert } from "assert";
import { jcsSerialize } from "../crypto.js";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}`);
    throw e;
  }
}

console.log("\n── JCS Serialization ──");

test("null", () => {
  assert.equal(jcsSerialize(null), "null");
});

test("true / false", () => {
  assert.equal(jcsSerialize(true), "true");
  assert.equal(jcsSerialize(false), "false");
});

test("integer", () => {
  assert.equal(jcsSerialize(0), "0");
  assert.equal(jcsSerialize(1), "1");
  assert.equal(jcsSerialize(-1), "-1");
  assert.equal(jcsSerialize(42), "42");
});

test("-0 is normalized to 0", () => {
  assert.equal(jcsSerialize(-0), "0");
});

test("float", () => {
  assert.equal(jcsSerialize(3.14), "3.14");
  assert.equal(jcsSerialize(1.5e10), "15000000000");
});

test("non-finite number throws", () => {
  assert.throws(() => jcsSerialize(Infinity), TypeError);
  assert.throws(() => jcsSerialize(-Infinity), TypeError);
  assert.throws(() => jcsSerialize(NaN), TypeError);
});

test("simple string", () => {
  assert.equal(jcsSerialize("hello"), '"hello"');
});

test("string with control chars", () => {
  // JSON.stringify handles \n, \t, \r etc.
  assert.equal(jcsSerialize("a\nb"), '"a\\nb"');
  assert.equal(jcsSerialize("a\tb"), '"a\\tb"');
});

test("empty object", () => {
  assert.equal(jcsSerialize({}), "{}");
});

test("object key sorting", () => {
  // Keys must be in Unicode code point order
  const result = jcsSerialize({ b: 2, a: 1 });
  assert.equal(result, '{"a":1,"b":2}');
});

test("nested object key sorting", () => {
  const result = jcsSerialize({ z: { b: 2, a: 1 }, a: 0 });
  assert.equal(result, '{"a":0,"z":{"a":1,"b":2}}');
});

test("array preserves order", () => {
  assert.equal(jcsSerialize([3, 1, 2]), "[3,1,2]");
});

test("array of objects", () => {
  const result = jcsSerialize([{ b: 2, a: 1 }]);
  assert.equal(result, '[{"a":1,"b":2}]');
});

test("Presence Attestation field order", () => {
  // Verify that signals and other fields are sorted correctly
  const obj = {
    pol_version: "1.0",
    nonce: "abc",
    iss: "presence:device:aabbccdd",
    human: true,
  };
  const result = jcsSerialize(obj);
  // Keys sorted alphabetically
  assert.equal(
    result,
    '{"human":true,"iss":"presence:device:aabbccdd","nonce":"abc","pol_version":"1.0"}'
  );
});

test("same output for same input (deterministic)", () => {
  const obj = { z: 3, a: 1, m: 2 };
  assert.equal(jcsSerialize(obj), jcsSerialize(obj));
  assert.equal(jcsSerialize(obj), '{"a":1,"m":2,"z":3}');
});
