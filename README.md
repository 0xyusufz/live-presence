# Live Presence

Live Presence is a privacy-first, consent-based application for sharing live screen and camera presence with an approved viewer. The desktop app publishes WebRTC media directly when possible, while the backend provides signaling and the browser viewer displays the approved session.

## Repository structure

- `apps/desktop/` — Electron, TypeScript, and React desktop application for macOS and Windows.
- `apps/viewer/` — browser-based viewer application.
- `server/` — Node.js/Fastify signaling backend.
- `shared/` — shared protocol types and validation.
- `infra/` — Docker, Cloudflare Tunnel, and deployment documentation.
- `docs/` — architecture and project documentation.
- `.github/` — repository automation and Copilot guidance.

The repository implements the application foundation and the current Phase 4/5
authentication, signaling, capture, and WebRTC flows. Local desktop capture is
independent from peer/session recovery: after a network timeout, approved live
screen and camera tracks remain active until explicit Stop or another existing
safety/shutdown condition. A viewer disconnect or recovery timeout does not
grant or reacquire capture permission.

Viewer-access revocation is committed together with device-scoped revocation
records in SQLite. A durable server outbox retries session cleanup after
restart, and each record remains until its owning desktop device acknowledges
it. Unresolved records are never expired or evicted; when the documented
capacity is reached, new grants and session creation are rejected until
acknowledgments free capacity.

## Initial deployment target

The agreed deployment target is:

- the owner's Mac hosts the Electron desktop app and Docker/Fastify backend;
- Cloudflare Tunnel exposes the Fastify API and WebSocket signaling at
  `api.yourdomain.com`;
- Vercel hosts the browser viewer at `app.yourdomain.com`;
- Cloudflare manages DNS;
- Neon PostgreSQL is the persistent database target;
- Cloudflare Realtime TURN is the active WebRTC relay fallback;
- no public VPS, Caddy, router port forwarding, or public home IP exposure;
- database backups are deferred.

This describes the target deployment, not implemented or verified infrastructure.
The checked-out implementation currently uses SQLite. Neon migration does not
import existing SQLite records: users sign in afresh, devices re-enroll, and
permissions are provisioned afresh.

Live Mac/Docker/Tunnel startup and reconnect behavior remains to be implemented
and manually validated. Backend restart does not prove active WebRTC media or
capture recovery. Phase 6 requests, Phase 7 chat, and Phase 8 usage/notice
remain future work.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the agreed boundaries and privacy invariants.
