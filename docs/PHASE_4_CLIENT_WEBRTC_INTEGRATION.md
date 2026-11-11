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
revocation, device revocation, and peer failure close the local peer. A
transient control-plane disconnect re-authenticates and lets the viewer create
a new server-authorized session; explicit leave and authorization revocation
cancel recovery.

This client integration intentionally does not implement screen capture,
camera capture, permissions, consent UI, indicator UI, chat, usage tracking,
recording, screenshots, or production deployment. TURN fallback and ICE
recovery are described below. The reserved screen and camera transceivers
remain track-free until a later explicit sender-consent phase.

## TURN and recovery

Fastify calls Cloudflare Realtime TURN's
`generate-ice-servers` endpoint at `GET /webrtc/ice-servers` for an
authenticated browser session or device credential. The server-side
`CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_API_TOKEN` are never sent to
clients, persisted, or logged. Cloudflare returns temporary STUN/TURN
credentials, which are validated before they are returned with `cache-control:
no-store` and `referrer-policy: no-referrer`.

The default credential TTL is 24 hours and is configurable with
`TURN_CREDENTIAL_TTL_SECONDS`. That value is sent to Cloudflare on each
credential-generation request; the server does not cache responses, and the
`expiresAt` metadata returned by the endpoint is informational to callers.
Normal peer connections use `iceTransportPolicy: "all"` so host,
server-reflexive, and Cloudflare relay candidates can be gathered and ICE can
select the best viable pair. A selected direct pair keeps media peer-to-peer;
the presence of relay candidates during gathering does not mean that media
used Cloudflare. The integration harness inspects the selected candidate pair
through WebRTC statistics.

When an established connection enters bounded ICE recovery, the owner obtains
fresh authenticated temporary ICE-server credentials, applies the new
configuration with `setConfiguration()`, and then performs the existing
owner-driven ICE restart. This avoids assuming that `restartIce()` changes ICE
servers and avoids repeated credential requests during healthy connections.
Callers may inject `iceTransportPolicy: "relay"` only for forced-relay
validation. The default STUN server is `stun:stun.l.google.com:19302`;
deployments may override it with comma-separated `STUN_URLS` values.

The existing `infra/docker-compose.yml` coturn service remains a separate
optional self-hosted deployment option. Fastify does not currently generate
coturn HMAC credentials or use that service for the active Cloudflare path.

Control-plane reconnect uses fresh authentication, presence refresh, and
jittered exponential backoff from 1 second to a 30-second cap. The retry
counter resets only after 60 seconds of stable authentication. A viewer
recreates a session only after server-side authorization succeeds; stale
session and request references are not persisted.

After ICE becomes disconnected, the owner waits approximately 8 seconds for
normal recovery. A failed connection may then use at most two owner-offerer
ICE restart offers. The viewer accepts restart offers only after the peer has
entered a failed/disconnected recovery state, and returns a fresh answer.
Restarting ICE does not grant consent or start capture. Server restart or
revocation invalidates in-memory sessions and requires fresh authenticated
control-plane state.

Offer, answer, and ICE-candidate signaling includes a required opaque
`negotiation_id`. The owner creates a new identifier for each peer connection;
the viewer adopts it from the offer and echoes it with its answer and ICE
candidates. ICE restart on the same peer retains that identifier. Receivers
ignore signaling for a different negotiation, preventing delayed messages
from an old peer from being applied after same-session peer replacement. This
is a wire-protocol compatibility change: desktop, viewer, and signaling server
components must be upgraded together. Mixed versions can reject or drop
signaling messages because older clients do not send the required identifier
and newer clients require it.

Initial ICE negotiation is bounded by a 30-second client-side timeout. If the
browser remains in a pending negotiating state without reaching a connected
state, the client reports terminal failure, closes the peer and signaling
resources, and ignores late peer or signaling callbacks. This timeout is
separate from the approximately 8-second disconnected recovery grace period
and does not add an initial retry.

The all-policy fallback scenario starts both peers with
`iceTransportPolicy: "all"` and uses a deterministic harness-only restriction
that drops host and server-reflexive candidates before they are sent through
signaling. Cloudflare relay candidates remain enabled. The test verifies that
the real selected pair is relay/relay, DTLS is connected, synthetic media is
rendered, both peers use one shared authorized session, and cleanup closes the
recovered connection. This is controlled candidate unavailability, not a
post-connection network outage; production credential-refresh and
`setConfiguration()` before ICE restart remain covered by deterministic shared
client tests, and live network failover validation is still pending.

## Live relay validation

Compose syntax validation is not a relay test. A deployment must run a
two-peer browser/Electron integration with `iceTransportPolicy: "relay"` and
the authenticated `/webrtc/ice-servers` response, then verify a gathered
`relay` candidate and a selected relay candidate pair. No reachable coturn
endpoint and deployment secret are available in this repository test
environment, so live relay connectivity remains a release blocker.
