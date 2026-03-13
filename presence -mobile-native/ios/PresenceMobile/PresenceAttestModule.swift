// PresenceAttestModule.swift
//
// React Native bridge for Apple App Attest (DCAppAttestService).
// Implements the PresenceAttestNativeModule contract defined in:
//   presence-mobile/src/attestation/appAttest.ts
//
// Flow:
//   1. isSupported()         — check device support (A12+ chip, iOS 14+)
//   2. generateAttestKey()   — DCAppAttestService.generateKey()
//   3. attestKey(id, hash)   — DCAppAttestService.attest(keyId, clientDataHash)
//
// All byte outputs are base64url-encoded (no padding, - and _ alphabet).
//
// Key persistence:
//   keyId is stored in UserDefaults under "pol_attest_key_id".
//   On re-launch, JS calls generateAttestKey() which returns the stored keyId
//   if one exists — or generates a new one if not.
//
// iOS 14+ required (DCAppAttestService availability).
// Simulator: isSupported() returns false. Use a physical device for testing.

import Foundation
import DeviceCheck
import CryptoKit

@objc(PresenceAttest)
class PresenceAttestModule: NSObject {

  private let keyIdDefaultsKey     = "pol_attest_key_id"
  private let attestationDefaultsKey = "pol_attest_obj"   // base64url-encoded attestation bytes
  private let service = DCAppAttestService.shared

  // MARK: - RN Module Name

  @objc static func moduleName() -> String { "PresenceAttest" }
  @objc static func requiresMainQueueSetup() -> Bool { false }

  // MARK: - Availability

  /// Returns true if App Attest is supported on this device.
  /// Requires: physical device, A12+ chip, iOS 14+.
  @objc func isSupported(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject _: @escaping RCTPromiseRejectBlock
  ) {
    if #available(iOS 14.0, *) {
      resolve(service.isSupported)
    } else {
      resolve(false)
    }
  }

  // MARK: - Key Generation

  /// Generate (or retrieve) an App Attest key.
  ///
  /// Idempotent: if a keyId is already stored in UserDefaults, returns it.
  /// Call this once during onboarding, then persist the returned keyId in JS state.
  ///
  /// Returns: keyId string (opaque, managed by DCAppAttestService)
  @objc func generateAttestKey(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    guard #available(iOS 14.0, *) else {
      reject("ERR_APP_ATTEST_FAILED", "App Attest requires iOS 14+", nil)
      return
    }

    guard service.isSupported else {
      reject("ERR_APP_ATTEST_FAILED", "App Attest not supported on this device", nil)
      return
    }

    // Return existing keyId if already generated
    if let existingKeyId = UserDefaults.standard.string(forKey: keyIdDefaultsKey) {
      resolve(existingKeyId)
      return
    }

    // Generate new key
    service.generateKey { [weak self] keyId, error in
      guard let self = self else { return }

      if let error = error {
        reject("ERR_APP_ATTEST_FAILED", "Key generation failed: \(error.localizedDescription)", error)
        return
      }

      guard let keyId = keyId else {
        reject("ERR_APP_ATTEST_FAILED", "Key generation returned nil keyId", nil)
        return
      }

      // Persist keyId
      UserDefaults.standard.set(keyId, forKey: self.keyIdDefaultsKey)
      resolve(keyId)
    }
  }

  // MARK: - Attestation

  /// Attest a key with a challenge hash.
  ///
  /// Parameters:
  ///   keyId:         from generateAttestKey()
  ///   challengeHash: hex string of SHA-256(nonce bytes)
  ///                  computed in JS: sha256Hex(base64urlToUint8Array(nonce))
  ///
  /// Returns: base64url-encoded attestation object (CBOR bytes from Apple)
  ///
  /// Note: attestation is a one-time operation per keyId.
  /// The returned object must be sent to the verifier on first use.
  /// For subsequent proofs, use assertKey() instead (see PresenceAttestAssertModule).
  @objc func attestKey(
    _ keyId: String,
    challengeHash: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    guard #available(iOS 14.0, *) else {
      reject("ERR_APP_ATTEST_FAILED", "App Attest requires iOS 14+", nil)
      return
    }

    // Return cached attestation if already generated.
    // DCAppAttestService.attestKey() is a one-time operation per keyId.
    // After onboarding, the same attestation object is re-sent with each request.
    // Per-request freshness is guaranteed by the outer PresenceAttestation nonce + Secure Enclave sig.
    if let cached = UserDefaults.standard.string(forKey: attestationDefaultsKey) {
      resolve(cached)
      return
    }

    // Convert hex challengeHash → Data (clientDataHash for DCAppAttestService)
    guard let clientDataHash = Data(hexString: challengeHash) else {
      reject("ERR_APP_ATTEST_FAILED", "challengeHash is not valid hex: \(challengeHash)", nil)
      return
    }

    service.attestKey(keyId, clientDataHash: clientDataHash) { [weak self] attestation, error in
      guard let self = self else { return }

      if let error = error {
        reject("ERR_APP_ATTEST_FAILED", "Attestation failed: \(error.localizedDescription)", error)
        return
      }

      guard let attestation = attestation else {
        reject("ERR_APP_ATTEST_FAILED", "Attestation returned nil data", nil)
        return
      }

      let encoded = attestation.base64urlEncoded()
      // Persist attestation for all future requests
      UserDefaults.standard.set(encoded, forKey: self.attestationDefaultsKey)
      resolve(encoded)
    }
  }

  // MARK: - Key Reset

  /// Delete stored keyId (e.g. on app reset / re-onboarding).
  /// After this, generateAttestKey() will create a fresh key.
  @objc func resetAttestKey(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject _: @escaping RCTPromiseRejectBlock
  ) {
    UserDefaults.standard.removeObject(forKey: keyIdDefaultsKey)
    UserDefaults.standard.removeObject(forKey: attestationDefaultsKey)
    resolve(true)
  }
}

// MARK: - Data Extensions

private extension Data {
  /// Decode lowercase hex string → Data. Returns nil if input is not valid hex.
  init?(hexString: String) {
    let hex = hexString.lowercased()
    guard hex.count % 2 == 0 else { return nil }
    var data = Data(capacity: hex.count / 2)
    var index = hex.startIndex
    while index < hex.endIndex {
      let nextIndex = hex.index(index, offsetBy: 2)
      guard let byte = UInt8(hex[index..<nextIndex], radix: 16) else { return nil }
      data.append(byte)
      index = nextIndex
    }
    self = data
  }

  /// Encode Data → base64url string (no padding, - and _ alphabet).
  func base64urlEncoded() -> String {
    base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}
