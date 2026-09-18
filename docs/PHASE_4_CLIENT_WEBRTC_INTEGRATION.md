# Phase 4 client-side WebRTC integration

This Phase 4 subtask connects the desktop owner and browser viewer to the
existing authenticated `/ws` signaling path through the shared `WebRtcPeer`
abstraction.

The desktop client loads its device credential through the credential-store
boundary, authenticates as the owner, and creates the offer after
`viewer_joined`. The viewer authenticates with its browser session mechanism,
creates an authorized session for the selected device, applies the owner offer,
and sends the answer. ICE remains session-bound and uses the bounded
pre-description queue in `WebRtcPeer`.

Both clients expose `IDLE`, `CONNECTING`, `NEGOTIATING`, `CONNECTED`, `CLOSING`,
`CLOSED`, and `FAILED` lifecycle states. Socket closure, leave, authorization
revocation, device revocation, and peer failure close the local peer. No client
automatically re-authorizes or starts a new session.

This client integration intentionally does not implement screen capture,
camera capture, permissions, consent UI, indicator UI, chat, usage tracking,
recording, screenshots, or production deployment. TURN fallback and ICE
recovery are described below. The reserved screen and camera transceivers
remain track-free until a later explicit sender-consent phase.

## TURN and recovery

Fastify issues ten-minute coturn credentials at `GET /webrtc/ice-servers` for
an authenticated browser session or device credential. The response contains
only ICE-server URLs and ephemeral HMAC credentials; the coturn shared secret
is server-only and is never persisted or logged. Direct ICE remains preferred,
while callers may inject `iceTransportPolicy: "relay"` for forced-relay
validation. `infra/docker-compose.yml` exposes coturn's UDP/TCP 3478, TLS
5349, and bounded 49160-49200 relay range.

An owner peer may perform one bounded ICE restart after terminal ICE failure
using the existing owner-offer signaling path. Restarting ICE does not grant
consent or start capture. Server restart or revocation still invalidates
in-memory sessions and requires fresh authenticated control-plane state.
