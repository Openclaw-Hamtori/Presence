"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_PRESENCE_IOS_APP_ID,
  resolvePresenceServerConfig,
} = require("./presence-config.cjs");

test("resolvePresenceServerConfig() defaults to the checked-in iOS app id", () => {
  const config = resolvePresenceServerConfig({});

  assert.equal(config.iosAppId, DEFAULT_PRESENCE_IOS_APP_ID);
  assert.equal(config.iosAppIdSource, "default");
});

test("resolvePresenceServerConfig() prefers a trimmed env override", () => {
  const config = resolvePresenceServerConfig({
    PRESENCE_IOS_APP_ID: " TEAMID1234.com.example.override ",
  });

  assert.equal(config.iosAppId, "TEAMID1234.com.example.override");
  assert.equal(config.iosAppIdSource, "env");
});
