# Presence SQLite authoritative store design — 2026-03-21

## Goal
Replace blob-style JSON/file persistence with transaction-safe authoritative storage.

## Target entities
- `link_sessions`
  - `id` TEXT PRIMARY KEY
  - `service_id` TEXT NOT NULL
  - `account_id` TEXT NOT NULL
  - `issued_nonce` TEXT NOT NULL
  - `requested_at` INTEGER NOT NULL
  - `expires_at` INTEGER NOT NULL
  - `status` TEXT NOT NULL
  - `completed_at` INTEGER
  - `linked_device_iss` TEXT
  - `relink_of_binding_id` TEXT
  - `recovery_reason` TEXT
  - `completion_json` TEXT
  - `metadata_json` TEXT
- `service_bindings`
  - `binding_id` TEXT PRIMARY KEY
  - `service_id` TEXT NOT NULL
  - `account_id` TEXT NOT NULL
  - `device_iss` TEXT NOT NULL
  - `created_at` INTEGER NOT NULL
  - `updated_at` INTEGER NOT NULL
  - `status` TEXT NOT NULL
  - `last_linked_at` INTEGER NOT NULL
  - `last_verified_at` INTEGER NOT NULL
  - `last_attested_at` INTEGER NOT NULL
  - `last_snapshot_json` TEXT
  - `revoked_at` INTEGER
  - `unlinked_at` INTEGER
  - `reauth_required_at` INTEGER
  - `recovery_started_at` INTEGER
  - `recovery_reason` TEXT
  - `metadata_json` TEXT
  - UNIQUE (`service_id`, `account_id`)
- `linked_devices`
  - `iss` TEXT PRIMARY KEY
  - `platform` TEXT NOT NULL
  - `first_linked_at` INTEGER NOT NULL
  - `last_verified_at` INTEGER NOT NULL
  - `last_attested_at` INTEGER NOT NULL
  - `trust_state` TEXT NOT NULL
  - `revoked_at` INTEGER
  - `recovery_started_at` INTEGER
  - `metadata_json` TEXT
- `audit_events`
  - `event_id` TEXT PRIMARY KEY
  - `occurred_at` INTEGER NOT NULL
  - `type` TEXT NOT NULL
  - `service_id` TEXT
  - `account_id` TEXT
  - `binding_id` TEXT
  - `device_iss` TEXT
  - `reason` TEXT
  - `metadata_json` TEXT

## Transaction rule
One API mutation = one SQLite transaction.
Mandatory paths:
- `createLinkSession`
- `completeLinkSession`
- `verifyLinkedAccount`
- `unlinkAccount`
- `revokeDevice`

## Store interface direction
Add transaction-aware mutation entrypoint to LinkageStore:
- `mutate?(mutator)` as immediate bridge
- long-term SQLite backend should expose single-transaction operations behind LinkageStore methods

## Migration path
1. Keep file store as reference/example only.
2. Add SQLite backend with WAL mode.
3. Build one-shot import from JSON file store.
4. Validate counts: sessions, bindings, devices, audit events.
5. Cut over live only after health + endpoint verification.

## Operational checks after cutover
- `/presence/devices/:deviceIss/bindings` count matches DB rows
- linked account status matches service_bindings rows
- restart preserves all counts
- concurrent complete/verify requests do not lose rows
