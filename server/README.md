# Server administration

## Manage viewer authorization

Run these commands from the repository root. They use the server's normal
configuration, including `DATABASE_PATH` from `../.env` when present; otherwise
the default is `./data/live-presence.db`. Relative database paths are resolved
from the `server/` workspace directory by both the backend and these commands,
regardless of the caller's working directory.

Grant an existing viewer access to an existing owner:

```sh
npm --workspace server run access:grant -- \
  --owner-email owner@example.com \
  --viewer-email viewer@example.com
```

Revoke that authorization:

```sh
npm --workspace server run access:revoke -- \
  --owner-email owner@example.com \
  --viewer-email viewer@example.com
```

Both email addresses must belong to existing accounts. An account cannot
authorize itself. Granting an already-active authorization reports an error;
revoke is safe to repeat. The command delegates permission changes to the
existing `ViewerAuthorizationService` and closes its database connection before
exiting. It does not print credentials or session data.

## Network recovery

`NETWORK_RECOVERY_GRACE_MS` sets how long an interrupted owner or viewer
session remains recoverable before the server ends it. The default is 180000 ms;
clients use the same default through `ReconnectOptions.recoveryTimeoutMs`.
Keep the server grace and client recovery deadline aligned when configuring
either value.
