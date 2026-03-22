import test from "node:test";
import assert from "node:assert/strict";

import {
  createEmptyPushSetupState,
  getLatestPushToken,
  isPushUploadConfirmed,
  notePushTokenReceived,
  notePushUploadAttempt,
  notePushUploadConfirmed,
  notePushUploadConfirmationCleared,
  pushRegistrationSignature,
} from "../../presence-mobile/src/pushRegistrationState.ts";

const REGISTRATION = {
  token: "AA BB CC DD EE FF 00 11 22 33 44 55 66 77 88 99 00 AA 11 22 33 44 55 66 77 88 99 00 AA BB CC DD EE FF 01",
  platform: "ios_apns",
  environment: "development",
  bundleId: "com.presence.testapp",
};

test("notePushTokenReceived() stores the latest normalized APNs token for later setup retry", () => {
  const state = notePushTokenReceived(createEmptyPushSetupState(), REGISTRATION, {
    receivedAt: 123,
  });

  assert.deepEqual(getLatestPushToken(state), {
    token: "aabbccddeeff0011223344556677889900aa11223344556677889900aabbccddeeff01",
    platform: "ios_apns",
    environment: "development",
    bundleId: "com.presence.testapp",
  });
  assert.equal(state.latestToken?.receivedAt, 123);
});

test("notePushUploadConfirmed() marks the exact device/token slot as confirmed", () => {
  const state = notePushUploadConfirmed(
    notePushTokenReceived(createEmptyPushSetupState(), REGISTRATION),
    {
      deviceIss: "presence:device:123",
      registration: REGISTRATION,
      confirmedAt: 456,
    }
  );

  assert.equal(
    isPushUploadConfirmed(state, {
      deviceIss: "presence:device:123",
      registration: REGISTRATION,
    }),
    true
  );
  assert.equal(
    state.devices[0]?.confirmedRegistrationSignature,
    pushRegistrationSignature({
      deviceIss: "presence:device:123",
      registration: {
        token: "AABBCCDDEEFF0011223344556677889900AA11223344556677889900AABBCCDDEEFF01",
        environment: "development",
        bundleId: "com.presence.testapp",
      },
    })
  );
  assert.equal(state.devices[0]?.lastUploadConfirmedAt, 456);
});

test("notePushUploadAttempt() keeps failed upload state until a later confirmation clears it", () => {
  const attempted = notePushUploadAttempt(
    notePushTokenReceived(createEmptyPushSetupState(), REGISTRATION),
    {
      deviceIss: "presence:device:retry",
      registration: REGISTRATION,
      attemptedAt: 200,
      error: "linked device not found",
    }
  );

  assert.equal(
    isPushUploadConfirmed(attempted, {
      deviceIss: "presence:device:retry",
      registration: REGISTRATION,
    }),
    false
  );
  assert.equal(attempted.devices[0]?.lastUploadError, "linked device not found");

  const confirmed = notePushUploadConfirmed(attempted, {
    deviceIss: "presence:device:retry",
    registration: REGISTRATION,
    confirmedAt: 300,
  });

  assert.equal(
    isPushUploadConfirmed(confirmed, {
      deviceIss: "presence:device:retry",
      registration: REGISTRATION,
    }),
    true
  );
  assert.equal(confirmed.devices[0]?.lastUploadError, undefined);
  assert.equal(confirmed.devices[0]?.lastUploadConfirmedAt, 300);
});

test("notePushUploadConfirmationCleared() drops stale confirmation for matching device/token", () => {
  const confirmed = notePushUploadConfirmed(
    notePushTokenReceived(createEmptyPushSetupState(), REGISTRATION),
    {
      deviceIss: "presence:device:clear",
      registration: REGISTRATION,
      confirmedAt: 456,
    }
  );

  const cleared = notePushUploadConfirmationCleared(confirmed, {
    deviceIss: "presence:device:clear",
    registration: REGISTRATION,
  });

  assert.equal(
    isPushUploadConfirmed(cleared, {
      deviceIss: "presence:device:clear",
      registration: REGISTRATION,
    }),
    false
  );
  assert.equal(cleared.devices[0]?.confirmedRegistrationSignature, undefined);
  assert.equal(cleared.devices[0]?.lastUploadConfirmedAt, undefined);
});
