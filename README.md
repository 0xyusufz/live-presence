# Live Presence

Live Presence is a privacy-first, consent-based application for sharing live screen and camera presence with an approved viewer. The desktop app publishes WebRTC media directly when possible, while the backend provides signaling and the browser viewer displays the approved session.

## Repository structure

- `apps/desktop/` — Electron, TypeScript, and React desktop application for macOS and Windows.
- `apps/viewer/` — browser-based viewer application.
- `server/` — Node.js/Fastify signaling backend and future SQLite/Drizzle persistence.
- `shared/` — shared protocol types and validation.
- `infra/` — Docker Compose, Caddy, and coturn deployment configuration.
- `docs/` — architecture and project documentation.
- `.github/` — repository automation and Copilot guidance.

The initial repository contains configuration only. Authentication, media capture, WebRTC signaling, TURN, and deployment are intentionally left for later milestones.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the agreed boundaries and privacy invariants.
