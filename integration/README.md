# Phase 4 WebRTC integration harness

This harness runs the existing desktop-owner and browser-viewer clients in two
independent Chromium contexts against a real Fastify server. It uses synthetic
canvas video tracks only; it does not call screen or camera capture APIs.

## Setup

Use Node.js 22. Install JavaScript dependencies and Chromium:

```bash
npm install
npx playwright install chromium
```

The harness loads the ignored repository-root `.env` file when present. It
requires these variables:

```text
CLOUDFLARE_TURN_KEY_ID=...
CLOUDFLARE_TURN_API_TOKEN=...
TURN_CREDENTIAL_TTL_SECONDS=86400
```

No values are printed or written to test artifacts. The test provisions
temporary in-memory owner and viewer users through the existing development
login and device-enrollment HTTP flows, then grants the viewer authorization
through the existing authorization service. It does not bypass WebSocket
authentication, device authentication, or viewer authorization.

## Commands

Run all integration scenarios:

```bash
npm run test:webrtc:integration
```

Run only the direct-preferred scenario:

```bash
npm run test:webrtc:integration:direct
```

Run only the forced-relay scenario:

```bash
npm run test:webrtc:integration:relay
```

Run the all-policy relay fallback scenario:

```bash
npm run test:webrtc:integration:fallback
```

Run the server-restart recovery scenario:

```bash
npm run test:webrtc:integration:restart
```

Run the forced-relay failure scenario with an unreachable test endpoint:

```bash
npm run test:webrtc:integration:failure
```

The direct scenario uses `iceTransportPolicy: "all"` and reports whether the
selected candidate pair is direct or relayed. It does not fail when the
network legitimately requires TURN. The relay scenario uses
`iceTransportPolicy: "relay"` on both peers and fails unless a selected relay
candidate pair, connected DTLS transport, and received/rendered synthetic
media are all observed.

The fallback scenario starts both peers with `iceTransportPolicy: "all"`. For
deterministic local testing, the browser harness drops only host and
server-reflexive ICE candidates before signaling them; it does not alter ICE
selection or fabricate statistics. Cloudflare relay candidates remain
available, and the test verifies the real selected relay pair, DTLS, rendered
media, one shared session ID, one peer per side, and cleanup. This controlled
candidate restriction proves all-policy relay selection when direct candidates
are unavailable; it does not simulate a live post-connection network outage or
by itself prove the production credential-refresh restart path. That path is
covered by deterministic shared client tests, while live network failover
validation remains pending.

The restart scenario stops and rebuilds the real Fastify server against the
same temporary SQLite database. This preserves authenticated identities while
discarding the in-memory signaling session, then verifies fresh socket
authentication and a new authorized session. It does not resume synthetic
media tracks after restart.

The failure scenario still fetches ICE configuration through the authenticated
endpoint, then replaces only the browser harness's ICE server list with an
unreachable relay endpoint. Both peers remain relay-only, so direct fallback
is impossible. The production client-side 30-second initial negotiation
timeout must reach `FAILED`, close both peers and signaling resources, and
prevent stale session recovery; the harness's 35-second wait is only a final
safety bound.

The server is created on an ephemeral local port by the test. These are
controlled integration tests against the real Fastify/WebSocket implementation;
they are not unit-test mocks. Cloudflare credentials are sent only to the
existing server-side TURN provider and are never logged by the harness.
