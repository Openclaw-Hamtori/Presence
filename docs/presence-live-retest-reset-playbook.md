# Presence Live Retest / Reset Playbook

Use this when a live retest or integration check fails and you need to reset a linked account without carrying stale assumptions.

## Clean reset procedure (authoritative)

1. **Deploy latest server + SDK code first**
   - Build/package the new code and install that exact artifact on the live runtime.
   - _Do not_ treat a local git push/CI green check as enough by itself.
2. **Restart the live Presence service**
   - Ensure the process serving traffic is fully restarted after deploy.
   - Confirm old process is not still handling requests.
3. **Verify authoritative server truth, not local cache**
   - Query status via server endpoints:
     - `GET /health` (basic runtime signal)
     - `GET /presence/linked-accounts/:accountId/status`
     - (optional) `GET /presence/linked-accounts/:accountId/pending-proof-requests`
   - Treat these responses as truth for whether the account is linked, recovery-pending, or unlinked.
   - Reading local store snapshots, logs from one process, or stale DB views is **insufficient** unless it is the canonical API response above.
4. **Reset explicitly with unlink endpoint**
   - Call:
     - `POST /presence/linked-accounts/:accountId/unlink`
   - This is the operator action that creates a canonical reset point for the account binding.
5. **Re-run the happy path**
   - Relink the account from app flow.
   - Create a fresh proof request.
   - Verify PASS again end-to-end.

## Field-name cheat sheet (authoritative surface first)

When checking status, use these exact fields as the canonical signal:

- `GET /health`:
  - `store.kind`: linkage store category (`file`, `sqlite`, `redis`, etc.)
  - `store.schema`: canonical schema identity for that store
  - `store.path` and `store.surface`: where and how the authoritative store is backed
  - `cleanup.*`: nonce/request sweep config currently active
- `GET /presence/linked-accounts/:accountId/status`:
  - `readiness.state`: authoritative gate state (`ready`, `stale`, `not_ready`, `missing_binding`, `unlinked`, `revoked`, `recovery_pending`)
  - `readiness.stateValidUntil`: snapshot expiry for the current linked state
  - `readiness.accountId`: authoritative account key for server-scoped status
- `GET /presence/audit-events`:
  - `events[].code` + `events[].timestamp` for a timeline check across replays
  - `events[].accountId` to correlate action to account

Use this sheet to distinguish:
- **Authoritative truth**: current values from live API responses
- **Local derived view**: any client-device or stale DB snapshot not returned by the above

---

## Common confusions to avoid

- **Code pushed vs deployed**
  - `git push`, `npm publish`, or passing tests only updates source history.
  - **Deployment means the runtime now serves that code.**
  - Always validate deployed runtime through API calls before retesting.

- **Indirect store inspection vs authoritative API truth**
  - Do not use partial local store inspection as proof that an unlink happened.
  - Use account status endpoints on the running server and compare expected contract state.

- **Unlink/reset vs app-local stale card symptoms**
  - A lingering local card/listing in the app can be stale UI state.
  - App card disappearance alone is not proof of server unlink success.
  - After unlink + restart + relink, wait for authoritative hydration to converge, then confirm state through `GET /presence/linked-accounts/:accountId/status`.

## Rule of thumb

If the live retest still fails after deploy/restart and authoritative status checks, first suspect stale runtime assumptions, then repeat steps 1–5 in full rather than reusing old local/deeplink/request state.
