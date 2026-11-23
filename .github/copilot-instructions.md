# Repository development rules

- Preserve the privacy-first, consent-based architecture in `docs/ARCHITECTURE.md`.
- Never start screen or camera capture from a network request, signaling message, or viewer action; only an explicit local consent action may start capture.
- Treat screen and camera as independent WebRTC tracks/transceivers and preserve independent consent and lifecycle state.
- Phase 6 viewer requests require explicit desktop approval. Previously approved sharing may resume after sleep/wake only according to implemented behavior and must show `Connected / Sharing resumed` after actual recovery.
- Phase 7 chat is future scope and must remain transient and unpersisted.
- Phase 8 usage/notice behavior is future scope and must remain device-local.
- The backend handles signaling and metadata only. It must never terminate, store, inspect, or proxy screen/camera media.
- Keep changes within the monorepo boundaries: desktop, viewer, server, shared protocol, infrastructure, and docs.
- Do not introduce Redis, queues, Kubernetes, microservices, SFU, multi-region deployment, recording, screenshots, remote control, chat, or surveillance analytics for the MVP.
- Do not add media storage, chat history, viewing history, share-session history, activity history, or database backups.
- PostgreSQL migration work must preserve all nine tables, constraints, revocation tombstones, outbox behavior, and the exact 10,000 capacity invariant.
- Migration credentials must never be available to the runtime Fastify container or access CLI.
- Prefer small TypeScript modules, strict typing, explicit validation, and existing workspace conventions. Avoid dependencies unless they are required by the approved architecture.
- Add or update focused tests and documentation for behavior changes. Do not commit secrets or local environment files.
