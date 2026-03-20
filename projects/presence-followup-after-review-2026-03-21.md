# Presence follow-up after cross-review — 2026-03-21

## Why this exists
A parallel review found that some previously claimed fixes were directionally right but not fully reflected in code. This note records the follow-up corrections that were applied afterward.

## Review findings that required correction
1. Authoritative binding write-back had been described in docs, but App.tsx had not actually persisted recovered bindings into local state.
2. `presence-sdk/examples/local-reference-server.js` exposed `deviceBindingsPath` in the contract but did not actually implement the route, and the file tail had corruption.
3. `backend-completion-reference.ts` handler/contract consistency still needed a final endpoint-contract update.
4. Some UI paths (`connectionStatus`, `journeySteps`) still used local-only bindings instead of `effectiveServiceBindings`.

## Corrections applied

### A. App authoritative write-back now actually happens
In `presence-test-app/App.tsx`, after successful hydration from:
- `GET /presence/devices/:deviceIss/bindings`, or
- audit fallback (`audit-events + linked-account status`)

the app now:
- loads persisted local state
- verifies device match with `persisted.linkedDevice.iss === deviceIss`
- merges recovered bindings via `mergeAuthoritativeServiceBindings(...)`
- saves the merged state back to storage

### B. UI now uses effective bindings more consistently
These paths were switched from local-only bindings to merged/effective bindings:
- `connectionStatus`
- `journeySteps`

### C. Backend example contract completed
`presence-sdk/examples/backend-completion-reference.ts`
- now includes `deviceBindingsPath: "/presence/devices/:deviceIss/bindings"`

### D. Local reference server fixed
`presence-sdk/examples/local-reference-server.js`
- now implements `GET /presence/devices/:deviceIss/bindings`
- duplicated/corrupted trailing block was trimmed
- file syntax check passes

## Validation run
After the follow-up corrections:
- `presence-test-app`: `npm run type-check` ✅
- `presence-sdk`: `npm test -- --runInBand` ✅
- `examples/local-reference-server.js`: `node --check` ✅

## Outcome
The earlier cross-review was correct to flag a mismatch between the intended architecture and the actual code. Those review findings have now been concretely reflected into code and revalidated.
