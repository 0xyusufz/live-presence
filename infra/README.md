# Infrastructure

The active application TURN provider is Cloudflare Realtime TURN. Fastify
remains the authenticated signaling and ICE-server proxy, and Caddy must
terminate HTTPS/WSS separately. The coturn Compose service is optional and
separate from the currently active Cloudflare-backed application
configuration; running coturn does not change the provider used by Fastify.

Set `TURN_REALM`, `TURN_SHARED_SECRET`, and `TURN_EXTERNAL_IP` in an ignored
`.env` file before running the optional coturn service. Compose passes these values directly to coturn;
there is no checked-in coturn config containing unresolved secret placeholders:

```sh
docker compose --env-file .env -f infra/docker-compose.yml config
docker compose --env-file .env -f infra/docker-compose.yml up -d coturn
```

Open UDP/TCP 3478, TCP 5349, and UDP relay ports 49160-49200 in the VPS
firewall only when the optional coturn service is deployed. The current
Fastify application does not generate coturn HMAC credentials or route its
active Cloudflare ICE-server requests through coturn. Never expose the shared
secret to either client.

Reserved for the single-VPS Docker Compose deployment using Caddy and the
optional coturn service. Production deployment configuration is intentionally
not part of the initial foundation.
