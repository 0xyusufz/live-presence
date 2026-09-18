# Infrastructure

Phase 4 uses self-hosted coturn as a fallback relay. `docker-compose.yml`
contains only the coturn service; Fastify remains the authenticated signaling
and TURN-credential issuer, and Caddy must terminate HTTPS/WSS separately.

Set `TURN_REALM`, `TURN_SHARED_SECRET`, and `TURN_EXTERNAL_IP` in an ignored
`.env` file before running:

```sh
docker compose --env-file .env -f infra/docker-compose.yml config
docker compose --env-file .env -f infra/docker-compose.yml up -d coturn
```

Open UDP/TCP 3478, TCP 5349, and UDP relay ports 49160-49200 in the VPS
firewall. Never expose the shared secret to either client.

Reserved for the single-VPS Docker Compose deployment using Caddy and coturn. Production deployment configuration is intentionally not part of the initial foundation.
