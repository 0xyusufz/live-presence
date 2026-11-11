# Phase 5: desktop capture and browser viewer

Phase 5 provides locally initiated screen sharing, optional independent camera
sharing, a persistent desktop indicator, and browser playback. It does not
implement viewer share requests, Allow/Deny decisions, chat, tracking,
recording, or any other Phase 6+ behavior.

## Process ownership

- Electron main owns the OS-encrypted device credential, authenticated
  signaling WebSocket, IPC sender validation, display-source picker
  supervision, indicator window, and renderer watchdog.
- The application renderer owns screen/camera tracks and the shared
  `DesktopWebRtcClient`. It immediately calls `getDisplayMedia()` from the
  local Share Screen click handler. Electron enumerates available sources and
  returns only the source the user explicitly selects.
- The shared client remains the only owner of signaling reconnect, peer
  recreation, and ICE recovery. Its `prepareOwnerPeer` callback attaches the
  existing live tracks before creating an offer; ended tracks are rejected and
  are never reacquired automatically.
- The browser viewer uses the shared `ViewerWebRtcClient`. It authenticates
  with the existing HttpOnly browser session cookie, selects a previously
  authorized desktop device, and presents screen and camera by negotiated
  transceiver `mid`. The server validates the existing authorization and
  active-screen state before creating a session.

The application renderer runs under the privileged `app://bundle` secure
origin in development and packaging. Its preload exposes a typed, narrow
bridge; it does not expose Node.js, arbitrary IPC, or the device credential.
The WebSocket bridge accepts only the owner signaling messages required by
Phase 5 and rejects auth, viewer-session creation, answers, and request-decision
messages.

## Capture and supervision

The indicator window is created and loaded before capture is enabled, remains
hidden until a live screen track exists, and stays visible while sharing is
active even if the main UI is minimized. A locally initiated screen request
opens an app-owned source picker; cancel, an unavailable source, or a stale
source resolves as cancellation. Camera capture is a separate local action
available only while screen sharing is active. Camera stop/failure detaches
only the camera; screen-track end stops both tracks and the full session.

Main receives a renderer heartbeat every second. Four seconds without a
heartbeat while capture is pending or active starts cleanup. Main asks the
renderer to stop tracks and close the peer, then waits at most two seconds for
cleanup acknowledgement. On timeout, renderer termination and application exit
are the fail-closed fallback. Indicator creation/display failure, renderer
crash/unresponsiveness, and application shutdown also stop sharing. A relaunch
starts in IDLE and does not restore capture state.

## Sleep/wake

Ordinary viewer disconnect retains the existing 25-second Phase 4 grace.
Sleep continuity is separate: only an already-active sharing session can
receive endpoint-specific, one-use capabilities after the server acknowledges
`prepare_sleep`; the five-minute window starts at that acknowledgement. The
shared client reconnects and resumes the same session using its existing
reconnect lifecycle. Surviving screen/camera tracks are reused and attached
before the new offer. A screen track that ended, an expired/unavailable
capability, or a server restart fails safely; no track is silently reacquired.
The desktop shows the `Connected / Sharing resumed` notification only after
the resumed peer becomes connected. A new viewer request is never
automatically approved.

## Development and packaging

The desktop uses Electron Forge with Vite and React; the viewer uses Vite and
React. The pinned toolchain is Electron 45.2.3, Electron Forge 8.0.1, Vite
8.3.7, React 19.3.1, and TypeScript 7.0.2. Forge's Node requirement sets the
repository minimum to Node `>=22.13.0`. Viewer development binds
`localhost:5173` and proxies existing auth, presence, ICE, and WebSocket paths
to the local Fastify service; the production viewer is expected to share its
origin with the service behind the existing reverse proxy.

Useful checks:

```sh
npm run check
npm exec -- tsx --test shared/src/client.test.ts shared/src/webrtc.test.ts
npm --workspace server test
npm --workspace apps/viewer run build
npm --workspace apps/desktop run package
```

## Remaining platform validation

Windows packaging, screen/camera permissions, and source selection have not
been validated on Windows. OS sleep/wake track survival, production-backend
network interruption, and independent external observation of capture-resource
release after forced renderer termination also remain unverified. These require
the respective target systems or a deployed environment; development builds
and unit tests do not establish those behaviors.
