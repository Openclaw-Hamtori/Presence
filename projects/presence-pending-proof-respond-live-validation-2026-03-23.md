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

## Final live validation result
The previously missing real-device happy-path replay was completed successfully later the same day.

Successful live replay details:
- `accountId`: `user_1774092848`
- `bindingId`: `pbind_kbrvgmki`
- `device`: `presence:device:73efbbd49e9dd0812011d4ebcc8ce41d`
- final replay `requestId`: `ppreq_lgct3mkw`

Observed result:
- `POST /presence/pending-proof-requests/:requestId/respond` completed successfully
- request status became `verified`
- linked-account readiness returned `ready: true`
- linked snapshot returned `pass: true`

A second latest-deploy clean retest was then also completed successfully after authoritative unlink → relink → fresh request:
- relink session: `plink_c99d5bdc5edc8e8d`
- fresh request: `ppreq_b41138f5ca96adf4`
- request status became `verified`
- readiness remained `ready: true`
- snapshot remained `pass: true`

## Closeout status (2026-03-23)
- **Phase 2 is fully closed, including final live-device `respond` replay confirmation.**
- Local checks, route-level checks, first real-device replay, and later clean retest on the latest deployed server all succeeded.
- Keep SQLite-first small-team deployment assumptions intact (single-node file/SQLite path remains default baseline).
- For future live retests, follow `docs/presence-live-retest-reset-playbook.md` and use authoritative unlink → relink rather than inferring reset from indirect state inspection.
