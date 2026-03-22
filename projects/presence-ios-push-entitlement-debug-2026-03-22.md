# iOS APNs entitlement investigation (PresenceTestApp) — 2026-03-22

## What I found
- `PresenceTestApp/PresenceTestApp.entitlements` currently contains:
  - `com.apple.developer.aps-environment = development`
  - plus HealthKit entitlements.
- Local build settings are automatic signing, Team `A5F3ESYN49`, bundle id `com.cooicoo.presenceapp`.
- Built app profiles at:
  - `.../Build/Products/Debug-iphoneos/Presence.app`
  - `.../Build/Products/Release-iphoneos/Presence.app`
  are using provisioning profile:
  - UUID `44b087ab-616d-4090-8d96-01ca4df6e6e8`
- That profile **does** include:
  - `aps-environment = development`
  - confirmed via `security cms -D -i embedded.mobileprovision`.
- However, Xcode-generated entitlements for both Debug/Release at:
  - `.../Build/Intermediates.noindex/PresenceTestApp.build/*/PresenceTestApp.build/Presence.app.xcent`
  do **not** include `aps-environment`.

So the signed app artifact is missing the APNs entitlement even though:
1) entitlements file sets it, and
2) the selected provisioning profile contains it.

## Why this matches Apple guidance
- Apple DTS states if APNs still fails, compare profile entitlements vs app code-sign entitlements:
  - `security cms -D -i <app>.app/embedded.mobileprovision`
  - `codesign -d --entitlements - <app>.app`
- In a matching thread, DTS advised this mismatch can happen with profiles and is often fixed by refreshing provisioning when push is enabled.
- Apple docs on signing/capabilities indicate Xcode capability-based signing should manage this entitlement automatically.

## Most likely root cause
A local Xcode signing/capability configuration is out of sync with the active app-signing entitlement set used at build/sign time. The profile is okay, but entitlement injection during signing is dropping `aps-environment`.

## Exact next action (human/app-owner)
1. In the Apple Developer portal, verify App ID `com.cooicoo.presenceapp` has Push Notifications enabled (if not, enable).
2. In Xcode for `PresenceTestApp`, open **Signing & Capabilities** and ensure **Push Notifications** is enabled.
3. Toggle to Manual signing briefly then back to Automatic (or delete/recreate the provisioning profile in portal), then select the regenerated `Development` profile.
4. Clean build folder + remove old app from device, rebuild/install fresh.
5. Recheck:
   - `presence.app.xcent` should include `com.apple.developer.aps-environment`.
   - App log should no longer show "no valid 'aps-environment' entitlement string found for application" when registering notifications.

If the portal/App ID configuration is inaccessible from this machine, this is the blocking item: only local code changes cannot guarantee this fix.
