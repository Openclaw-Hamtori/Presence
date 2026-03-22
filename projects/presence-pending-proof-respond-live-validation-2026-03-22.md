# Presence pending-proof respond path — live validation evidence (2026-03-22)

Goal for this follow-up:
- validate the live `POST /presence/pending-proof-requests/:requestId/respond` path exists and behaves correctly, and add durable evidence.

Environment:
- Host: `noctu`
- Base URL: `https://noctu.link/presence-demo/presence`

## Evidence captured (live)

```bash
curl -sS https://noctu.link/presence-demo/health
```

```json
{
  "ok": true,
  "serviceId": "presence-happy-path",
  "serviceDomain": "noctu.link",
  "storePath": "/home/openclaw/presence-happy-path/app/var/presence/presence-linkage-store.json",
  "iosAppIdSource": "default"
}
```

Create on unknown account:

```bash
curl -sS -X POST https://noctu.link/presence-demo/presence/linked-accounts/nonexistent/pending-proof-requests
```

```json
HTTP/2 404 ...
{
  "ok": false,
  "code": "ERR_BINDING_NOT_FOUND",
  "message": "no_linked_binding",
  "state": "missing_binding"
}
```

List on unknown account:

```bash
curl -sS https://noctu.link/presence-demo/presence/linked-accounts/nonexistent/pending-proof-requests
```

```json
HTTP/2 200 ...
{
  "ok": true,
  "proofRequests": []
}
```

Get unknown pending proof request:

```bash
curl -sS https://noctu.link/presence-demo/presence/pending-proof-requests/ppreq_missing
```

```json
HTTP/2 404 ...
{
  "ok": false,
  "code": "ERR_PENDING_PROOF_REQUEST_NOT_FOUND"
}
```

Respond unknown pending proof request:

```bash
curl -sS -H 'content-type: application/json' --data '{"nonce":"abc","proof":{"foo":"bar"},"device":{"iss":"presence:device:0000000000000000000000000000000000","attestation":{},"signature":"x","iat":0}}' \
  https://noctu.link/presence-demo/presence/pending-proof-requests/ppreq_missing/respond
```

```json
HTTP/2 400 ...
{
  "ok": false,
  "code": "ERR_INVALID_FORMAT",
  "message": "unknown pending proof request"
}
```

## Interpretation
- Route is live and reachable for all three pending-proof endpoints (`create`, `list`, `get`, `respond`).
- The server returns coherent, non-500 error handling for missing/invalid requests.

## Remaining evidence gap
- Real-device `POST /presence/pending-proof-requests/:requestId/respond` completion has not been performed in this pass because no known linked account / active request id was available for safe replay. This remains follow-up action.
