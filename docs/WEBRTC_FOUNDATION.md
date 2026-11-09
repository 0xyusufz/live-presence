# WebRTC foundation

`shared/src/webrtc.ts` contains the platform-independent peer connection layer used by the desktop owner and browser viewer. The owner creates exactly two `sendonly` video transceivers in `screen`, then `camera` order. Their negotiated `mid` values are sent in the existing session-scoped offer/answer signaling messages and are the viewer's canonical track identities; SDP is never parsed.

The layer only accepts an injected peer-connection factory and signaling callback. It does not call capture APIs, request consent, or make network requests. Capture code can attach or remove tracks with `replaceTrack`, independently for each kind, without renegotiation. ICE candidates, lifecycle state, close, and authorization/session teardown are handled through the existing signaling session.

## ICE and TURN strategy

Normal clients use `iceTransportPolicy: "all"`. The peer gathers host
candidates, while the configuration includes the configured STUN servers and
temporary Cloudflare TURN servers returned by the authenticated
`GET /webrtc/ice-servers` route. Standard ICE gathers the available candidates
and selects a viable pair; it does not wait for direct failure before
gathering relay candidates. A selected host or server-reflexive pair carries
media directly between peers, while a selected relay pair carries encrypted
DTLS-SRTP media through Cloudflare TURN. The presence of relay candidates
alone does not prove that media used TURN.

The owner refreshes its authenticated device credential and ICE-server
configuration only when bounded ICE recovery begins, applies the new
configuration with `setConfiguration()`, and then performs the existing
owner-driven ICE restart. Healthy connections do not repeatedly fetch TURN
credentials. `iceTransportPolicy: "relay"` is reserved for forced-relay
validation. Self-hosted coturn is an optional separate Compose deployment;
the current Fastify application does not generate its HMAC credentials.
