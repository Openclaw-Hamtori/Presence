"use strict";

const DEFAULT_PRESENCE_IOS_APP_ID = "A5F3ESYN49.com.cooicoo.presenceapp";

function resolvePresenceServerConfig(env = process.env) {
  const configuredIosAppId = typeof env.PRESENCE_IOS_APP_ID === "string"
    ? env.PRESENCE_IOS_APP_ID.trim()
    : "";

  return {
    iosAppId: configuredIosAppId || DEFAULT_PRESENCE_IOS_APP_ID,
    iosAppIdSource: configuredIosAppId ? "env" : "default",
  };
}

module.exports = {
  DEFAULT_PRESENCE_IOS_APP_ID,
  resolvePresenceServerConfig,
};
