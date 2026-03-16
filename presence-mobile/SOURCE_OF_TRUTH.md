# Presence Mobile Source of Truth

## Canonical ownership
- `presence-mobile/src/` is the canonical reusable mobile client source.
- `presence-test-app/App.tsx` is the canonical product-facing test surface shell.
- Any reusable logic added in `presence-test-app/src/` should be moved back into `presence-mobile/src/` promptly.

## Current rule
- Do not let `presence-test-app/src/` drift into a long-lived fork of `presence-mobile/src/`.
- If the test app needs app-only glue, keep that glue narrow and explicit.
- Shared crypto / health / service / state / deeplink / linkage logic belongs in `presence-mobile/src/`.

## Near-term follow-up
- Reduce remaining duplication between `presence-mobile/src/` and `presence-test-app/src/`.
- Prefer import/re-export or sync tooling over parallel manual edits.
