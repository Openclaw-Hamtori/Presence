# Presence server routing + environment guide

## Why this matters

Most runtime confusion comes from mixing three URL concerns:

- the path the server receives requests on (`ROUTE_BASE_PATH`)
- the public base you expose to clients (`PUBLIC_BASE_URL`)
- the service-domain trust surface (`PRESENCE_SERVICE_DOMAIN` + `/.well-known/presence.json`)

Keep these separate and you avoid most "mobile got relative URL" / "well-known mismatch" issues.

## 1) `ROUTE_BASE_PATH` = inbound mount path only

`presence-happy-path/app/server.cjs` applies this like:

```js
const requestPath = stripRouteBase(url.pathname, routeBasePath);
```

- It strips the configured prefix before route matching.
- It **does not** rewrite public URLs handed to clients.
- It is useful behind reverse proxies where API is mounted at `/api` or `/svc`.

Example:
- `ROUTE_BASE_PATH=/api`
- Client hits `https://example.com/api/presence/link-sessions`
- Server matches `/presence/link-sessions`

## 2) `PUBLIC_BASE_URL` = client-facing URL base

Used when converting internal paths to absolute URLs:

- link session completion fields
- `POST /presence/link-sessions/:sessionId/complete`
- `GET /presence/link-sessions/:sessionId`
- proof request URLs (`verify`, `status`, `pending`, `unlink`, etc.)

`PUBLIC_BASE_URL` should be the public origin that mobile can actually reach.

If mis-set (eg private host or missing port), mobile may receive bad links even if server routes work.

## 3) `PRESENCE_SERVICE_DOMAIN` = trust domain for mobile URL validation

When set, the reference server exposes:

- `https://{PRESENCE_SERVICE_DOMAIN}/.well-known/presence.json`
- `service_domain` gets appended into rewritten completion URLs when missing

The presence trust contract must return:

```json
{
  "version": "1",
  "service_id": "discord-bot",
  "allowed_url_prefixes": ["https://presence.example.com/presence"]
}
```

Important:
- include a prefix that covers every absolute `nonce_url`, `verify_url`, and `pending` endpoint you send to mobile
- prefix should match public URL space from `PUBLIC_BASE_URL`, not the internal mount path
- mobile rejects non-allowed or private paths before submitting proof

## Recommended defaults for local/dev

- `ROUTE_BASE_PATH=` (empty)
- `PUBLIC_BASE_URL=http://127.0.0.1:8787`
- `PRESENCE_SERVICE_DOMAIN` unset until HTTPS and `.well-known` are available
- `PRESENCE_ALLOW_REPLACEMENT_ON_MISMATCH=true` (server creates a relink recovery session when a verified proof arrives from an unexpected device)
- `PRESENCE_CLEANUP_INTERVAL_SECONDS=300` (5 minutes)

For stricter recovery, set `PRESENCE_ALLOW_REPLACEMENT_ON_MISMATCH=false` in dev or production to require explicit re-auth rather than relink-on-mismatch.

/health now includes a `store` block (in addition to `cleanup`) so operators can identify the authoritative backing surface without guessing:

```json
{
  "store": {
    "kind": "file",
    "schema": "presence-linkage-store-file-json-v1",
    "path": "/path/to/storage/links.json",
    "surface": "path",
    "capabilities": {
      "kind": "file",
      "supportsAtomicMutations": true,
      "supportsCrossProcessLocking": true
    }
  },
  "cleanup": {
    "enabled": true,
    "intervalSeconds": 300,
    "runAtStartup": true
  }
}
```

`/health` on `presence-happy-path/app/server.cjs` reports the above fields.

## Reference implementations

- `presence-happy-path/app/server.cjs`
- `presence-sdk/examples/local-reference-server.js`
- `docs/presence-integration-quickstart.md` (endpoint + trust flow context)
