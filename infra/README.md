# Infrastructure

The initial deployment target is:

- Fastify in Docker on the owner's Mac.
- Cloudflare Tunnel for `api.yourdomain.com`.
- Vercel for `app.yourdomain.com`.
- Cloudflare DNS for both hostnames.
- Neon PostgreSQL as persistent application storage.
- Cloudflare Realtime TURN as the active relay fallback.

The Cloudflare Tunnel carries API and WebSocket control-plane traffic only.
It does not carry or terminate screen/camera media.

No public VPS, Caddy, router port forwarding, public home IP, or coturn service
is required for the initial deployment. Coturn remains optional and separate.

## Database credentials

Use separate credentials:

- `NEON_RUNTIME_DATABASE_URL` — pooled Neon runtime connection for Fastify.
- `NEON_MIGRATION_DATABASE_URL` — direct/migration-compatible Neon connection for migrations.

Docker secrets/environment injection must expose:

- migration credentials only to the migration job;
- runtime credentials only to the Fastify container;
- no migration credentials to the runtime container or access CLI.

The access CLI uses the runtime role and the minimum grant/revoke privileges.
It must not receive migration credentials or DDL privileges.

## Migration execution

Migrations run before Fastify startup. Startup verifies migration status and
required schema objects. It must fail instead of silently creating or changing
the production schema.

The migration creates no backup implementation. Backups remain deferred.

## Tunnel routing

The proposed route is:

```text
api.yourdomain.com -> http://backend:3000
```

The backend listener should remain private inside Docker. Docker startup,
Tunnel startup, Mac sleep/wake, and client reconnect behavior require
implementation and manual validation.

## Verification status

These deployment components are proposed, not verified by the current
repository:

- Docker Desktop/Tunnel startup after Mac login or sleep/wake;
- public health and WebSocket routing;
- Neon runtime/migration connectivity;
- backend restart and viewer reconnection;
- active media recovery after laptop/backend interruption.
