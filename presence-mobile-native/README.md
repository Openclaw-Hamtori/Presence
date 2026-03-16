# presence-mobile-native

Swift native modules for presence-mobile.

```
ios/PresenceMobile/
├── PresenceHealthKitModule.swift   — HealthKit BPM + steps bridge
├── PresenceHealthKitModule.m       — RN bridge registration
├── PresenceAttestModule.swift      — App Attest (DCAppAttestService) bridge
└── PresenceAttestModule.m          — RN bridge registration
```

---

## Setup

### 1. Copy files into your Xcode project

Copy all 4 files into your RN project's `ios/<AppName>/` directory.
Add them to the Xcode target (Build Phases → Compile Sources).

### 2. Podfile

```ruby
# No additional pods needed.
# HealthKit and DeviceCheck are system frameworks.
```

### 3. Link system frameworks

In Xcode → Build Phases → Link Binary With Libraries, add:
- `HealthKit.framework`
- `DeviceCheck.framework`  ← App Attest is part of DeviceCheck

### 4. Info.plist

```xml
<key>NSHealthShareUsageDescription</key>
<string>Presence reads heart rate data to confirm you're present. Data never leaves your device.</string>
```

### 5. Entitlements

App Attest requires the `com.apple.developer.devicecheck.appattest-environment` entitlement.

```xml
<!-- YourApp.entitlements -->
<key>com.apple.developer.devicecheck.appattest-environment</key>
<string>production</string>  <!-- or "development" for debug builds -->
```

---

## PresenceHealthKit

### Methods

| Method | Returns | Notes |
|--------|---------|-------|
| `isAvailable()` | `Promise<boolean>` | false on iPad/simulator |
| `requestPermissions()` | `Promise<boolean>` | Shows iOS Health permission sheet |
| `getHeartRateSamples(options)` | `Promise<Sample[]>` | Throws if no data |
| `getStepCount(options)` | `Promise<StepResult>` | Returns 0 if no steps |

### Sample shape
```ts
{ value: number, startDate: string, endDate: string }
```

### Options shape
```ts
{ startDate: string, endDate: string, limit?: number, ascending?: boolean }
```

---

## PresenceAttest

### Methods

| Method | Returns | Notes |
|--------|---------|-------|
| `isSupported()` | `Promise<boolean>` | Requires A12+, iOS 14+, physical device |
| `generateAttestKey()` | `Promise<string>` | Returns keyId; idempotent (persists in UserDefaults) |
| `attestKey(keyId, challengeHash)` | `Promise<string>` | base64url attestation object |
| `resetAttestKey()` | `Promise<boolean>` | Clears stored keyId |

### `attestKey` parameters

- `keyId`: from `generateAttestKey()`
- `challengeHash`: **hex string** of SHA-256(nonce bytes)
  - Computed in JS: `sha256Hex(base64urlToUint8Array(nonce))`
- Returns: base64url-encoded CBOR attestation object

### Notes on App Attest

- `attestKey()` is one-time per keyId. Apple's servers verify the certificate chain.
- On subsequent proof requests, the same attestation object is re-sent.
  The verifier validates freshness via the nonce, not by re-attesting.
- Simulator always returns `isSupported() = false`. Test on a physical device.
- Development vs production environment: set entitlement accordingly.
  Mixing environments causes attestation failures.

---

## iOS Version Requirements

| Feature | Minimum iOS |
|---------|-------------|
| HealthKit | iOS 8+ |
| App Attest | iOS 14+ |
| React Native 0.74 | iOS 13.4+ |

Effective minimum: **iOS 14** (App Attest is the binding constraint).
