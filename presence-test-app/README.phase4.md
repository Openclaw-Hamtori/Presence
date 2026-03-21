# Presence Test App — Phase 4 notes

Use the test app as a mobile PASS/proof client for initial linking and later proof-on-demand requests.

Suggested manual flow:
1. Backend calls `POST /presence/link-sessions`.
2. Desktop renders `session.completion.qrUrl` or opens `session.completion.deeplinkUrl`.
3. Mobile opens the deeplink / QR and loads the request envelope (`session_id`, `service_id`, optional `service_domain`, optional `binding_id`, `flow`, fallback `code`).
4. For `initial_link`, the demo does **not** pre-create a binding hint; the binding is created after backend completion.
5. The test app produces a Presence transport payload with `link_context.completion` copied from the opened request metadata.
6. Backend posts the payload to the session-specific completion API (`session.completion.completionApiUrl`) or the equivalent endpoint surfaced in the SDK response helper.
7. If mismatch happens on a previously linked account, the backend returns `ERR_BINDING_RECOVERY_REQUIRED` plus `recovery.relinkSession` with the same session-derived completion metadata.
8. Ordinary failed measurements are not sent upstream as a separate `not_ready` event; linked-service readiness should degrade from the last successful PASS snapshot.

This app supports QR scanning and deeplink/manual link entry as reference UX, but it is still a proof/reference client rather than a full product mobile app.

If session metadata includes `nonce_url` / `verify_url`, the app validates them against
`https://{service_domain}/.well-known/presence.json` and refuses to proceed if the service
metadata does not match the requested service or URL scope.
