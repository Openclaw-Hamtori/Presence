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
