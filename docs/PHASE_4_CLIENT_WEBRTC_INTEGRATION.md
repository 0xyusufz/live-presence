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

This integration intentionally does not implement screen capture, camera
capture, permissions, consent UI, indicator UI, TURN, chat, usage tracking,
recording, screenshots, or production deployment. The reserved screen and
camera transceivers remain track-free until a later explicit sender-consent
phase.
