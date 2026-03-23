# Presence

Presence is a small, server-first PASS/attestation verification stack with a split architecture:

- `presence-verifier` validates Presence proofs
- `presence-sdk` builds service-ready backend APIs and binding state
- `presence-happy-path` provides a reference backend implementation
- `presence-mobile` + `presence-test-app` provide client-side flow references

The repo is currently tuned for a **public npm release + self-hosted reference server** model.

---

## Quick orientation

- Public spec + API docs: `docs/README.md`
- Canonical integration path: `docs/presence-integration-quickstart.md`
- Endpoint contract and trust flow: `docs/presence-public-architecture.md`
- Reference server routing + env knobs: `docs/presence-server-routing-guide.md`
- Canonical backend flow reference: `docs/presence-pending-proof-request-architecture.md`
- Production/deployment runbook: `docs/presence-production-runbook.md`
- Historical release notes/checks (archived, non-canonical): `docs/archive/release-notes/README.md`

Current platform scope: **iOS-first** for client runtime.

Package docs:
- `presence-verifier/README.md`
- `presence-sdk/README.md`
- `presence-mobile/README.md` (iOS-native reference client)
- `presence-test-app/README.md` (integration test surface)

---

## Install core packages

For service/backend integration:

```bash
npm install presence-sdk presence-verifier
```

The two packages are versioned independently but intended to be used together in the canonical split:
- `presence-verifier` validates proofs
- `presence-sdk` handles linkage, nonces, and server-side readiness decisions

---

## Repository packages & runnable examples

- `presence-verifier/`: proof verification library
- `presence-sdk/`: service integration primitives, stores, route helpers
- `presence-happy-path/app/server.cjs`: reference backend server
- `presence-sdk/examples/local-reference-server.js`: minimal reference server harness
- `presence-mobile/`: mobile semantics docs + app wrapper
- `presence-test-app/`: local integration/test app

Run the reference server from repo:

```bash
cd presence-sdk
npm run serve:reference
```

Run full local checks:

```bash
npm run ci:phase1
npm run check:server-auth
```

---

## Security posture for reference servers

The reference/backend examples favor developer ergonomics and therefore are **not hardened by default**.

- Callback endpoints (`/presence/link-sessions/:sessionId/complete`, `/presence/linked-accounts/:accountId/verify`, `/presence/pending-proof-requests/:requestId/respond`) remain public by design for mobile flow.
- Service-owned operations are only enforced by API key when:
  - `PRESENCE_REFERENCE_AUTH_MODE=strict`
  - `PRESENCE_SERVICE_API_KEY` is set

For demo/local default, set:

```bash
PRESENCE_REFERENCE_AUTH_MODE=demo
```

For hardened reference deployment, set:

```bash
PRESENCE_REFERENCE_AUTH_MODE=strict
PRESENCE_SERVICE_API_KEY=very-long-random-secret
```

---

## Requirements

Both published packages declare Node.js `>=18` in package `engines`.

If you are publishing from this repo:
- `npm run build` in `presence-verifier`
- `npm run build` in `presence-sdk`
- `npm pack` or `npm publish` now include `prepack` checks that ensure non-empty `dist` artifacts exist

---

## License

MIT
