# WebRTC foundation

`shared/src/webrtc.ts` contains the platform-independent peer connection layer used by the desktop owner and browser viewer. The owner creates exactly two `sendonly` video transceivers in `screen`, then `camera` order. Their negotiated `mid` values are sent in the existing session-scoped offer/answer signaling messages and are the viewer's canonical track identities; SDP is never parsed.

The layer only accepts an injected peer-connection factory and signaling callback. It does not call capture APIs, request consent, or make network requests. Capture code can attach or remove tracks with `replaceTrack`, independently for each kind, without renegotiation. ICE candidates, lifecycle state, close, and authorization/session teardown are handled through the existing signaling session.
