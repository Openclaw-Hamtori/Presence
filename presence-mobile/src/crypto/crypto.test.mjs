import test from "node:test";
import assert from "node:assert/strict";

import { sha256Hex } from "./sha256.ts";

const UTF8 = new TextEncoder();

function shaHex(input) {
  return sha256Hex(UTF8.encode(input));
}

test("sha256Hex matches known-answer vectors", () => {
  assert.equal(shaHex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(shaHex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(
    shaHex("The quick brown fox jumps over the lazy dog"),
    "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592"
  );
  assert.equal(shaHex("foo"), "2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae");
});
