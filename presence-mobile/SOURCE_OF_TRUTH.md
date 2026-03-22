# Presence Mobile Source of Truth

## Canonical ownership
- `presence-mobile/src/` is the canonical reusable mobile client source.
- `presence-test-app/App.tsx` is the canonical product-facing test surface shell.
- Any reusable logic added in `presence-test-app/src/` should be moved back into `presence-mobile/src/` promptly.

## Current rule
- Do not let `presence-test-app/src/` drift into a long-lived fork of `presence-mobile/src/`.
- If the test app needs app-only glue, keep that glue narrow and explicit.
- Shared crypto / health / service / state / deeplink / linkage logic belongs in `presence-mobile/src/`.

## Guardrail
- Run `npm run check:mobile-sync` before landing mobile/test-app changes that touch duplicated paths.
- The guard classifies every duplicated file as either:
  - a byte-identical mirror that must stay in lockstep, or
  - a bridge file in `presence-test-app/src/` that re-exports the canonical `presence-mobile/src/` implementation, or
  - an explicit `INTENTIONAL_FORK` in `presence-test-app/src/` with a narrow reason.
- New duplicated files are not allowed to appear silently; the guard fails until they are categorized deliberately.

## Boundary vocabulary
- Backend/sdk `ServiceBinding.deviceIss` is the same identifier that mobile/test-app local state stores as `ServiceBinding.linkedDeviceIss`.
- Backend/session completion metadata may start as backend-relative paths; mobile/test-app `PresenceBindingSync` only accepts public absolute URLs after the backend rewrites them.
- Mobile UI is local UX only. Backend readiness and bindings remain authoritative.
- Mobile/test-app `PresenceState.pass` means the latest local measurement can support proof generation. It must not be surfaced as requestless/server-verified PASS by product UI.
- Mobile/test-app `PresenceSnapshot.source: "proof"` means the app generated proof material locally. It does not, by itself, mean the backend verified that proof.

## Field aliasing
- Mobile/test-app `activeLinkSession.status: "consumed"` is the same completed-session meaning as sdk `LinkSession.status: "consumed"`; older local state may still contain the legacy alias `"linked"`.
- Other `LinkSession.status` values are layer-specific: mobile/test-app may surface local UX states like `revoked` or `recovery_pending`, while sdk linkage store may emit backend lifecycle values like `cancelled`. Do not assume every non-`consumed` value is shared verbatim across layers.
- Mobile/test-app `PresenceSnapshot.source: "measurement" | "proof"` maps to sdk `PresenceSnapshot.source: "local_measurement" | "verified_proof"`.
- Mobile/test-app `linkedDevice.linkedAt` maps to sdk `LinkedDevice.firstLinkedAt`.
- Mobile/test-app `activeLinkSession.lastNonce` maps to sdk `LinkSession.issuedNonce`.
- Mobile/test-app `activeLinkSession.createdAt` maps to sdk `LinkSession.requestedAt`.
- Mobile/test-app `ServiceBinding.linkedAt` maps to sdk `ServiceBinding.lastLinkedAt`, with sdk `createdAt` used only as a fallback when hydrating older backend records.
- `accountId` may be absent while mobile is holding pre-completion link context, but sdk-persisted `LinkSession` and `ServiceBinding` records require it.

## Intentional duplication today
- `presence-test-app/src/crypto/index.ts` remains a diagnostic fork of [`presence-mobile/src/crypto/index.ts`](/Users/chaesung/Desktop/Presence_GPT/presence-mobile/src/crypto/index.ts) so the test app can log signature/base64 normalization details during device debugging.
- `presence-test-app/src/health/healthkit.ts` remains a validation fork of [`presence-mobile/src/health/healthkit.ts`](/Users/chaesung/Desktop/Presence_GPT/presence-mobile/src/health/healthkit.ts) because the test app uses tuned query settings for compressed real-device checks.
- `presence-test-app/src/index.ts` remains an app-surface fork of [`presence-mobile/src/index.ts`](/Users/chaesung/Desktop/Presence_GPT/presence-mobile/src/index.ts) so the test app can expose validation-only helpers without redefining the reusable package contract silently.
- `presence-test-app/src/linkTrust.ts` remains a diagnostic fork of [`presence-mobile/src/linkTrust.ts`](/Users/chaesung/Desktop/Presence_GPT/presence-mobile/src/linkTrust.ts) so the test app can log trust-boundary normalization details during QR/deeplink debugging.
- `presence-test-app/src/service.ts` remains an app-behavior fork of [`presence-mobile/src/service.ts`](/Users/chaesung/Desktop/Presence_GPT/presence-mobile/src/service.ts) so the test app can preserve app-specific proof orchestration/local persistence behavior.
- `presence-test-app/src/state/presenceState.ts` remains a validation fork of [`presence-mobile/src/state/presenceState.ts`](/Users/chaesung/Desktop/Presence_GPT/presence-mobile/src/state/presenceState.ts) because the test app uses compressed timing constants and app-only hydration helpers.
- `presence-test-app/src/sync/linkedBindings.ts` remains a diagnostic fork of [`presence-mobile/src/sync/linkedBindings.ts`](/Users/chaesung/Desktop/Presence_GPT/presence-mobile/src/sync/linkedBindings.ts) because the test app records detailed sync diagnostics that the reusable package does not expose.

## Bridged duplicates today
- `presence-test-app/src/backgroundRefresh.ts` re-exports [`presence-mobile/src/backgroundRefresh.ts`](/Users/chaesung/Desktop/Presence_GPT/presence-mobile/src/backgroundRefresh.ts).
- `presence-test-app/src/deeplink.ts` re-exports [`presence-mobile/src/deeplink.ts`](/Users/chaesung/Desktop/Presence_GPT/presence-mobile/src/deeplink.ts).
- `presence-test-app/src/health/pass.ts` re-exports [`presence-mobile/src/health/pass.ts`](/Users/chaesung/Desktop/Presence_GPT/presence-mobile/src/health/pass.ts).
- `presence-test-app/src/qrScanner.ts` re-exports [`presence-mobile/src/qrScanner.ts`](/Users/chaesung/Desktop/Presence_GPT/presence-mobile/src/qrScanner.ts).
- `presence-test-app/src/sync/queue.ts` re-exports [`presence-mobile/src/sync/queue.ts`](/Users/chaesung/Desktop/Presence_GPT/presence-mobile/src/sync/queue.ts).
- `presence-test-app/src/types/index.ts` re-exports [`presence-mobile/src/types/index.ts`](/Users/chaesung/Desktop/Presence_GPT/presence-mobile/src/types/index.ts).
- `presence-test-app/src/ui/connectionLinking.ts` re-exports [`presence-mobile/src/ui/connectionLinking.ts`](/Users/chaesung/Desktop/Presence_GPT/presence-mobile/src/ui/connectionLinking.ts).

## Mirrored duplicates today
- Remaining duplicated files under `presence-test-app/src/` are expected to stay byte-identical to their `presence-mobile/src/` counterpart and are enforced by `npm run check:mobile-sync`.

## Near-term follow-up
- Reduce remaining duplication between `presence-mobile/src/` and `presence-test-app/src/`.
- Prefer import/re-export or shared helpers over parallel manual edits whenever the test app does not need extra diagnostics.
- When a duplicated file changes behavior, mirror the equivalent change in its counterpart in the same pass or document the intentional divergence immediately.
