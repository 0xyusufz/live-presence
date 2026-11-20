# Live Presence

Live Presence is a privacy-first, consent-based application for sharing live screen and camera presence with an approved viewer. The desktop app publishes WebRTC media directly when possible, while the backend provides signaling and the browser viewer displays the approved session.

## Repository structure

- `apps/desktop/` — Electron, TypeScript, and React desktop application for macOS and Windows.
- `apps/viewer/` — browser-based viewer application.
- `server/` — Node.js/Fastify signaling backend with SQLite/Drizzle persistence.
- `shared/` — shared protocol types and validation.
- `infra/` — Docker Compose, Caddy, and coturn deployment configuration.
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

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the agreed boundaries and privacy invariants.
