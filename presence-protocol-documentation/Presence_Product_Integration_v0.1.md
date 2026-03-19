# Presence Product Integration Reference
### v0.1 — Phase 4 draft

This note defines the **backend-facing integration contract** for turning Presence into a productized account-linking flow.

## 1. Recommended endpoint shape

```text
POST /presence/link-sessions
GET  /presence/link-sessions/:sessionId
POST /presence/link-sessions/:sessionId/complete
POST /presence/linked-accounts/:accountId/verify
POST /presence/linked-accounts/:accountId/unlink
POST /presence/devices/:deviceIss/revoke
GET  /presence/audit-events
```

## 2. Session creation response

```json
{
  "ok": true,
  "session": {
    "id": "plink_ab12cd34",
    "serviceId": "discord-bot",
    "accountId": "user_123",
    "status": "pending",
    "expiresAt": 1741592600
  },
  "completion": {
    "flow": "initial_link",
    "sessionId": "plink_ab12cd34",
    "serviceId": "discord-bot",
    "accountId": "user_123",
    "expiresAt": 1741592600,
    "completion": {
      "method": "deeplink",
      "qrUrl": "presence://link?...&service_domain=presence.example.com",
      "deeplinkUrl": "https://presence.example.com/link?...&service_domain=presence.example.com",
      "fallbackCode": "12CD34"
    },
    "endpoints": {
      "complete": { "method": "POST", "path": "/presence/link-sessions/:sessionId/complete" },
      "status": { "method": "GET", "path": "/presence/link-sessions/:sessionId" }
    }
  }
}
```

The important part is that product teams can render QR/deeplink UX **without guessing where completion happens**.

When a service asks the mobile app to use session-provided sync endpoints (`nonce_url`, `verify_url`), it should also provide `service_domain`. That domain must publish `https://{service_domain}/.well-known/presence.json` with the matching `service_id` and `allowed_url_prefixes` that cover those URLs. The mobile app should fail closed when this trust metadata is missing or mismatched.

### Trust metadata rules that integrators must get right

#### `service_domain`
- must be **host only**
- do **not** include scheme (`https://`), path, query, hash, or userinfo
- examples:
  - `noctu.link` ✅
  - `https://noctu.link` ❌
  - `noctu.link/presence` ❌

#### `allowed_url_prefixes`
- treat each entry as an **absolute URL prefix string**, not a generic homepage URL
- `nonce_url`, `verify_url`, and any other session-provided sync URL must fall under one of these prefixes
- prefix semantics matter: a trailing slash can change boundary matching behavior
- for paths like `https://example.com/presence/linked-accounts/...`, prefer a prefix like `https://example.com/presence`

Recommended minimal metadata:

```json
{
  "version": "1",
  "service_id": "your-service-id",
  "allowed_url_prefixes": [
    "https://example.com/presence"
  ]
}
```

Operational recommendation:
- serve `/.well-known/presence.json` with `Cache-Control: no-store` (especially during rollout/debugging)

## 3. Mobile-linked completion

Recommended web/desktop flow:
1. Backend creates a link session.
2. Backend returns `completion.completion.qrUrl` and/or `completion.completion.deeplinkUrl`.
3. Web/desktop renders QR.
4. Mobile app opens deeplink and extracts `session_id`, `service_id`, optional `service_domain`, optional `binding_id`, `flow`, and `code`.
5. If the deeplink/session includes `nonce_url` or `verify_url`, mobile validates them against `https://{service_domain}/.well-known/presence.json` before approval or later binding sync.
6. Mobile posts the Presence proof to the backend completion endpoint.
7. Backend verifies and returns a standard linked state payload.

## 4. Completion success response

```json
{
  "ok": true,
  "state": "linked",
  "session": { "id": "plink_ab12cd34", "status": "consumed" },
  "binding": {
    "bindingId": "pbind_xy98mn76",
    "serviceId": "discord-bot",
    "accountId": "user_123",
    "deviceIss": "presence:device:abc...",
    "status": "linked"
  },
  "device": {
    "iss": "presence:device:abc...",
    "platform": "ios",
    "trustState": "active"
  }
}
```

## 5. Recovery / relink response

When an already-linked account proves from the wrong device, the backend should respond with a single machine-friendly recovery envelope:

```json
{
  "ok": false,
  "code": "ERR_BINDING_RECOVERY_REQUIRED",
  "message": "binding mismatch: expected presence:device:old, received presence:device:new; relink required",
  "binding": {
    "bindingId": "pbind_xy98mn76",
    "status": "recovery_pending"
  },
  "recovery": {
    "action": "relink",
    "reason": "binding_mismatch",
    "expectedDeviceIss": "presence:device:old",
    "actualDeviceIss": "presence:device:new",
    "relinkSession": {
      "flow": "relink",
      "sessionId": "plink_recover_01",
      "completion": {
        "method": "deeplink",
        "deeplinkUrl": "https://presence.example.com/link?...&service_domain=presence.example.com"
      },
      "endpoints": {
        "complete": {
          "method": "POST",
          "path": "/presence/link-sessions/:sessionId/complete"
        }
      }
    }
  }
}
```

This keeps UI decisions simple:
- `action = reauth` → ask same device to prove again
- `action = relink` → render QR/deeplink or handoff new deeplink immediately
- `action = contact_support` → operator flow

## 6. Admin / audit shape

Recommended admin responses stay read-oriented and boring:

```json
{
  "ok": true,
  "events": [
    {
      "eventId": "paudit_1234",
      "type": "binding_mismatch",
      "serviceId": "discord-bot",
      "accountId": "user_123",
      "bindingId": "pbind_xy98mn76",
      "deviceIss": "presence:device:new",
      "occurredAt": 1741592000,
      "reason": "binding_mismatch"
    }
  ]
}
```

The goal is operator visibility, not a full dashboard in this phase.

## 7. Persistence guidance

For prototyping, filesystem storage is fine.
For multi-instance services, use a persistent/distributed adapter such as Redis or a relational database. Phase 4 includes a Redis-backed reference store shape in `presence-sdk/src/redis.ts`.
