# PostgreSQL migration reference

## Status

- **Current verified behavior:** the checked-out repository uses SQLite
  with better-sqlite3 and Drizzle.
- **Agreed migration requirement:** PostgreSQL/Neon replaces persistent
  storage after implementation and clean-Neon migration is approved.
- **Not yet implemented:** PostgreSQL migrations, Neon deployment, and
  PostgreSQL concurrency integration tests.

No SQLite records are imported. Users sign in again, devices re-enroll,
and viewer permissions are provisioned again.

## Migration scope

The migration changes persistent database implementation and deployment
configuration only. It does not change capture consent, Electron IPC,
renderer/watchdog behavior, signaling protocol, WebRTC tracks, or sleep/wake
capture rules.

Backups are deferred. No chat history, viewing history, media storage,
share-session history, or activity history is added.

## Deployment

- Fastify runs in Docker on the owner's Mac.
- Cloudflare Tunnel exposes `api.yourdomain.com`.
- Vercel hosts the viewer at `app.yourdomain.com`.
- Neon PostgreSQL stores persistent application state.
- Cloudflare Realtime TURN remains the active fallback provider.
- Caddy, VPS hosting, public home-IP exposure, and router forwarding are not
  part of the initial target.

## Database roles and secrets

`NEON_RUNTIME_DATABASE_URL`

- pooled runtime endpoint;
- runtime-only secret;
- DML privileges;
- no DDL privileges;
- never supplied to migration jobs.

`NEON_MIGRATION_DATABASE_URL`

- direct/migration-compatible endpoint;
- migration-only secret;
- DDL privileges;
- never supplied to Fastify, the access CLI, Vercel, or Electron.

Docker secret handling must expose each value only to the matching migration
or runtime container. Never place credentials in source, package manifests,
public environment files, images, or client applications.

The access CLI uses the runtime role and minimum grant/revoke privileges.
It does not receive migration credentials or DDL privileges.

## Nine-table PostgreSQL schema

See `docs/ARCHITECTURE.md` §8 for the exact tables and constraints.

The migration preserves:

- users;
- auth_tokens;
- sessions;
- devices;
- device_credentials;
- viewer_permissions;
- presence_authorization_bindings;
- presence_revocation_tombstones;
- presence_revocation_outbox.

Epoch-millisecond values use PostgreSQL `BIGINT`.

node-postgres returns BIGINT values as strings. The application parser validates
the complete string and converts only safe integers to JavaScript numbers.

## Capacity invariant

```text
presence_authorization_bindings + presence_revocation_tombstones <= 10000
```

`viewer_permissions` is excluded.

- At 9,999, permission inserts and re-grants may succeed.
- At 10,000, permission inserts and re-grants reject.
- At 9,999, binding insertion may consume the final slot.
- At 10,000, binding insertion rejects.
- Revocation replaces a binding with a tombstone and succeeds at 10,000.
- Outbox processing changes only `processed_at` and does not change capacity.

Every capacity-changing transaction uses `READ COMMITTED` and
`pg_advisory_xact_lock(726149, 10000)` before counting or mutation.

The trigger function is:

```sql
CREATE OR REPLACE FUNCTION live_presence_capacity_gate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_count bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(726149, 10000);
  SELECT
    (SELECT COUNT(*) FROM presence_authorization_bindings)
    + (SELECT COUNT(*) FROM presence_revocation_tombstones)
  INTO current_count;
  IF current_count >= 10000 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'PRESENCE_REVOCATION_CAPACITY_EXHAUSTED';
  END IF;
  RETURN NEW;
END;
$$;
```

Preserve these three trigger conditions:

```sql
CREATE TRIGGER presence_authorization_bindings_capacity
BEFORE INSERT ON presence_authorization_bindings
FOR EACH ROW
EXECUTE FUNCTION live_presence_capacity_gate();

CREATE TRIGGER viewer_permissions_capacity_insert
BEFORE INSERT ON viewer_permissions
FOR EACH ROW
WHEN (NEW.revoked_at IS NULL)
EXECUTE FUNCTION live_presence_capacity_gate();

CREATE TRIGGER viewer_permissions_capacity_regrant
BEFORE UPDATE OF revoked_at ON viewer_permissions
FOR EACH ROW
WHEN (
  OLD.revoked_at IS NOT NULL
  AND NEW.revoked_at IS NULL
)
EXECUTE FUNCTION live_presence_capacity_gate();
```

No binding update trigger is introduced.

## Capacity error mapping

**Current SQLite behavior:** the capacity triggers abort with the message
`PRESENCE_REVOCATION_CAPACITY_EXHAUSTED`. This is a database-trigger sentinel,
not an application error code. `ViewerAuthorizationService.grant()` detects
the sentinel by message and throws `AuthorizationError` with this
human-readable message:

```text
Presence revocation capacity is full; acknowledge pending revocations or reduce active authorized relationships before granting access
```

The access CLI prints
`Live Presence access command failed: <message>` and exits unsuccessfully.
The WebSocket session-binding path does not convert the raw capacity sentinel:
`AuthorizationError` maps to `NOT_AUTHORIZED`, the raw capacity sentinel
maps to the existing `PRESENCE_CAPACITY_EXHAUSTED` protocol code, and
unexpected errors map to `SERVER_ERROR`. `AuthorizationError` has no
dedicated code property. Do not treat
`PRESENCE_REVOCATION_CAPACITY_EXHAUSTED` as an application or protocol code.

**PostgreSQL target:** the trigger raises SQLSTATE `P0001` with the same
sentinel message. Because the pinned Drizzle node-postgres adapter wraps driver
errors in `DrizzleQueryError` with the original driver error on `.cause`,
capacity detection must inspect the cause chain and match both SQLSTATE
`P0001` and the sentinel message. Verify this behavior against the pinned
Drizzle version during implementation.

Preserve the existing distinct behavior: permission grant/re-grant converts
the capacity exception to the same human-readable `AuthorizationError`;
session binding preserves the capacity signal so the WebSocket handler emits
`PRESENCE_CAPACITY_EXHAUSTED`; the CLI prints the authorization message and
exits unsuccessfully; and non-capacity database errors propagate to the
existing unexpected-error handling. Do not introduce a new API error code.

## Revocation

Revocation:

1. acquires the shared advisory lock;
2. revokes the permission;
3. deletes matching bindings using `DELETE ... RETURNING`;
4. inserts tombstones;
5. inserts corresponding outbox records;
6. commits atomically.

Unexpected conflicts or database failures roll back the complete transaction.
Revocation does not apply an admission check before deleting a binding.

## Startup reconciliation

Startup reconciliation identifies active bindings whose viewer permission is
revoked. It:

1. acquires the shared advisory lock;
2. includes `p.revoked_at` as the expected tombstone/outbox `created_at`;
3. verifies existing tombstone identity and timestamp;
4. creates missing tombstones;
5. deletes exactly matching revoked bindings;
6. verifies existing outbox identity/timestamp;
7. creates missing pending outbox records;
8. preserves existing `processed_at`;
9. commits atomically.

These PostgreSQL operations are intentionally stricter than the current
SQLite implementation, which uses `INSERT OR IGNORE` /
`onConflictDoNothing()` and does not verify affected-row counts. Each binding
deletion must affect exactly one row. Existing tombstone and outbox records
must be read back and compared; `ON CONFLICT DO NOTHING` must not conceal an
identity or timestamp mismatch. Any unexpected row count, mismatch, or
mutation failure rolls back the complete transaction.

Identity or timestamp mismatch fails reconciliation and rolls back.
Repeated reconciliation is idempotent.

The outbox worker retries every second in batches of at most 100, ordered by
oldest `created_at` and then `session_id`. It marks an operation processed
after cleanup. Tombstones remain until the matching authenticated owner
device acknowledges them.

## Device refresh-token concurrency

A PostgreSQL refresh runs in one `READ COMMITTED` transaction:

1. Lock the matching credential and device rows using
   `SELECT ... FOR UPDATE`.
2. Conditionally revoke the current credential with
   `UPDATE ... WHERE id = $1 AND revoked_at IS NULL RETURNING id` and require
   exactly one returned row.
3. Insert the replacement credential in the same token family.
4. Update the device's `last_seen_at`.
5. Commit before returning the replacement token.

If the presented credential is already retired, or the conditional revoke
does not return exactly one row, revoke the entire token family in a
transaction and commit that revocation before returning the authentication
failure. A failed family-revocation transaction must propagate; it must not be
swallowed, and no external callback may run before commit.

This preserves the existing reuse-detection behavior: a replacement token
already returned by the winning concurrent request may become invalid
immediately if a concurrent reuse request subsequently revokes the whole
family. This is intentional security behavior. Database failures propagate.

Required concurrency tests must prove that concurrent refreshes of one
credential produce at most one replacement, the losing/reuse request revokes
the family, the winner's replacement is then rejected, and a failed family
revocation propagates.

## PostgreSQL migration startup

The migration job runs before Fastify startup.

Fastify verifies migration status and required schema objects. Missing or
inconsistent schema prevents runtime startup.

The runtime uses `NEON_RUNTIME_DATABASE_URL` with DML-only privileges.
The migration job uses `NEON_MIGRATION_DATABASE_URL` with DDL privileges.
Migration credentials never reach Fastify or access CLI processes.

## Required tests

- exact nine-table schema parity;
- exact index and foreign-key parity;
- BIGINT parser and overflow behavior;
- 9,999 permission-only grants;
- permission insert/re-grant rejection at 10,000;
- binding insertion from 9,999;
- exactly one concurrent binding admission succeeds;
- binding rejection at 10,000;
- binding-to-tombstone revocation at 10,000;
- outbox processing with unchanged capacity;
- startup reconciliation idempotency;
- reconciliation mismatch rollback;
- reconciliation concurrency;
- refresh-token reuse concurrency;
- revocation atomic rollback;
- outbox retry and restart behavior.

## Feature preservation

The migration does not change:

- magic-link auth;
- login/session lifecycle;
- device enrollment;
- refresh-token rotation;
- refresh reuse detection;
- viewer authorization;
- presence;
- signaling;
- capture consent;
- IPC;
- screen/camera tracks;
- indicator/watchdog;
- sleep/wake rules;
- crash/relaunch reset.

Live Mac/Docker/Tunnel, live Cloudflare TURN, live media recovery, and platform
testing remain pending manual validation.
