# Presence Test App

Reference React Native test surface for the Presence mobile flow.

## What changed in this phase

The app now demonstrates a realistic connection UX:

1. Service creates a one-time link session
2. Session is encoded as a QR/deeplink payload (`presence://link?...`)
3. App opens the deeplink and previews the session
4. User approves on device
5. Proof is generated with `link_context` and a completion target
6. Linked services refresh from successful PASS proofs; ordinary FAIL measurements are kept local and are not pushed upstream as a separate failure event

## Notes

- On iPhone, the top-right QR entry now opens a native AVFoundation-based camera scanner and feeds the scanned payload into the same link-session approval flow.
- Manual paste / deeplink open still works as a fallback and uses the exact same parsing + approval path.
- The app also registers the `presence://` URL scheme so a service deeplink can jump straight into the current session preview.
- The home screen now exposes product-facing state changes more clearly: session opened, ready to approve, proof created, binding saved, and recovery needed.
- Simulator builds can compile, but live QR scanning itself still requires a real iPhone camera.

## Checks

```bash
npm run type-check
npm run lint
```

`lint` currently depends on project-local ESLint configuration/tooling that is not fully present in this repo snapshot.
