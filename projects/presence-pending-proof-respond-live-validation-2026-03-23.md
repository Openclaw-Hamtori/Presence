# Presence pending-proof respond path — real-device happy-path revalidation attempt (2026-03-23)

## Goal for this pass
- Re-validate live real-device happy-path for:
  `POST /presence/pending-proof-requests/:requestId/respond`
- Preserve pushless canonical flow and small-team SQLite/JSON-friendly baseline.

## What I validated in this pass
- Presence SDK integration tests still pass, including the local pending-proof happy-path.
  - `npm test -w presence-sdk`
  - includes `localReferenceRoundtrip` pending-proof create/list/status/respond and final `verify` assertions.
- Live route health and route mapping remain reachable:
  - `https://noctu.link/presence-demo/health`
  - `POST /presence/linked-accounts/nonexistent/pending-proof-requests`
  - `GET /presence/linked-accounts/nonexistent/pending-proof-requests`
  - `GET /presence/pending-proof-requests/ppreq_missing`
  - `POST /presence/pending-proof-requests/ppreq_missing/respond`

Representative 2026-03-23 outputs captured:

```bash
curl -sS https://noctu.link/presence-demo/health
{
  "ok": true,
  "serviceId": "presence-happy-path",
  "serviceDomain": "noctu.link",
  "storePath": "/home/openclaw/presence-happy-path/app/var/presence/presence-linkage-store.json",
  "iosAppIdSource": "default"
}

curl -sS -X POST https://noctu.link/presence-demo/presence/linked-accounts/nonexistent/pending-proof-requests
# => 404 + ERR_BINDING_NOT_FOUND (expected)

curl -sS https://noctu.link/presence-demo/presence/linked-accounts/nonexistent/pending-proof-requests
# => 200 + {"proofRequests": []}

curl -sS https://noctu.link/presence-demo/presence/pending-proof-requests/ppreq_missing
# => 404 + ERR_PENDING_PROOF_REQUEST_NOT_FOUND

curl -sS -H 'content-type: application/json' --data '{"nonce":"abc","proof":{"foo":"bar"},"device":{"iss":"presence:device:0000000000000000000000000000000000","attestation":{},"signature":"x","iat":0}}' \
  https://noctu.link/presence-demo/presence/pending-proof-requests/ppreq_missing/respond
# => 400 + ERR_INVALID_FORMAT
```

## Why true happy-path could not be completed yet
- I could not discover a known `(accountId, requestId)` pair in this environment.
- I also could not read live server store files over SSH (permission denied for `/home/openclaw/presence-happy-path/app/var/presence/*` from this runner), so no safe linked account/request extraction was possible.
- Because of that, single-session real-device `/respond` replay with real attested proof could not be executed from this pass.

## Exact handoff for human-run replay
Use this once a linked device/account is available:

1. On a linked phone, get it into pending-proof action UI and capture:
   - `requestId` (from server-side pending request ID)
   - proof request payload fields (`nonce`, `requestId`)
2. Run:

```bash
REQ_ID=<captured-request-id>
BASE=https://noctu.link/presence-demo/presence

curl -sS ${BASE}/pending-proof-requests/${REQ_ID}
# expect: 200 + status "pending"

curl -sS -X POST ${BASE}/pending-proof-requests/${REQ_ID}/respond \
  -H 'content-type: application/json' \
  --data '<full-request-body-from-device-log-or-app-net-log>'
# expect: 200 + { ok: true, state: "linked", request.status: "verified" }

curl -sS ${BASE}/pending-proof-requests/${REQ_ID}
# expect: 404 OR status != "pending" (ideally "verified" with completedAt)

curl -sS /presence-demo/presence/linked-accounts/<accountId>/status
# expect: readiness reflects linked and lastVerifiedAt/stateValidUntil advances
```

3. Report back the successful/failed payloads (request/response JSON + timestamp) so this validation can be closed as fully confirmed.

## Closeout status (2026-03-23)
- **Phase 2 is now closed except for this final live-device `respond` replay.**
- Local/route-level checks are complete; the only explicit blocker is real-device proof replay confirmation against a linked `(accountId, requestId)` pair on live server.
- Keep SQLite-first small-team deployment assumptions intact (single-node file/SQLite path remains default baseline).
