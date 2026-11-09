import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DesktopWebRtcClient,
  INITIAL_NEGOTIATION_TIMEOUT_MS,
  ViewerWebRtcClient,
  type SignalingSocket,
  type ClientScheduler,
} from "./client.js";
import { parseServerMessage } from "./protocol.js";
import type { WebRtcPeerConnection, WebRtcTransceiver } from "./webrtc.js";

class MockConnection implements WebRtcPeerConnection {
  transceivers: WebRtcTransceiver[] = [];
  connectionState = "new";
  iceConnectionState = "new";
  onicecandidate: ((event: { candidate: unknown | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontrack: ((event: { track: { kind?: string } }) => void) | null = null;
  closed = false;
  local: unknown;
  remote: unknown;
  offerCalls = 0;
  failOfferCount = 0;
  configurations: unknown[] = [];

  addTransceiver(_kind: string, init: { direction: "sendonly" | "recvonly" }): WebRtcTransceiver {
    const mid = String(this.transceivers.length);
    const transceiver: WebRtcTransceiver = {
      mid,
      direction: init.direction,
      sender: { replaceTrack: async () => undefined },
    };
    this.transceivers.push(transceiver);
    return transceiver;
  }

  setConfiguration(configuration: unknown): void { this.configurations.push(configuration); }

  async createOffer() {
    this.offerCalls += 1;
    if (this.failOfferCount > 0) {
      this.failOfferCount -= 1;
      throw new Error("offer failed");
    }
    return { type: "offer" as const, sdp: "owner-offer" };
  }
  async createAnswer() { return { type: "answer" as const, sdp: "viewer-answer" }; }
  async setLocalDescription(value: unknown) { this.local = value; }
  async setRemoteDescription(value: unknown) { this.remote = value; }
  async addIceCandidate() {}
  close() { this.closed = true; }
}

class MockSocket implements SignalingSocket {
  readyState = 0;
  peer: MockSocket | undefined;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

class ManualScheduler implements ClientScheduler {
  nowValue = 0;
  nextId = 0;
  timers = new Map<number, { callback: () => void; delay: number }>();
  now = () => this.nowValue;
  random = () => 1;
  setTimeout = (callback: () => void, delay: number) => {
    const id = this.nextId++;
    this.timers.set(id, { callback, delay });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  clearTimeout = (timer: ReturnType<typeof setTimeout>) => {
    this.timers.delete(timer as unknown as number);
  };
  runNext(): number {
    const [id, timer] = [...this.timers.entries()].sort((left, right) => left[1].delay - right[1].delay)[0] as [
      number,
      { callback: () => void; delay: number },
    ];
    this.timers.delete(id);
    timer.callback();
    return timer.delay;
  }
}

test("desktop and viewer clients negotiate through the existing signaling messages", async () => {
  const ownerSocket = new MockSocket();
  const viewerSocket = new MockSocket();
  ownerSocket.peer = viewerSocket;
  viewerSocket.peer = ownerSocket;
  let ownerConnection: MockConnection | undefined;
  let viewerConnection: MockConnection | undefined;

  const owner = new DesktopWebRtcClient({
    socketFactory: () => ownerSocket,
    peerFactory: () => {
      ownerConnection = new MockConnection();
      return ownerConnection;
    },
    loadRefreshCredential: async () => "device-refresh-token",
  });
  const viewer = new ViewerWebRtcClient({
    socketFactory: () => viewerSocket,
    peerFactory: () => {
      viewerConnection = new MockConnection();
      return viewerConnection;
    },
    browserSessionToken: "browser-session-token",
    deviceId: "00000000-0000-0000-0000-000000000001",
  });

  await owner.start();
  viewer.start();
  ownerSocket.open();
  viewerSocket.open();

  viewerSocket.onmessage?.({
    data: JSON.stringify({
      type: "authenticated",
      role: "viewer",
    }),
  });
  ownerSocket.onmessage?.({
    data: JSON.stringify({
      type: "authenticated",
      role: "owner",
      device_id: "00000000-0000-0000-0000-000000000001",
    }),
  });
  viewerSocket.onmessage?.({
    data: JSON.stringify({
      type: "session_created",
      session_id: "00000000-0000-0000-0000-000000000002",
      device_id: "00000000-0000-0000-0000-000000000001",
    }),
  });
  ownerSocket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_joined",
      session_id: "00000000-0000-0000-0000-000000000002",
      viewer_user_id: "viewer",
    }),
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(owner.lifecycle, "NEGOTIATING");
  assert.equal(viewer.lifecycle, "NEGOTIATING");
  assert.equal(ownerConnection?.transceivers.length, 2);
  assert.equal(viewerConnection?.transceivers.length, 2);

  ownerConnection!.connectionState = "connected";
  ownerConnection!.onconnectionstatechange?.();
  viewerConnection!.connectionState = "connected";
  viewerConnection!.onconnectionstatechange?.();
  assert.equal(owner.lifecycle, "CONNECTED");
  assert.equal(viewer.lifecycle, "CONNECTED");

  owner.close();
  viewer.close();
  assert.equal(owner.lifecycle, "CLOSED");
  assert.equal(viewer.lifecycle, "CLOSED");
});

test("client cleanup is idempotent and failed signaling is safe", async () => {
  const socket = new MockSocket();
  const client = new DesktopWebRtcClient({
    socketFactory: () => socket,
    peerFactory: () => new MockConnection(),
    loadRefreshCredential: async () => "credential",
  });
  await client.start();
  socket.open();
  socket.onmessage?.({ data: JSON.stringify({ type: "error", code: "NOT_AUTHORIZED" }) });
  assert.equal(client.lifecycle, "FAILED");
  client.close();
  client.close();
  assert.equal(client.lifecycle, "CLOSED");
});

test("desktop does not start without a credential", async () => {
  const client = new DesktopWebRtcClient({
    socketFactory: () => new MockSocket(),
    peerFactory: () => new MockConnection(),
    loadRefreshCredential: async () => null,
  });
  await assert.rejects(() => client.start(), /credential unavailable/);
  assert.equal(client.lifecycle, "FAILED");
});

test("initial ICE negotiation timeout is terminal and cleans up the peer", async () => {
  const scheduler = new ManualScheduler();
  const socket = new MockSocket();
  const connection = new MockConnection();
  let terminalError: Error | undefined;
  const client = new DesktopWebRtcClient({
    socketFactory: () => socket,
    peerFactory: () => connection,
    loadRefreshCredential: async () => "credential",
    reconnect: { scheduler },
    onTerminalError: (error) => { terminalError = error; },
  });

  await client.start();
  socket.open();
  socket.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "owner", device_id: "device" }) });
  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_joined",
      session_id: "00000000-0000-0000-0000-000000000002",
      viewer_user_id: "viewer",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.lifecycle, "NEGOTIATING");
  const lateStateCallback = connection.onconnectionstatechange;
  assert.ok([...scheduler.timers.values()].some((timer) => timer.delay === INITIAL_NEGOTIATION_TIMEOUT_MS));

  assert.equal(scheduler.runNext(), INITIAL_NEGOTIATION_TIMEOUT_MS);
  assert.equal(client.lifecycle, "FAILED");
  assert.equal(connection.closed, true);
  assert.match(terminalError?.message ?? "", /initial ICE negotiation timed out/);
  assert.equal(connection.onicecandidate, null);
  assert.equal(connection.onconnectionstatechange, null);
  assert.equal(connection.oniceconnectionstatechange, null);
  lateStateCallback?.();
  assert.equal(client.lifecycle, "FAILED");

  socket.onmessage?.({
    data: JSON.stringify({
      type: "answer",
      session_id: "00000000-0000-0000-0000-000000000002",
      sdp: "late-answer",
    }),
  });
  assert.equal(client.lifecycle, "FAILED");
});

test("late peer state cannot change terminal failure or repeat the terminal notification", async () => {
  const scheduler = new ManualScheduler();
  const socket = new MockSocket();
  const connection = new MockConnection();
  let terminalErrors = 0;
  const client = new DesktopWebRtcClient({
    socketFactory: () => socket,
    peerFactory: () => connection,
    loadRefreshCredential: async () => "credential",
    reconnect: { scheduler },
    onTerminalError: () => { terminalErrors += 1; },
  });

  await client.start();
  socket.open();
  socket.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "owner", device_id: "device" }) });
  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_joined",
      session_id: "00000000-0000-0000-0000-000000000002",
      viewer_user_id: "viewer",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  const lateStateCallback = connection.onconnectionstatechange;
  scheduler.runNext();
  lateStateCallback?.();
  lateStateCallback?.();
  assert.equal(client.lifecycle, "FAILED");
  assert.equal(terminalErrors, 1);
});

test("late signaling after terminal failure cannot recreate a session", async () => {
  const socket = new MockSocket();
  let peersCreated = 0;
  const client = new ViewerWebRtcClient({
    socketFactory: () => socket,
    peerFactory: () => {
      peersCreated += 1;
      return new MockConnection();
    },
    browserSessionToken: "browser-session-token",
    deviceId: "00000000-0000-0000-0000-000000000001",
  });

  client.start();
  socket.open();
  socket.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "viewer" }) });
  socket.onmessage?.({ data: JSON.stringify({ type: "error", code: "NOT_AUTHORIZED" }) });
  socket.onmessage?.({
    data: JSON.stringify({
      type: "session_created",
      session_id: "00000000-0000-0000-0000-000000000002",
      device_id: "00000000-0000-0000-0000-000000000001",
    }),
  });
  assert.equal(client.lifecycle, "FAILED");
  assert.equal(peersCreated, 0);
  assert.equal(socket.sent.length, 1);
});

test("pending authentication work cannot modify state after terminal failure", async () => {
  const socket = new MockSocket();
  let resolveIceServers: ((value: { iceServers: [] }) => void) | undefined;
  const client = new ViewerWebRtcClient({
    socketFactory: () => socket,
    peerFactory: () => new MockConnection(),
    browserSessionToken: "browser-session-token",
    deviceId: "00000000-0000-0000-0000-000000000001",
    loadIceServers: () => new Promise((resolve) => { resolveIceServers = resolve; }),
  });

  client.start();
  socket.open();
  socket.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "viewer" }) });
  socket.onmessage?.({ data: JSON.stringify({ type: "error", code: "NOT_AUTHORIZED" }) });
  resolveIceServers?.({ iceServers: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.lifecycle, "FAILED");
  assert.equal(socket.sent.length, 1);
});

test("explicit leave cancels initial ICE negotiation timeout", async () => {
  const scheduler = new ManualScheduler();
  const socket = new MockSocket();
  const connection = new MockConnection();
  const client = new DesktopWebRtcClient({
    socketFactory: () => socket,
    peerFactory: () => connection,
    loadRefreshCredential: async () => "credential",
    reconnect: { scheduler },
  });

  await client.start();
  socket.open();
  socket.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "owner", device_id: "device" }) });
  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_joined",
      session_id: "00000000-0000-0000-0000-000000000002",
      viewer_user_id: "viewer",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  client.close();
  assert.equal(connection.closed, true);
  assert.equal(scheduler.timers.size, 0);
});

test("successful initial negotiation cancels its timeout", async () => {
  const scheduler = new ManualScheduler();
  const connection = new MockConnection();
  const { client } = await connectedDesktop(scheduler, connection);
  assert.ok(![...scheduler.timers.values()].some((timer) => timer.delay === INITIAL_NEGOTIATION_TIMEOUT_MS));
  client.close();
});

test("server protocol rejects unknown fields and malformed signaling messages", () => {
  assert.equal(parseServerMessage({
    type: "authenticated",
    role: "viewer",
    unexpected: true,
  }), null);
  assert.equal(parseServerMessage({
    type: "offer",
    session_id: "00000000-0000-0000-0000-000000000002",
    sdp: "offer",
    track_map: [{ mid: "0", kind: "screen" }, { mid: "1", kind: "camera" }],
    unexpected: true,
  }), null);
  assert.equal(parseServerMessage({
    type: "ice_candidate",
    session_id: "00000000-0000-0000-0000-000000000002",
    candidate: "not-an-object",
  }), null);
});

test("desktop reconnects with jittered exponential backoff and stable reset", async () => {
  const scheduler = new ManualScheduler();
  const sockets: MockSocket[] = [];
  const client = new DesktopWebRtcClient({
    socketFactory: () => {
      const socket = new MockSocket();
      sockets.push(socket);
      return socket;
    },
    peerFactory: () => new MockConnection(),
    loadRefreshCredential: async () => "credential",
    reconnect: { scheduler, maxAttempts: 4 },
  });

  await client.start();
  sockets[0]!.open();
  sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "owner", device_id: "device" }) });
  await new Promise((resolve) => setImmediate(resolve));
  sockets[0]!.close();
  assert.equal(scheduler.runNext(), 1_500);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sockets.length, 2);
  sockets[1]!.close();
  assert.equal(scheduler.runNext(), 3_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sockets.length, 3);

  sockets[2]!.open();
  sockets[2]!.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "owner", device_id: "device" }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.runNext(), 60_000);
  sockets[2]!.close();
  assert.equal(scheduler.runNext(), 1_500);
});

test("stale socket callbacks cannot affect a newer authenticated connection", async () => {
  const scheduler = new ManualScheduler();
  const sockets: MockSocket[] = [];
  const client = new DesktopWebRtcClient({
    socketFactory: () => {
      const socket = new MockSocket();
      sockets.push(socket);
      return socket;
    },
    peerFactory: () => new MockConnection(),
    loadRefreshCredential: async () => "credential",
    reconnect: { scheduler },
  });

  await client.start();
  sockets[0]!.open();
  sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "owner", device_id: "device" }) });
  sockets[0]!.close();
  scheduler.runNext();
  await new Promise((resolve) => setImmediate(resolve));
  sockets[1]!.open();
  sockets[1]!.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "owner", device_id: "device" }) });
  sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "error", code: "NOT_AUTHORIZED" }) });

  assert.notEqual(client.lifecycle, "FAILED");
  assert.equal(sockets[1]!.readyState, 1);
  client.close();
});

test("viewer does not re-session after an explicit leave", async () => {
  const scheduler = new ManualScheduler();
  const socket = new MockSocket();
  const viewer = new ViewerWebRtcClient({
    socketFactory: () => socket,
    peerFactory: () => new MockConnection(),
    browserSessionToken: "browser-session-token",
    deviceId: "00000000-0000-0000-0000-000000000001",
    reconnect: { scheduler },
  });

  viewer.start();
  socket.open();
  socket.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "viewer" }) });
  await new Promise((resolve) => setImmediate(resolve));
  socket.onmessage?.({
    data: JSON.stringify({
      type: "session_created",
      session_id: "00000000-0000-0000-0000-000000000002",
      device_id: "00000000-0000-0000-0000-000000000001",
    }),
  });
  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_left",
      session_id: "00000000-0000-0000-0000-000000000002",
      viewer_user_id: "owner",
      reason: "closed",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(viewer.lifecycle, "CLOSED");
  assert.equal(scheduler.timers.size, 0);
});

test("viewer retries transient authorization loss during reconnect without weakening initial authorization", async () => {
  const scheduler = new ManualScheduler();
  const sockets: MockSocket[] = [];
  const viewer = new ViewerWebRtcClient({
    socketFactory: () => {
      const socket = new MockSocket();
      sockets.push(socket);
      return socket;
    },
    peerFactory: () => new MockConnection(),
    browserSessionToken: "browser-session-token",
    deviceId: "00000000-0000-0000-0000-000000000001",
    reconnect: { scheduler, baseDelayMs: 1_000 },
  });

  viewer.start();
  sockets[0]!.open();
  sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "viewer" }) });
  sockets[0]!.close();
  assert.equal(scheduler.runNext(), 1_500);
  await new Promise((resolve) => setImmediate(resolve));
  sockets[1]!.open();
  sockets[1]!.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "viewer" }) });
  sockets[1]!.onmessage?.({ data: JSON.stringify({ type: "error", code: "NOT_AUTHORIZED" }) });
  await new Promise((resolve) => setImmediate(resolve));

  assert.notEqual(viewer.lifecycle, "FAILED");
  assert.equal(scheduler.timers.size, 1);
  viewer.close();
  assert.equal(scheduler.timers.size, 0);
});

test("viewer rejects initial unauthorized access and stops retrying after revocation", async () => {
  const initialSocket = new MockSocket();
  const initialViewer = new ViewerWebRtcClient({
    socketFactory: () => initialSocket,
    peerFactory: () => new MockConnection(),
    browserSessionToken: "browser-session-token",
    deviceId: "00000000-0000-0000-0000-000000000001",
  });
  initialViewer.start();
  initialSocket.open();
  initialSocket.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "viewer" }) });
  initialSocket.onmessage?.({ data: JSON.stringify({ type: "error", code: "NOT_AUTHORIZED" }) });
  assert.equal(initialViewer.lifecycle, "FAILED");

  const scheduler = new ManualScheduler();
  const sockets: MockSocket[] = [];
  const viewer = new ViewerWebRtcClient({
    socketFactory: () => {
      const socket = new MockSocket();
      sockets.push(socket);
      return socket;
    },
    peerFactory: () => new MockConnection(),
    browserSessionToken: "browser-session-token",
    deviceId: "00000000-0000-0000-0000-000000000001",
    reconnect: { scheduler },
  });
  viewer.start();
  sockets[0]!.open();
  sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "viewer" }) });
  sockets[0]!.onmessage?.({
    data: JSON.stringify({
      type: "session_created",
      session_id: "00000000-0000-0000-0000-000000000002",
      device_id: "00000000-0000-0000-0000-000000000001",
    }),
  });
  sockets[0]!.close();
  scheduler.runNext();
  await new Promise((resolve) => setImmediate(resolve));
  sockets[1]!.open();
  sockets[1]!.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "viewer" }) });
  sockets[1]!.onmessage?.({ data: JSON.stringify({ type: "error", code: "NOT_AUTHORIZED" }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.timers.size, 1);
  scheduler.runNext();
  await new Promise((resolve) => setImmediate(resolve));
  sockets[2]!.open();
  sockets[2]!.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "viewer" }) });
  sockets[2]!.onmessage?.({ data: JSON.stringify({ type: "error", code: "NOT_AUTHORIZED" }) });
  assert.equal(viewer.lifecycle, "FAILED");
  viewer.close();
});

async function connectedDesktop(
  scheduler: ManualScheduler,
  connection: MockConnection,
  onTerminalError?: (error: Error) => void,
  configuration?: {
    loadRefreshCredential?: () => Promise<string>;
    loadIceServers?: (credential: string) => Promise<{
      iceServers: readonly { urls: string | readonly string[]; username?: string; credential?: string }[];
      iceTransportPolicy?: "all" | "relay";
    }>;
  },
) {
  const sockets: MockSocket[] = [];
  const client = new DesktopWebRtcClient({
    socketFactory: () => {
      const socket = new MockSocket();
      sockets.push(socket);
      return socket;
    },
    peerFactory: () => connection,
    loadRefreshCredential: configuration?.loadRefreshCredential ?? (async () => "credential"),
    loadIceServers: configuration?.loadIceServers,
    reconnect: { scheduler },
    onTerminalError,
  });
  await client.start();
  sockets[0]!.open();
  sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "owner", device_id: "device" }) });
  sockets[0]!.onmessage?.({
    data: JSON.stringify({
      type: "viewer_joined",
      session_id: "00000000-0000-0000-0000-000000000002",
      viewer_user_id: "viewer",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  connection.connectionState = "connected";
  connection.onconnectionstatechange?.();
  return { client, socket: sockets[0]!, connection };
}

test("desktop retries a restart after no answer and permits the second attempt", async () => {
  const scheduler = new ManualScheduler();
  const connection = new MockConnection();
  const { client, socket, connection: peerConnection } = await connectedDesktop(scheduler, connection);
  peerConnection.connectionState = "disconnected";
  peerConnection.onconnectionstatechange?.();
  assert.equal(scheduler.runNext(), 8_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peerConnection.offerCalls, 2);
  assert.equal(scheduler.runNext(), 8_000);
  assert.equal(scheduler.runNext(), 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peerConnection.offerCalls, 3);
  socket.onmessage?.({
    data: JSON.stringify({
      type: "answer",
      session_id: "00000000-0000-0000-0000-000000000002",
      sdp: "restart-answer",
      track_map: [{ mid: "0", kind: "screen" }, { mid: "1", kind: "camera" }],
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.timers.size, 1);
  client.close();
});

test("desktop refreshes ICE servers and applies the new configuration before restart", async () => {
  const scheduler = new ManualScheduler();
  const connection = new MockConnection();
  let credentialLoads = 0;
  let iceLoads = 0;
  const { client, connection: peerConnection } = await connectedDesktop(
    scheduler,
    connection,
    undefined,
    {
      loadRefreshCredential: async () => {
        credentialLoads += 1;
        return `credential-${credentialLoads}`;
      },
      loadIceServers: async (credential) => {
        iceLoads += 1;
        return {
          iceServers: [{ urls: `turn:${credential}.example.test` }],
          iceTransportPolicy: "all",
        };
      },
    },
  );
  peerConnection.connectionState = "disconnected";
  peerConnection.onconnectionstatechange?.();
  assert.equal(scheduler.runNext(), 8_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(credentialLoads, 2);
  assert.equal(iceLoads, 2);
  assert.deepEqual(peerConnection.configurations, [{
    iceServers: [{ urls: "turn:credential-2.example.test" }],
    iceTransportPolicy: "all",
  }]);
  client.close();
});

test("desktop retries after restart offer creation failure and reports terminal failure after two failures", async () => {
  const scheduler = new ManualScheduler();
  const connection = new MockConnection();
  let terminalError: Error | undefined;
  const { client, connection: peerConnection } = await connectedDesktop(
    scheduler,
    connection,
    (error) => { terminalError = error; },
  );
  connection.failOfferCount = 2;
  peerConnection.connectionState = "failed";
  peerConnection.onconnectionstatechange?.();
  assert.equal(scheduler.runNext(), 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.runNext(), 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peerConnection.offerCalls, 3);
  assert.match(terminalError?.message ?? "", /relay status/);
  assert.equal(client.lifecycle, "FAILED");
  client.close();
});

test("closing the control plane cancels pending ICE restart activity", async () => {
  const scheduler = new ManualScheduler();
  const connection = new MockConnection();
  const { client, socket, connection: peerConnection } = await connectedDesktop(scheduler, connection);
  peerConnection.connectionState = "disconnected";
  peerConnection.onconnectionstatechange?.();
  socket.close();
  assert.equal(scheduler.timers.size, 1);
  scheduler.runNext();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peerConnection.offerCalls, 1);
  client.close();
});
