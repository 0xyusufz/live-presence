import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DesktopWebRtcClient,
  INITIAL_NEGOTIATION_TIMEOUT_MS,
  ViewerWebRtcClient,
  type DesktopDiagnostic,
  type ClientSignalingDiagnostic,
  NETWORK_RECOVERY_TIMEOUT_MS,
  type RecoveryDiagnostic,
  type SignalingSocket,
  type ClientScheduler,
} from "./client.js";
import { parseServerMessage } from "./protocol.js";
import type {
  WebRtcDiagnostic,
  WebRtcPeer,
  WebRtcPeerConnection,
  WebRtcTrack,
  WebRtcTransceiver,
} from "./webrtc.js";

class MockConnection implements WebRtcPeerConnection {
  transceivers: WebRtcTransceiver[] = [];
  connectionState = "new";
  iceConnectionState = "new";
  signalingState = "stable";
  onicecandidate: ((event: { candidate: unknown | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontrack: ((event: { track: { kind?: string }; transceiver?: { mid: string | null } }) => void) | null = null;
  closed = false;
  local: unknown;
  remote: unknown;
  remoteDescriptionError: Error | undefined;
  remoteDescriptionGate: Promise<void> | undefined;
  iceCandidateGate: Promise<void> | undefined;
  offerCalls = 0;
  answerCalls = 0;
  failOfferCount = 0;
  configurations: unknown[] = [];
  replaceCalls: Array<{ index: number; track: unknown }> = [];
  candidateCalls = 0;
  events: string[] = [];

  addTransceiver(_kind: string, init: { direction: "sendonly" | "recvonly" }): WebRtcTransceiver {
    const index = this.transceivers.length;
    const mid = String(index);
    const transceiver: WebRtcTransceiver = {
      mid,
      currentDirection: null,
      direction: init.direction,
      sender: { replaceTrack: async (track) => {
        this.replaceCalls.push({ index, track });
        this.events.push(`track-${index}`);
      } },
    };
    this.transceivers.push(transceiver);
    return transceiver;
  }

  setConfiguration(configuration: unknown): void { this.configurations.push(configuration); }

  async createOffer() {
    this.events.push("offer");
    this.offerCalls += 1;
    if (this.failOfferCount > 0) {
      this.failOfferCount -= 1;
      throw new Error("offer failed");
    }
    return { type: "offer" as const, sdp: "owner-offer" };
  }
  async createAnswer() {
    this.answerCalls += 1;
    return { type: "answer" as const, sdp: "viewer-answer" };
  }
  async setLocalDescription(value: unknown) {
    this.local = value;
    if (
      typeof value === "object" && value !== null &&
      "type" in value && value.type === "answer"
    ) {
      for (const transceiver of this.transceivers) {
        transceiver.currentDirection = transceiver.direction;
      }
    }
  }
  async setRemoteDescription(value: unknown) {
    await this.remoteDescriptionGate;
    if (this.remoteDescriptionError) throw this.remoteDescriptionError;
    this.remote = value;
    if (
      typeof value === "object" && value !== null &&
      "type" in value && value.type === "offer" &&
      "sdp" in value && typeof value.sdp === "string"
    ) {
      const offeredMids = [...value.sdp.matchAll(/^a=mid:([^\r\n]+)$/gm)].map((match) => match[1]!);
      const mids = offeredMids.length === 2 ? offeredMids : ["0", "1"];
      for (const mid of mids) {
        this.transceivers.push({
          mid,
          currentDirection: null,
          direction: "recvonly",
          sender: { replaceTrack: async () => {} },
        });
      }
    }
  }
  async addIceCandidate() {
    await this.iceCandidateGate;
    this.candidateCalls += 1;
  }
  close() { this.closed = true; }
}

class MockSocket implements SignalingSocket {
  readyState = 0;
  authenticationManaged?: boolean;
  peer: MockSocket | undefined;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  private messageHandler: ((event: { data: unknown }) => void) | null = null;
  private negotiationId: string | undefined;
  get onmessage(): ((event: { data: unknown }) => void) | null {
    if (!this.messageHandler) return null;
    return (event) => {
      let data = event.data;
      if (typeof data === "string") {
        try {
          const message = JSON.parse(data) as Record<string, unknown>;
          if (
            (message.type === "offer" || message.type === "answer" || message.type === "ice_candidate") &&
            typeof message.negotiation_id !== "string"
          ) {
            message.negotiation_id = this.negotiationId ?? "test-negotiation-id";
            data = JSON.stringify(message);
          }
        } catch {
          // Leave malformed fixture data unchanged for parser tests.
        }
      }
      this.messageHandler?.({ data });
    };
  }
  set onmessage(handler: ((event: { data: unknown }) => void) | null) {
    this.messageHandler = handler;
  }
  onclose: ((event?: { code?: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
    try {
      const message = JSON.parse(data) as Record<string, unknown>;
      if (typeof message.negotiation_id === "string") this.negotiationId = message.negotiation_id;
    } catch {
      // Outbound non-JSON data is not part of the signaling protocol.
    }
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }

  disconnect(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
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

  runDelay(delay: number): void {
    const entry = [...this.timers.entries()].find(([, timer]) => timer.delay === delay);
    assert.ok(entry, `expected a timer with delay ${delay}`);
    const [id, timer] = entry;
    this.timers.delete(id);
    timer.callback();
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
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
  assert.equal(viewerConnection?.transceivers.length, 0);

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
  assert.deepEqual(parseServerMessage({
    type: "session_recovery",
    session_id: "00000000-0000-0000-0000-000000000002",
  }), {
    type: "session_recovery",
    session_id: "00000000-0000-0000-0000-000000000002",
  });
});

test("desktop reconnects with jittered exponential backoff and stable reset", async () => {
  const scheduler = new ManualScheduler();
  const sockets: MockSocket[] = [];
  const connections: MockConnection[] = [];
  const client = new DesktopWebRtcClient({
    socketFactory: () => {
      const socket = new MockSocket();
      sockets.push(socket);
      return socket;
    },
    peerFactory: () => {
      const connection = new MockConnection();
      connections.push(connection);
      return connection;
    },
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

test("stale owner authentication work cannot publish state on a newer socket", async () => {
  const scheduler = new ManualScheduler();
  const sockets: MockSocket[] = [];
  const refreshes: Array<() => void> = [];
  const client = new DesktopWebRtcClient({
    socketFactory: () => {
      const socket = new MockSocket();
      socket.authenticationManaged = true;
      sockets.push(socket);
      return socket;
    },
    peerFactory: () => new MockConnection(),
    managedAuthentication: true,
    refreshPresence: () => new Promise<void>((resolve) => refreshes.push(resolve)),
    reconnect: { scheduler },
  });
  client.setSharingState(true, false);

  await client.start();
  sockets[0]!.open();
  sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "owner", device_id: "device" }) });
  await new Promise((resolve) => setImmediate(resolve));
  sockets[0]!.close();
  scheduler.runNext();
  await new Promise((resolve) => setImmediate(resolve));
  sockets[1]!.open();
  sockets[1]!.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "owner", device_id: "device" }) });
  await new Promise((resolve) => setImmediate(resolve));

  refreshes[0]!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sockets[1]!.sent.length, 0);

  refreshes[1]!();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(sockets[1]!.sent[0]!), {
    type: "sharing_state",
    screen: true,
    camera: false,
  });
  client.close();
});

test("owner presence starts while idle and sharing reuses that authenticated socket", async () => {
  const scheduler = new ManualScheduler();
  const sockets: MockSocket[] = [];
  const connections: MockConnection[] = [];
  let iceLoads = 0;
  let captureStarted = false;
  const client = new DesktopWebRtcClient({
    socketFactory: () => {
      const socket = new MockSocket();
      socket.authenticationManaged = true;
      sockets.push(socket);
      return socket;
    },
    peerFactory: () => {
      const connection = new MockConnection();
      connections.push(connection);
      return connection;
    },
    managedAuthentication: true,
    loadManagedIceServers: async () => {
      iceLoads += 1;
      return { iceServers: [] };
    },
    isSharingActive: () => captureStarted,
    reconnect: { scheduler },
  });

  await client.start();
  assert.equal(sockets.length, 1);
  assert.equal(iceLoads, 0);
  assert.equal(captureStarted, false);
  sockets[0]!.open();
  sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "owner", device_id: "device" }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(sockets[0]!.sent[0]!), {
    type: "sharing_state",
    screen: false,
    camera: false,
  });
  assert.equal(client.lifecycle, "CONNECTING");

  captureStarted = true;
  client.setSharingState(true, false);
  sockets[0]!.onmessage?.({
    data: JSON.stringify({
      type: "viewer_joined",
      session_id: "00000000-0000-0000-0000-000000000123",
      viewer_user_id: "viewer",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(iceLoads, 1);
  assert.equal(connections.length, 1);
  assert.equal(sockets.length, 1);

  captureStarted = false;
  client.stopSharingSession();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0]!.readyState, 1);
  assert.equal(captureStarted, false);
  assert.deepEqual(JSON.parse(sockets[0]!.sent.at(-1)!), {
    type: "sharing_state",
    screen: false,
    camera: false,
  });
  assert.equal(scheduler.timers.size, 1);

  client.close();
  assert.equal(sockets[0]!.readyState, 3);
  assert.equal(scheduler.timers.size, 0);
});

test("idle owner presence reconnects after signaling loss and remains credential-gated", async () => {
  const scheduler = new ManualScheduler();
  const sockets: MockSocket[] = [];
  let socketCreations = 0;
  const client = new DesktopWebRtcClient({
    socketFactory: () => {
      const socket = new MockSocket();
      socket.authenticationManaged = true;
      sockets.push(socket);
      socketCreations += 1;
      return socket;
    },
    peerFactory: () => new MockConnection(),
    managedAuthentication: true,
    reconnect: { scheduler },
  });

  await client.start();
  sockets[0]!.open();
  sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "owner", device_id: "device" }) });
  await new Promise((resolve) => setImmediate(resolve));
  sockets[0]!.disconnect();
  assert.equal(scheduler.runNext(), 1_500);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sockets.length, 2);
  sockets[1]!.open();
  sockets[1]!.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "owner", device_id: "device" }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(sockets[1]!.sent[0]!), {
    type: "sharing_state",
    screen: false,
    camera: false,
  });
  assert.equal(socketCreations, 2);
  client.close();

  const missingCredential = new DesktopWebRtcClient({
    socketFactory: () => {
      const socket = new MockSocket();
      sockets.push(socket);
      return socket;
    },
    peerFactory: () => new MockConnection(),
    loadRefreshCredential: async () => null,
    loadIceServers: async () => ({ iceServers: [] }),
  });
  await assert.rejects(missingCredential.start(), /device credential unavailable/);
  assert.equal(socketCreations, 2);
  assert.equal(sockets.length, 2);
});

test("sharing activation reports only socket delivery until backend acknowledgement", async () => {
  const scheduler = new ManualScheduler();
  const socket = new MockSocket();
  socket.authenticationManaged = true;
  const diagnostics: DesktopDiagnostic[] = [];
  const confirmations: Array<{ deviceId: string; screen: boolean; camera: boolean }> = [];
  const client = new DesktopWebRtcClient({
    socketFactory: () => socket,
    peerFactory: () => new MockConnection(),
    managedAuthentication: true,
    reconnect: { scheduler },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    onSharingStateConfirmed: (state) => confirmations.push(state),
  });

  client.setSharingState(true, false);
  assert.equal(diagnostics.at(-1)?.event, "sharing-state");
  assert.equal(diagnostics.at(-1)?.sent, false);
  assert.equal(confirmations.length, 0);

  await client.start();
  socket.open();
  socket.onmessage?.({
    data: JSON.stringify({ type: "authenticated", role: "owner", device_id: "00000000-0000-0000-0000-000000000001" }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(socket.sent.at(-1)!), {
    type: "sharing_state",
    screen: true,
    camera: false,
  });
  assert.equal(
    diagnostics.filter((diagnostic) => diagnostic.event === "sharing-state").at(-1)?.sent,
    true,
  );
  assert.equal(confirmations.length, 0);

  socket.onmessage?.({
    data: JSON.stringify({
      type: "sharing_state_updated",
      device_id: "00000000-0000-0000-0000-000000000001",
      screen: true,
      camera: false,
    }),
  });
  assert.deepEqual(confirmations, [{
    deviceId: "00000000-0000-0000-0000-000000000001",
    screen: true,
    camera: false,
  }]);

  socket.disconnect();
  client.setSharingState(true, false);
  assert.equal(diagnostics.at(-1)?.sent, false);
  assert.equal(confirmations.length, 1);
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

test("viewer treats sharing_stopped as an expected end and keeps authenticated presence open", async () => {
  const scheduler = new ManualScheduler();
  const sockets: MockSocket[] = [];
  const connection = new MockConnection();
  const endedReasons: string[] = [];
  const viewer = new ViewerWebRtcClient({
    socketFactory: () => {
      const socket = new MockSocket();
      sockets.push(socket);
      return socket;
    },
    peerFactory: () => connection,
    browserSessionToken: "browser-session-token",
    deviceId: "00000000-0000-0000-0000-000000000001",
    reconnect: { scheduler },
    onSessionEnded: (reason) => endedReasons.push(reason),
  });

  viewer.start();
  const socket = sockets[0]!;
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
  assert.equal(viewer.lifecycle, "NEGOTIATING");
  assert.equal(connection.closed, false);
  const createSessionCount = socket.sent.filter((data) => JSON.parse(data).type === "create_session").length;

  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_left",
      session_id: "00000000-0000-0000-0000-000000000002",
      viewer_user_id: "owner",
      reason: "sharing_stopped",
    }),
  });

  assert.equal(viewer.lifecycle, "CLOSED");
  assert.equal(connection.closed, true);
  assert.equal(socket.readyState, 1);
  assert.deepEqual(endedReasons, ["sharing_stopped"]);
  assert.equal(scheduler.timers.size, 1);
  assert.equal(
    socket.sent.filter((data) => JSON.parse(data).type === "create_session").length,
    createSessionCount,
  );
  socket.disconnect();
  assert.equal(scheduler.runNext(), 1_500);
  await new Promise((resolve) => setImmediate(resolve));
  const replacementSocket = sockets[1]!;
  replacementSocket.open();
  replacementSocket.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "viewer" }) });
  await new Promise((resolve) => setImmediate(resolve));
  replacementSocket.onmessage?.({
    data: JSON.stringify({
      type: "device_sharing_state",
      device_id: "00000000-0000-0000-0000-000000000001",
      screen: false,
      camera: false,
    }),
  });
  assert.equal(viewer.lifecycle, "CLOSED");
  assert.equal(
    replacementSocket.sent.some((data) => JSON.parse(data).type === "create_session"),
    true,
  );
  viewer.close();
  assert.equal(replacementSocket.readyState, 3);
});

test("viewer waits while sharing is inactive and creates one fresh session on each activation", async () => {
  const socket = new MockSocket();
  const connections: MockConnection[] = [];
  const endedReasons: string[] = [];
  const deviceId = "00000000-0000-0000-0000-000000000001";
  const viewer = new ViewerWebRtcClient({
    socketFactory: () => socket,
    peerFactory: () => {
      const connection = new MockConnection();
      connections.push(connection);
      return connection;
    },
    browserSessionToken: "browser-session-token",
    deviceId,
    onSessionEnded: (reason) => endedReasons.push(reason),
  });

  viewer.start();
  socket.open();
  socket.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "viewer" }) });
  await new Promise((resolve) => setImmediate(resolve));
  const notifySharing = (screen: boolean) => socket.onmessage?.({
    data: JSON.stringify({
      type: "device_sharing_state",
      device_id: deviceId,
      screen,
      camera: false,
    }),
  });
  const createSessionCount = () => socket.sent.filter((data) =>
    JSON.parse(data).type === "create_session"
  ).length;

  notifySharing(false);
  assert.equal(viewer.lifecycle, "CLOSED");
  assert.equal(createSessionCount(), 1);

  notifySharing(true);
  notifySharing(true);
  assert.equal(createSessionCount(), 2);
  socket.onmessage?.({
    data: JSON.stringify({
      type: "session_created",
      session_id: "00000000-0000-0000-0000-000000000002",
      device_id: deviceId,
    }),
  });
  assert.equal(viewer.lifecycle, "NEGOTIATING");
  assert.equal(connections.length, 1);

  notifySharing(false);
  notifySharing(false);
  assert.equal(viewer.lifecycle, "CLOSED");
  assert.equal(connections[0]?.closed, true);
  assert.deepEqual(endedReasons, ["sharing_stopped"]);

  notifySharing(true);
  notifySharing(true);
  assert.equal(createSessionCount(), 3);
  socket.onmessage?.({
    data: JSON.stringify({
      type: "session_created",
      session_id: "00000000-0000-0000-0000-000000000003",
      device_id: deviceId,
    }),
  });
  assert.equal(viewer.lifecycle, "NEGOTIATING");
  assert.equal(connections.length, 2);
  assert.equal(socket.readyState, 1);
});

test("inactive-sharing polls preserve the authenticated online viewer lifecycle", async () => {
  const socket = new MockSocket();
  const scheduler = new ManualScheduler();
  const connections: MockConnection[] = [];
  const deviceId = "00000000-0000-0000-0000-000000000001";
  const availability: boolean[] = [];
  const viewer = new ViewerWebRtcClient({
    socketFactory: () => socket,
    peerFactory: () => {
      const connection = new MockConnection();
      connections.push(connection);
      return connection;
    },
    browserSessionToken: "browser-session-token",
    deviceId,
    reconnect: { scheduler },
    onDeviceAvailability: (online) => availability.push(online),
  });
  viewer.start();
  socket.open();
  socket.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "viewer" }) });
  await new Promise((resolve) => setImmediate(resolve));

  for (let cycle = 0; cycle < 3; cycle += 1) {
    socket.onmessage?.({
      data: JSON.stringify({
        type: "device_sharing_state",
        device_id: deviceId,
        screen: false,
        camera: false,
      }),
    });
    assert.equal(viewer.lifecycle, "CLOSED");
    if (cycle < 2) {
      scheduler.runNext();
      assert.equal(viewer.lifecycle, "CLOSED");
    }
  }

  assert.deepEqual(availability, [true, true, true]);
  assert.equal(socket.sent.filter((data) => JSON.parse(data).type === "create_session").length, 3);
  assert.equal(connections.length, 0);
  viewer.close();
  viewer.close();
});

test("viewer retries an authorized offline device and reports online-but-not-sharing", async () => {
  const scheduler = new ManualScheduler();
  const socket = new MockSocket();
  const availability: boolean[] = [];
  const viewer = new ViewerWebRtcClient({
    socketFactory: () => socket,
    peerFactory: () => new MockConnection(),
    browserSessionToken: "browser-session-token",
    deviceId: "00000000-0000-0000-0000-000000000001",
    reconnect: { scheduler },
    onDeviceAvailability: (online) => availability.push(online),
  });

  viewer.start();
  socket.open();
  socket.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "viewer" }) });
  await new Promise((resolve) => setImmediate(resolve));
  socket.onmessage?.({ data: JSON.stringify({ type: "error", code: "DEVICE_OFFLINE" }) });

  assert.deepEqual(availability, [false]);
  assert.equal(viewer.lifecycle, "RECONNECTING");
  assert.ok([...scheduler.timers.values()].some((timer) => timer.delay === 1_500));
  assert.equal(scheduler.runNext(), 1_500);
  assert.equal(
    socket.sent.filter((data) => JSON.parse(data).type === "create_session").length,
    2,
  );

  socket.onmessage?.({
    data: JSON.stringify({
      type: "device_sharing_state",
      device_id: "00000000-0000-0000-0000-000000000001",
      screen: false,
      camera: false,
    }),
  });
  assert.deepEqual(availability, [false, true]);
  assert.equal(viewer.lifecycle, "CLOSED");
  assert.ok([...scheduler.timers.values()].some((timer) => timer.delay === 3_000));
  assert.equal(scheduler.runNext(), 3_000);
  socket.onmessage?.({ data: JSON.stringify({ type: "error", code: "DEVICE_OFFLINE" }) });
  assert.deepEqual(availability, [false, true, false]);
  assert.equal(viewer.lifecycle, "RECONNECTING");
  viewer.close();
});

test("camera sharing updates preserve the active screen peer and canonical transceivers", async () => {
  const socket = new MockSocket();
  const connection = new MockConnection();
  const deviceId = "00000000-0000-0000-0000-000000000001";
  const sharingStates: Array<{ screen: boolean; camera: boolean }> = [];
  const screenTracks: unknown[] = [];
  const viewer = new ViewerWebRtcClient({
    socketFactory: () => socket,
    peerFactory: () => connection,
    browserSessionToken: "browser-session-token",
    deviceId,
    onSharingState: (state) => sharingStates.push(state),
  });
  viewer.onRemoteTrack = (track, _mid, kind) => {
    if (kind === "screen") screenTracks.push(track);
  };

  viewer.start();
  socket.open();
  socket.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "viewer" }) });
  await new Promise((resolve) => setImmediate(resolve));
  socket.onmessage?.({
    data: JSON.stringify({
      type: "device_sharing_state",
      device_id: deviceId,
      screen: true,
      camera: true,
    }),
  });
  socket.onmessage?.({
    data: JSON.stringify({
      type: "session_created",
      session_id: "00000000-0000-0000-0000-000000000002",
      device_id: deviceId,
    }),
  });
  socket.onmessage?.({
    data: JSON.stringify({
      type: "offer",
      session_id: "00000000-0000-0000-0000-000000000002",
      sdp: "valid-offer",
      track_map: [
        { mid: "0", kind: "screen" },
        { mid: "1", kind: "camera" },
      ],
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  const screenTrack = { kind: "video" };
  connection.ontrack?.({ track: screenTrack, transceiver: { mid: "0" } });
  for (const camera of [false, true]) {
    socket.onmessage?.({
      data: JSON.stringify({
        type: "device_sharing_state",
        device_id: deviceId,
        screen: true,
        camera,
      }),
    });
  }

  assert.deepEqual(sharingStates, [
    { screen: true, camera: true },
    { screen: true, camera: false },
    { screen: true, camera: true },
  ]);
  assert.deepEqual(screenTracks, [screenTrack]);
  assert.equal(connection.closed, false);
  assert.deepEqual(connection.transceivers.map((transceiver) => transceiver.mid), ["0", "1"]);
  assert.equal(
    socket.sent.filter((data) => JSON.parse(data).type === "create_session").length,
    1,
  );
  viewer.close();
});

test("viewer keeps genuine SDP failures in FAILED state", async () => {
  const socket = new MockSocket();
  const connection = new MockConnection();
  connection.remoteDescriptionError = new Error("browser rejected the offer");
  let terminalError: Error | undefined;
  const viewer = new ViewerWebRtcClient({
    socketFactory: () => socket,
    peerFactory: () => connection,
    browserSessionToken: "browser-session-token",
    deviceId: "00000000-0000-0000-0000-000000000001",
    onTerminalError: (error) => { terminalError = error; },
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
      type: "offer",
      session_id: "00000000-0000-0000-0000-000000000002",
      sdp: "valid-offer",
      track_map: [
        { mid: "0", kind: "screen" },
        { mid: "1", kind: "camera" },
      ],
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(viewer.lifecycle, "FAILED");
  assert.match(terminalError?.message ?? "", /setRemoteDescription\(offer\) failed/);
  const createSessionCount = socket.sent.filter((data) => JSON.parse(data).type === "create_session").length;
  socket.onmessage?.({
    data: JSON.stringify({
      type: "device_sharing_state",
      device_id: "00000000-0000-0000-0000-000000000001",
      screen: true,
      camera: false,
    }),
  });
  assert.equal(
    socket.sent.filter((data) => JSON.parse(data).type === "create_session").length,
    createSessionCount,
  );
  viewer.close();
});

test("viewer processes the offer after session creation and sends one answer", async () => {
  const socket = new MockSocket();
  const connection = new MockConnection();
  const client = new ViewerWebRtcClient({
    socketFactory: () => socket,
    peerFactory: () => connection,
    browserSessionToken: "browser-session-token",
    deviceId: "00000000-0000-0000-0000-000000000001",
  });

  client.start();
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
  const offer = JSON.stringify({
    type: "offer",
    session_id: "00000000-0000-0000-0000-000000000002",
    negotiation_id: "viewer-negotiation-1",
    sdp: "valid-offer",
    track_map: [
      { mid: "0", kind: "screen" },
      { mid: "1", kind: "camera" },
    ],
  });
  socket.onmessage?.({ data: offer });
  socket.onmessage?.({ data: offer });
  await new Promise((resolve) => setImmediate(resolve));

  const answers = socket.sent
    .map((data) => JSON.parse(data) as { type: string; session_id?: string; negotiation_id?: string; sdp?: string })
    .filter((message) => message.type === "answer");
  assert.deepEqual(answers, [{
    type: "answer",
    session_id: "00000000-0000-0000-0000-000000000002",
    negotiation_id: "viewer-negotiation-1",
    sdp: "viewer-answer",
    track_map: [
      { mid: "0", kind: "screen" },
      { mid: "1", kind: "camera" },
    ],
  }]);
  assert.equal(connection.answerCalls, 1);
  assert.equal(connection.transceivers.length, 2);
  assert.deepEqual(connection.transceivers.map((transceiver) => transceiver.mid), ["0", "1"]);
  assert.deepEqual(connection.transceivers.map((transceiver) => transceiver.currentDirection), ["recvonly", "recvonly"]);
  assert.equal(client.lifecycle, "NEGOTIATING");
  client.close();
});

test("viewer exposes asynchronous offer-processing failures instead of hiding them in FAILED", async () => {
  const socket = new MockSocket();
  const connection = new MockConnection();
  connection.remoteDescriptionError = new Error("browser rejected the offer");
  let terminalError: Error | undefined;
  const client = new ViewerWebRtcClient({
    socketFactory: () => socket,
    peerFactory: () => connection,
    browserSessionToken: "browser-session-token",
    deviceId: "00000000-0000-0000-0000-000000000001",
    onTerminalError: (error) => { terminalError = error; },
  });

  client.start();
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
      type: "offer",
      session_id: "00000000-0000-0000-0000-000000000002",
      sdp: "valid-offer",
      track_map: [
        { mid: "0", kind: "screen" },
        { mid: "1", kind: "camera" },
      ],
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(client.lifecycle, "FAILED");
  assert.match(terminalError?.message ?? "", /setRemoteDescription\(offer\) failed: browser rejected the offer/);
  assert.equal(socket.sent.some((data) => JSON.parse(data).type === "answer"), false);
  client.close();
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
    refreshPresence?: () => Promise<void>;
    loadIceServers?: (credential: string) => Promise<{
      iceServers: readonly { urls: string | readonly string[]; username?: string; credential?: string }[];
      iceTransportPolicy?: "all" | "relay";
    }>;
    onDiagnostic?: (diagnostic: DesktopDiagnostic) => void;
    recoveryTimeoutMs?: number;
    isSharingActive?: () => boolean;
    prepareOwnerPeer?: (peer: WebRtcPeer) => Promise<void>;
    peerFactory?: () => MockConnection;
  },
) {
  const sockets: MockSocket[] = [];
  const client = new DesktopWebRtcClient({
    socketFactory: () => {
      const socket = new MockSocket();
      sockets.push(socket);
      return socket;
    },
    peerFactory: configuration?.peerFactory ?? (() => connection),
    loadRefreshCredential: configuration?.loadRefreshCredential ?? (async () => "credential"),
    loadIceServers: configuration?.loadIceServers,
    refreshPresence: configuration?.refreshPresence,
    reconnect: {
      scheduler,
      ...(configuration?.recoveryTimeoutMs === undefined
        ? {}
        : { recoveryTimeoutMs: configuration.recoveryTimeoutMs }),
    },
    isSharingActive: configuration?.isSharingActive,
    onTerminalError,
    onDiagnostic: configuration?.onDiagnostic,
    prepareOwnerPeer: configuration?.prepareOwnerPeer,
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
  sockets[0]!.onmessage?.({
    data: JSON.stringify({
      type: "answer",
      session_id: "00000000-0000-0000-0000-000000000002",
      sdp: "initial-answer",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  connection.connectionState = "connected";
  connection.onconnectionstatechange?.();
  return { client, socket: sockets[0]!, sockets, connection };
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
  assert.ok(scheduler.timers.size >= 1);
  client.close();
});

test("desktop retries an ICE restart offer failure once without replacing the peer", async () => {
  const scheduler = new ManualScheduler();
  const connection = new MockConnection();
  const { client, connection: peerConnection } = await connectedDesktop(scheduler, connection);
  connection.failOfferCount = 1;
  peerConnection.connectionState = "failed";
  peerConnection.onconnectionstatechange?.();
  assert.equal(scheduler.runNext(), 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.runNext(), 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peerConnection.offerCalls, 3);
  assert.equal(peerConnection.closed, false);
  assert.equal(client.lifecycle, "RECONNECTING");
  client.close();
});

test("owner attaches existing screen and camera tracks before creating its offer", async () => {
  const socket = new MockSocket();
  socket.authenticationManaged = true;
  const connection = new MockConnection();
  const screen = { readyState: "live" };
  const camera = { readyState: "live" };
  const client = new DesktopWebRtcClient({
    socketFactory: () => socket,
    peerFactory: () => connection,
    managedAuthentication: true,
    loadManagedIceServers: async () => ({ iceServers: [] }),
    isSharingActive: () => true,
    prepareOwnerPeer: async (peer) => {
      await peer.replaceTrack("screen", screen);
      await peer.replaceTrack("camera", camera);
    },
  });
  await client.start();
  socket.open();
  socket.onmessage?.({
    data: JSON.stringify({ type: "authenticated", role: "owner", device_id: "device" }),
  });
  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_joined",
      session_id: "00000000-0000-0000-0000-000000000002",
      viewer_user_id: "viewer",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(connection.events, ["track-0", "track-1", "offer"]);
  assert.equal(connection.replaceCalls[0]?.track, screen);
  assert.equal(connection.replaceCalls[1]?.track, camera);
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

test("desktop retries restart failure but waits for the bounded recovery deadline", async () => {
  const scheduler = new ManualScheduler();
  const connection = new MockConnection();
  const terminalErrors: Error[] = [];
  const diagnostics: DesktopDiagnostic[] = [];
  const { client, connection: peerConnection } = await connectedDesktop(
    scheduler,
    connection,
    (error) => terminalErrors.push(error),
    { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) },
  );
  connection.failOfferCount = 2;
  peerConnection.connectionState = "failed";
  peerConnection.onconnectionstatechange?.();
  assert.equal(scheduler.runNext(), 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.runNext(), 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peerConnection.offerCalls, 3);
  assert.equal(terminalErrors.length, 0);
  assert.equal(client.lifecycle, "RECONNECTING");
  assert.equal(scheduler.runNext(), NETWORK_RECOVERY_TIMEOUT_MS);
  assert.match(terminalErrors[0]?.message ?? "", /network recovery timed out after 180 seconds/);
  assert.equal(client.lifecycle, "FAILED");
  assert.ok(diagnostics.some((diagnostic) =>
    diagnostic.event === "recovery_timed_out" &&
    diagnostic.sessionId === "00000000-0000-0000-0000-000000000002" &&
    diagnostic.peerGeneration !== undefined));
  client.close();
});

test("explicit Stop Sharing clears pending recovery and ICE restart timers", async () => {
  const scheduler = new ManualScheduler();
  const connection = new MockConnection();
  const { client, socket, connection: peerConnection } = await connectedDesktop(scheduler, connection);
  await client.setSharingState(true, false);
  peerConnection.connectionState = "disconnected";
  peerConnection.onconnectionstatechange?.();
  assert.ok([...scheduler.timers.values()].some((timer) => timer.delay === 8_000));
  assert.ok([...scheduler.timers.values()].some((timer) => timer.delay === NETWORK_RECOVERY_TIMEOUT_MS));

  await client.stopSharingSession();
  assert.ok(![...scheduler.timers.values()].some((timer) =>
    timer.delay === 8_000 || timer.delay === NETWORK_RECOVERY_TIMEOUT_MS));
  assert.deepEqual(JSON.parse(socket.sent.at(-1)!), {
    type: "sharing_state",
    screen: false,
    camera: false,
  });
  assert.equal(peerConnection.offerCalls, 1);
  client.close();
});

test("a new recovery event re-arms bounded ICE restart attempts without parallel offers", async () => {
  const scheduler = new ManualScheduler();
  const connection = new MockConnection();
  const diagnostics: DesktopDiagnostic[] = [];
  const { client, socket, connection: peerConnection } = await connectedDesktop(
    scheduler,
    connection,
    undefined,
    { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) },
  );
  await client.setSharingState(true, false);
  peerConnection.connectionState = "disconnected";
  peerConnection.onconnectionstatechange?.();

  assert.equal(scheduler.runNext(), 8_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.runNext(), 8_000);
  assert.equal(scheduler.runNext(), 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.runNext(), 8_000);
  assert.equal(peerConnection.offerCalls, 3);

  const newRecoveryEvent = {
    type: "session_recovery",
    session_id: "00000000-0000-0000-0000-000000000002",
    recovery_attempt_id: "recovery-attempt-new-cycle",
  };
  socket.onmessage?.({ data: JSON.stringify(newRecoveryEvent) });
  socket.onmessage?.({ data: JSON.stringify(newRecoveryEvent) });
  const receivedDiagnostic = diagnostics.find((diagnostic) =>
    diagnostic.event === "session_recovery_received" &&
    diagnostic.recoveryAttemptId === "recovery-attempt-new-cycle");
  assert.ok(receivedDiagnostic);
  assert.ok(receivedDiagnostic.timestamp);
  assert.equal(receivedDiagnostic.sessionId, "00000000-0000-0000-0000-000000000002");
  assert.ok(receivedDiagnostic.peerGeneration !== undefined);
  assert.ok(receivedDiagnostic.negotiationId);
  assert.ok(receivedDiagnostic.socketConnectionGeneration !== undefined);
  assert.equal(scheduler.runNext(), 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peerConnection.offerCalls, 4);
  assert.equal(
    diagnostics.filter((diagnostic) => diagnostic.event === "ice_restart_started").length,
    3,
  );
  assert.ok(diagnostics.some((diagnostic) =>
    diagnostic.event === "ice_restart_retry_scheduled" &&
    diagnostic.reason === "new-recovery-event" &&
    diagnostic.attempt === 1));

  socket.onmessage?.({
    data: JSON.stringify({
      type: "session_recovery",
      session_id: "00000000-0000-0000-0000-000000000002",
      recovery_attempt_id: "recovery-attempt-queued",
    }),
  });
  assert.equal(peerConnection.offerCalls, 4);
  assert.equal(scheduler.timers.size, 2);
  socket.onmessage?.({
    data: JSON.stringify({
      type: "answer",
      session_id: "00000000-0000-0000-0000-000000000002",
      negotiation_id: JSON.parse(socket.sent.filter((data) => JSON.parse(data).type === "offer").at(-1)!).negotiation_id,
      sdp: "restart-answer",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peerConnection.offerCalls, 4);
  assert.equal(scheduler.runNext(), 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peerConnection.offerCalls, 5);
  assert.equal([...scheduler.timers.values()].filter((timer) => timer.delay === 8_000).length, 1);
  client.close();
});

test("session recovery received during authentication is drained after reauthentication", async () => {
  const scheduler = new ManualScheduler();
  const connection = new MockConnection();
  const authGate = deferred<void>();
  let refreshCount = 0;
  const { client, sockets } = await connectedDesktop(scheduler, connection, undefined, {
    isSharingActive: () => true,
    refreshPresence: async () => {
      refreshCount += 1;
      if (refreshCount === 2) await authGate.promise;
    },
  });
  await client.setSharingState(true, false);
  connection.connectionState = "disconnected";
  connection.onconnectionstatechange?.();
  sockets[0]!.disconnect();
  assert.equal(scheduler.runNext(), 1_500);
  await new Promise((resolve) => setImmediate(resolve));
  const replacementSocket = sockets[1]!;
  replacementSocket.open();
  replacementSocket.onmessage?.({
    data: JSON.stringify({ type: "authenticated", role: "owner", device_id: "device" }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  replacementSocket.onmessage?.({
    data: JSON.stringify({
      type: "session_recovery",
      session_id: "00000000-0000-0000-0000-000000000002",
      recovery_attempt_id: "recovery-during-auth",
    }),
  });
  replacementSocket.onmessage?.({
    data: JSON.stringify({
      type: "session_recovery",
      session_id: "00000000-0000-0000-0000-000000000002",
      recovery_attempt_id: "recovery-during-auth",
    }),
  });
  assert.equal(connection.offerCalls, 1);

  authGate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.runNext(), 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connection.offerCalls, 2);
  client.close();
});

test("peer reconnect and disconnect during signaling loss defers a restart until reauthentication", async () => {
  const scheduler = new ManualScheduler();
  const connection = new MockConnection();
  const authGate = deferred<void>();
  let refreshCount = 0;
  const { client, sockets } = await connectedDesktop(scheduler, connection, undefined, {
    isSharingActive: () => true,
    refreshPresence: async () => {
      refreshCount += 1;
      if (refreshCount === 2) await authGate.promise;
    },
  });
  await client.setSharingState(true, false);
  sockets[0]!.disconnect();

  connection.connectionState = "connected";
  connection.onconnectionstatechange?.();
  assert.equal(client.lifecycle, "RECONNECTING");
  assert.ok([...scheduler.timers.values()].some((timer) => timer.delay === NETWORK_RECOVERY_TIMEOUT_MS));
  connection.connectionState = "disconnected";
  connection.onconnectionstatechange?.();
  assert.equal(connection.offerCalls, 1);

  assert.equal(scheduler.runNext(), 1_500);
  await new Promise((resolve) => setImmediate(resolve));
  const replacementSocket = sockets[1]!;
  replacementSocket.open();
  replacementSocket.onmessage?.({
    data: JSON.stringify({ type: "authenticated", role: "owner", device_id: "device" }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  authGate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(scheduler.runNext(), 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connection.offerCalls, 2);
  client.close();
});

test("same-session peer replacement rejects stale negotiation signaling", async () => {
  const scheduler = new ManualScheduler();
  const firstConnection = new MockConnection();
  const replacementConnection = new MockConnection();
  const connections = [firstConnection, replacementConnection];
  let peerFactoryCalls = 0;
  const { client, socket } = await connectedDesktop(scheduler, firstConnection, undefined, {
    peerFactory: () => connections[peerFactoryCalls++]!,
    isSharingActive: () => true,
  });
  const oldNegotiationId = JSON.parse(
    socket.sent.filter((data) => JSON.parse(data).type === "offer").at(-1)!,
  ).negotiation_id as string;
  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_rejoined",
      session_id: "00000000-0000-0000-0000-000000000002",
      viewer_user_id: "viewer",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  const currentOffer = JSON.parse(socket.sent.filter((data) => JSON.parse(data).type === "offer").at(-1)!);
  const newNegotiationId = currentOffer.negotiation_id as string;
  assert.notEqual(newNegotiationId, oldNegotiationId);
  assert.equal(firstConnection.closed, true);

  socket.onmessage?.({
    data: JSON.stringify({
      type: "answer",
      session_id: "00000000-0000-0000-0000-000000000002",
      negotiation_id: oldNegotiationId,
      sdp: "stale-answer",
    }),
  });
  socket.onmessage?.({
    data: JSON.stringify({
      type: "ice_candidate",
      session_id: "00000000-0000-0000-0000-000000000002",
      negotiation_id: oldNegotiationId,
      candidate: { candidate: "stale" },
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replacementConnection.remote, undefined);
  assert.equal(replacementConnection.candidateCalls, 0);

  socket.onmessage?.({
    data: JSON.stringify({
      type: "answer",
      session_id: "00000000-0000-0000-0000-000000000002",
      negotiation_id: newNegotiationId,
      sdp: "current-answer",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  socket.onmessage?.({
    data: JSON.stringify({
      type: "ice_candidate",
      session_id: "00000000-0000-0000-0000-000000000002",
      negotiation_id: newNegotiationId,
      candidate: { candidate: "current" },
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replacementConnection.candidateCalls, 1);
  assert.equal(client.lifecycle, "NEGOTIATING");
  client.close();
});

test("a delayed answer from a replaced peer cannot clear the current peer restart timer", async () => {
  const scheduler = new ManualScheduler();
  const firstConnection = new MockConnection();
  const replacementConnection = new MockConnection();
  let factoryCalls = 0;
  const { client, socket } = await connectedDesktop(
    scheduler,
    firstConnection,
    undefined,
    {
      peerFactory: () => factoryCalls++ === 0 ? firstConnection : replacementConnection,
    },
  );
  await client.setSharingState(true, false);
  firstConnection.connectionState = "disconnected";
  firstConnection.onconnectionstatechange?.();
  assert.equal(scheduler.runNext(), 8_000);
  await new Promise((resolve) => setImmediate(resolve));

  let resolveDelayedAnswer!: () => void;
  firstConnection.remoteDescriptionGate = new Promise<void>((resolve) => {
    resolveDelayedAnswer = resolve;
  });
  let resolveDelayedCandidate!: () => void;
  firstConnection.iceCandidateGate = new Promise<void>((resolve) => {
    resolveDelayedCandidate = resolve;
  });
  socket.onmessage?.({
    data: JSON.stringify({
      type: "answer",
      session_id: "00000000-0000-0000-0000-000000000002",
      sdp: "delayed-old-peer-answer",
    }),
  });
  socket.onmessage?.({
    data: JSON.stringify({
      type: "ice_candidate",
      session_id: "00000000-0000-0000-0000-000000000002",
      candidate: { candidate: "candidate:delayed-old-peer" },
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  await client.stopSharingSession();
  await client.setSharingState(true, false);
  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_joined",
      session_id: "00000000-0000-0000-0000-000000000003",
      viewer_user_id: "viewer",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  socket.onmessage?.({
    data: JSON.stringify({
      type: "answer",
      session_id: "00000000-0000-0000-0000-000000000003",
      sdp: "replacement-peer-answer",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  replacementConnection.connectionState = "connected";
  replacementConnection.onconnectionstatechange?.();
  replacementConnection.connectionState = "disconnected";
  replacementConnection.onconnectionstatechange?.();
  assert.equal(scheduler.runNext(), 8_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replacementConnection.offerCalls, 2);

  resolveDelayedAnswer();
  resolveDelayedCandidate();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replacementConnection.candidateCalls, 0);
  assert.equal(
    [...scheduler.timers.values()].filter((timer) => timer.delay === 8_000).length,
    1,
  );
  assert.equal(client.lifecycle, "RECONNECTING");
  client.close();
});

test("original SDP failure is retained through terminal cleanup with session context", async () => {
  const scheduler = new ManualScheduler();
  const connection = new MockConnection();
  const originalError = new Error("remote answer was rejected");
  connection.remoteDescriptionError = originalError;
  const reported: Error[] = [];
  const { client, socket } = await connectedDesktop(scheduler, connection, (error) => reported.push(error));

  socket.onmessage?.({
    data: JSON.stringify({
      type: "answer",
      session_id: "00000000-0000-0000-0000-000000000002",
      sdp: "answer",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  const failure = client.failure;
  assert.ok(failure);
  assert.match(failure.message, /sdp: Processing remote SDP answer failed/);
  assert.match(failure.message, /remote answer was rejected/);
  assert.match(failure.message, /session 00000000-0000-0000-0000-000000000002/);
  assert.equal((failure.cause as Error).cause, originalError);
  assert.equal(reported.length, 1);
  client.stopSharingSession();
  assert.equal(client.failure, failure);
  assert.equal(reported.length, 1);
  assert.equal(socket.readyState, 1);
  assert.deepEqual(JSON.parse(socket.sent.at(-1)!), {
    type: "sharing_state",
    screen: false,
    camera: false,
  });
  client.close();
});

test("peer failure diagnostic includes connection, ICE, signaling, and session state", async () => {
  const scheduler = new ManualScheduler();
  const connection = new MockConnection();
  const socket = new MockSocket();
  const diagnostics: Array<{
    event: string;
    message?: string;
    peer?: {
      connectionState?: string;
      iceConnectionState?: string;
      signalingState?: string;
      peerState?: string;
      sessionId: string;
    };
  }> = [];
  const client = new DesktopWebRtcClient({
    socketFactory: () => socket,
    peerFactory: () => connection,
    loadRefreshCredential: async () => "credential",
    reconnect: { scheduler },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
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

  connection.connectionState = "failed";
  connection.iceConnectionState = "failed";
  connection.onconnectionstatechange?.();
  assert.equal(client.lifecycle, "FAILED");
  const peer = diagnostics.find((diagnostic) => diagnostic.event === "peer" && diagnostic.peer?.peerState === "failed");
  assert.equal(peer?.peer?.connectionState, "failed");
  assert.equal(peer?.peer?.iceConnectionState, "failed");
  assert.equal(peer?.peer?.signalingState, "stable");
  assert.equal(peer?.peer?.sessionId, "00000000-0000-0000-0000-000000000002");
  const failure = diagnostics.find((diagnostic) => diagnostic.event === "failure");
  assert.ok(failure);
  assert.match(failure.message ?? "", /ice:/);
  assert.match(failure.message ?? "", /connection=failed, ice=failed/);
  assert.match(failure.message ?? "", /device device/);
  assert.match(failure.message ?? "", /session 00000000-0000-0000-0000-000000000002/);
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

test("desktop reconnects after retryable stale-presence closure and retains live approved tracks", async () => {
  const scheduler = new ManualScheduler();
  const connection = new MockConnection();
  const screenTrack: WebRtcTrack = { kind: "video", readyState: "live" };
  const cameraTrack: WebRtcTrack = { kind: "video", readyState: "live" };
  const { client, socket, sockets, connection: peerConnection } = await connectedDesktop(
    scheduler,
    connection,
    undefined,
    {
      isSharingActive: () => screenTrack.readyState === "live" && cameraTrack.readyState === "live",
      prepareOwnerPeer: async (peer) => {
        await peer.replaceTrack("screen", screenTrack);
        await peer.replaceTrack("camera", cameraTrack);
      },
    },
  );
  await client.setSharingState(true, true);

  socket.disconnect(1013);
  assert.equal(client.lifecycle, "RECONNECTING");
  assert.equal(peerConnection.closed, false);
  assert.equal(screenTrack.readyState, "live");
  assert.equal(cameraTrack.readyState, "live");
  assert.equal(scheduler.runNext(), 1_500);
  await new Promise((resolve) => setImmediate(resolve));
  sockets[1]!.open();
  sockets[1]!.onmessage?.({
    data: JSON.stringify({ type: "authenticated", role: "owner", device_id: "device" }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sockets.length, 2);
  assert.equal(peerConnection.closed, false);
  assert.deepEqual(peerConnection.replaceCalls, [
    { index: 0, track: screenTrack },
    { index: 1, track: cameraTrack },
  ]);
  client.close();
});

test("desktop retires its peer after retryable close when approved sharing is no longer active", async () => {
  const scheduler = new ManualScheduler();
  const connection = new MockConnection();
  const screenTrack: WebRtcTrack = { kind: "video", readyState: "live" };
  const cameraTrack: WebRtcTrack = { kind: "video", readyState: "live" };
  let sharingActive = true;
  const { client, socket, connection: peerConnection } = await connectedDesktop(
    scheduler,
    connection,
    undefined,
    {
      isSharingActive: () => sharingActive,
      prepareOwnerPeer: async (peer) => {
        await peer.replaceTrack("screen", screenTrack);
        await peer.replaceTrack("camera", cameraTrack);
      },
    },
  );
  await client.setSharingState(true, true);

  sharingActive = false;
  socket.disconnect(1013);
  assert.equal(peerConnection.closed, true);
  assert.equal(client.lifecycle, "CLOSED");
  client.close();
});

test("desktop remains terminal after authentication or policy close code 1008", async () => {
  const scheduler = new ManualScheduler();
  const connection = new MockConnection();
  const { client, socket, sockets, connection: peerConnection } = await connectedDesktop(
    scheduler,
    connection,
    undefined,
    { isSharingActive: () => true },
  );

  socket.disconnect(1008);

  assert.equal(client.lifecycle, "FAILED");
  assert.equal(peerConnection.closed, true);
  assert.equal(scheduler.timers.size, 0);
  assert.equal(sockets.length, 1);
  client.close();
});

test("owner reconnect retains approved tracks and restarts the same peer session", async () => {
  const scheduler = new ManualScheduler();
  const connection = new MockConnection();
  const diagnostics: DesktopDiagnostic[] = [];
  const { client, socket, sockets, connection: peerConnection } = await connectedDesktop(
    scheduler,
    connection,
    undefined,
    {
      isSharingActive: () => true,
      recoveryTimeoutMs: 120_000,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    },
  );
  await client.setSharingState(true, false);
  peerConnection.connectionState = "disconnected";
  peerConnection.onconnectionstatechange?.();
  socket.disconnect();

  assert.equal(peerConnection.closed, false);
  assert.equal(client.lifecycle, "RECONNECTING");
  assert.equal(scheduler.runNext(), 1_500);
  await new Promise((resolve) => setImmediate(resolve));
  sockets[1]!.open();
  sockets[1]!.onmessage?.({
    data: JSON.stringify({ type: "authenticated", role: "owner", device_id: "device" }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(diagnostics.some((diagnostic) =>
    diagnostic.event === "signaling_reconnected" &&
    diagnostic.sessionId === "00000000-0000-0000-0000-000000000002"));
  sockets[1]!.onmessage?.({
    data: JSON.stringify({
      type: "session_recovery",
      session_id: "00000000-0000-0000-0000-000000000002",
      recovery_attempt_id: "recovery-attempt-1",
    }),
  });
  assert.ok(diagnostics.some((diagnostic) =>
    diagnostic.event === "recovery" &&
    diagnostic.recoveryPhase === "session_recovery_received" &&
    diagnostic.recoveryAttemptId === "recovery-attempt-1" &&
    diagnostic.sessionId === "00000000-0000-0000-0000-000000000002"));
  assert.equal(scheduler.runNext(), 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peerConnection.offerCalls, 2);
  assert.equal(peerConnection.closed, false);
  const reconnectOffer = JSON.parse(sockets[1]!.sent.at(-1)!);
  const { negotiation_id: _reconnectNegotiationId, ...reconnectOfferWithoutId } = reconnectOffer;
  assert.equal(typeof _reconnectNegotiationId, "string");
  assert.deepEqual(reconnectOfferWithoutId, {
    type: "offer",
    session_id: "00000000-0000-0000-0000-000000000002",
    sdp: "owner-offer",
    track_map: [{ mid: "0", kind: "screen" }, { mid: "1", kind: "camera" }],
  });
  sockets[1]!.onmessage?.({
    data: JSON.stringify({
      type: "answer",
      session_id: "00000000-0000-0000-0000-000000000002",
      sdp: "restart-answer",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  peerConnection.connectionState = "connected";
  peerConnection.onconnectionstatechange?.();
  assert.equal(client.lifecycle, "CONNECTED");
  assert.ok(![...scheduler.timers.values()].some((timer) => timer.delay === 120_000));
  client.close();
});

test("owner recovery retains both approved media tracks on the existing peer", async () => {
  const scheduler = new ManualScheduler();
  const connection = new MockConnection();
  const screenTrack: WebRtcTrack = { kind: "video", readyState: "live" };
  const cameraTrack: WebRtcTrack = { kind: "video", readyState: "live" };
  const { client, socket, sockets, connection: peerConnection } = await connectedDesktop(
    scheduler,
    connection,
    undefined,
    {
      isSharingActive: () => true,
      prepareOwnerPeer: async (peer) => {
        await peer.replaceTrack("screen", screenTrack);
        await peer.replaceTrack("camera", cameraTrack);
      },
    },
  );
  await client.setSharingState(true, true);
  assert.deepEqual(peerConnection.replaceCalls, [
    { index: 0, track: screenTrack },
    { index: 1, track: cameraTrack },
  ]);

  peerConnection.connectionState = "disconnected";
  peerConnection.onconnectionstatechange?.();
  socket.disconnect();
  assert.equal(peerConnection.closed, false);
  assert.equal(screenTrack.readyState, "live");
  assert.equal(cameraTrack.readyState, "live");
  assert.equal(scheduler.runNext(), 1_500);
  await new Promise((resolve) => setImmediate(resolve));
  sockets[1]!.open();
  sockets[1]!.onmessage?.({
    data: JSON.stringify({ type: "authenticated", role: "owner", device_id: "device" }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  sockets[1]!.onmessage?.({
    data: JSON.stringify({
      type: "session_recovery",
      session_id: "00000000-0000-0000-0000-000000000002",
    }),
  });
  assert.equal(scheduler.runNext(), 0);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(peerConnection.closed, false);
  assert.equal(peerConnection.offerCalls, 2);
  assert.deepEqual(peerConnection.replaceCalls, [
    { index: 0, track: screenTrack },
    { index: 1, track: cameraTrack },
  ]);
  assert.equal(JSON.parse(sockets[1]!.sent.at(-1)!).type, "offer");
  client.close();
});

test("owner replaces its peer and approved tracks when a fresh viewer reattaches", async () => {
  const scheduler = new ManualScheduler();
  const originalConnection = new MockConnection();
  const connections: MockConnection[] = [originalConnection];
  const screenTrack: WebRtcTrack = { kind: "video", readyState: "live" };
  const cameraTrack: WebRtcTrack = { kind: "video", readyState: "live" };
  let peerFactoryCalls = 0;
  const { client, socket } = await connectedDesktop(
    scheduler,
    originalConnection,
    undefined,
    {
      isSharingActive: () => true,
      prepareOwnerPeer: async (peer) => {
        await peer.replaceTrack("screen", screenTrack);
        await peer.replaceTrack("camera", cameraTrack);
      },
      peerFactory: () => {
        if (peerFactoryCalls++ === 0) return originalConnection;
        const connection = new MockConnection();
        connections.push(connection);
        return connection;
      },
    },
  );
  await client.setSharingState(true, true);
  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_rejoined",
      session_id: "00000000-0000-0000-0000-000000000002",
      viewer_user_id: "viewer",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    originalConnection.closed,
    true,
    `owner peer was not replaced (lifecycle=${client.lifecycle}, peers=${connections.length})`,
  );
  assert.equal(connections.length, 2);
  assert.deepEqual(connections[1]!.replaceCalls, [
    { index: 0, track: screenTrack },
    { index: 1, track: cameraTrack },
  ]);
  assert.equal(connections[1]!.offerCalls, 1);
  const replacementOffer = JSON.parse(socket.sent.at(-1)!);
  const { negotiation_id: _replacementNegotiationId, ...replacementOfferWithoutId } = replacementOffer;
  assert.equal(typeof _replacementNegotiationId, "string");
  assert.deepEqual(replacementOfferWithoutId, {
    type: "offer",
    session_id: "00000000-0000-0000-0000-000000000002",
    sdp: "owner-offer",
    track_map: [{ mid: "0", kind: "screen" }, { mid: "1", kind: "camera" }],
  });
  client.close();
});

test("owner replaces the peer with the existing screen and camera tracks after repeated viewer leaves", async () => {
  const scheduler = new ManualScheduler();
  const connections: MockConnection[] = [new MockConnection()];
  const screenTrack: WebRtcTrack = { kind: "video", readyState: "live" };
  const cameraTrack: WebRtcTrack = { kind: "video", readyState: "live" };
  let peerFactoryCalls = 0;
  const { client, socket } = await connectedDesktop(
    scheduler,
    connections[0]!,
    undefined,
    {
      isSharingActive: () => true,
      prepareOwnerPeer: async (peer) => {
        await peer.replaceTrack("screen", screenTrack);
        await peer.replaceTrack("camera", cameraTrack);
      },
      peerFactory: () => {
        if (peerFactoryCalls++ === 0) return connections[0]!;
        const connection = new MockConnection();
        connections.push(connection);
        return connection;
      },
    },
  );
  await client.setSharingState(true, true);

  const sessionIds = [
    "00000000-0000-0000-0000-000000000003",
    "00000000-0000-0000-0000-000000000004",
    "00000000-0000-0000-0000-000000000005",
  ];
  for (const [index, sessionId] of sessionIds.entries()) {
    const previousPeer = connections[index]!;
    socket.onmessage?.({
      data: JSON.stringify({
        type: "viewer_left",
        session_id: index === 0
          ? "00000000-0000-0000-0000-000000000002"
          : sessionIds[index - 1],
        viewer_user_id: "viewer",
        reason: "closed",
      }),
    });
    assert.equal(previousPeer.closed, true);

    socket.onmessage?.({
      data: JSON.stringify({
        type: "viewer_joined",
        session_id: sessionId,
        viewer_user_id: "viewer",
      }),
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(connections.length, index + 2);
    assert.deepEqual(connections[index + 1]!.replaceCalls, [
      { index: 0, track: screenTrack },
      { index: 1, track: cameraTrack },
    ]);
    assert.equal(connections[index + 1]!.offerCalls, 1);
    const replacementOffer = JSON.parse(socket.sent.at(-1)!);
    const { negotiation_id: _replacementNegotiationId, ...replacementOfferWithoutId } = replacementOffer;
    assert.equal(typeof _replacementNegotiationId, "string");
    assert.deepEqual(replacementOfferWithoutId, {
      type: "offer",
      session_id: sessionId,
      sdp: "owner-offer",
      track_map: [{ mid: "0", kind: "screen" }, { mid: "1", kind: "camera" }],
    });
  }
  client.close();
});

test("viewer reconnect reattaches to the existing session without creating another peer", async () => {
  const scheduler = new ManualScheduler();
  const sockets: MockSocket[] = [];
  const connections: MockConnection[] = [];
  const diagnostics: Array<WebRtcDiagnostic | RecoveryDiagnostic | ClientSignalingDiagnostic> = [];
  const viewer = new ViewerWebRtcClient({
    socketFactory: () => {
      const socket = new MockSocket();
      sockets.push(socket);
      return socket;
    },
    peerFactory: () => {
      const connection = new MockConnection();
      connections.push(connection);
      return connection;
    },
    browserSessionToken: "browser-session-token",
    deviceId: "00000000-0000-0000-0000-000000000001",
    reconnect: { scheduler },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  viewer.start();
  sockets[0]!.open();
  sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "viewer" }) });
  await new Promise((resolve) => setImmediate(resolve));
  sockets[0]!.onmessage?.({
    data: JSON.stringify({
      type: "session_created",
      session_id: "00000000-0000-0000-0000-000000000002",
      device_id: "00000000-0000-0000-0000-000000000001",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  sockets[0]!.onmessage?.({
    data: JSON.stringify({
      type: "offer",
      session_id: "00000000-0000-0000-0000-000000000002",
      sdp: "v=0\r\na=mid:0\r\na=mid:1\r\n",
      track_map: [{ mid: "0", kind: "screen" }, { mid: "1", kind: "camera" }],
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  connections[0]!.connectionState = "connected";
  connections[0]!.onconnectionstatechange?.();
  sockets[0]!.disconnect();
  assert.ok([...scheduler.timers.values()].some((timer) => timer.delay === NETWORK_RECOVERY_TIMEOUT_MS));
  assert.equal(connections[0]!.closed, false);
  assert.equal(viewer.lifecycle, "RECONNECTING");
  assert.equal(scheduler.runNext(), 1_500);
  await new Promise((resolve) => setImmediate(resolve));
  sockets[1]!.open();
  sockets[1]!.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "viewer" }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.parse(sockets[1]!.sent.at(-1)!).type, "create_session");
  sockets[1]!.onmessage?.({
    data: JSON.stringify({
      type: "device_sharing_state",
      device_id: "00000000-0000-0000-0000-000000000001",
      screen: true,
      camera: false,
    }),
  });
  sockets[1]!.onmessage?.({
    data: JSON.stringify({
      type: "session_recovery",
      session_id: "00000000-0000-0000-0000-000000000002",
      recovery_attempt_id: "viewer-recovery-attempt-1",
    }),
  });
  assert.ok(diagnostics.some((diagnostic) =>
    "event" in diagnostic &&
    diagnostic.event === "recovery" &&
    diagnostic.phase === "session_recovery_received" &&
    diagnostic.recoveryAttemptId === "viewer-recovery-attempt-1" &&
    diagnostic.sessionId === "00000000-0000-0000-0000-000000000002"));
  assert.equal(connections.length, 1);
  assert.equal(connections[0]!.closed, false);
  assert.equal(viewer.lifecycle, "CONNECTED");
  viewer.close();
});

test("fresh viewer attaches to an existing session before immediate offer and ICE signaling", async () => {
  const sockets: MockSocket[] = [];
  const connections: MockConnection[] = [];
  const deviceId = "00000000-0000-0000-0000-000000000001";
  const sessionId = "00000000-0000-0000-0000-000000000002";
  const viewer = new ViewerWebRtcClient({
    socketFactory: () => {
      const socket = new MockSocket();
      sockets.push(socket);
      return socket;
    },
    peerFactory: () => {
      const connection = new MockConnection();
      connections.push(connection);
      return connection;
    },
    browserSessionToken: "browser-session-token",
    deviceId,
  });

  viewer.start();
  sockets[0]!.open();
  sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "viewer" }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(sockets[0]!.sent.at(-1)!), {
    type: "create_session",
    device_id: deviceId,
  });
  sockets[0]!.onmessage?.({
    data: JSON.stringify({
      type: "session_attached",
      session_id: sessionId,
      device_id: deviceId,
      screen: true,
      camera: true,
    }),
  });
  assert.equal(connections.length, 1);
  assert.equal(viewer.lifecycle, "NEGOTIATING");
  sockets[0]!.onmessage?.({
    data: JSON.stringify({
      type: "offer",
      session_id: sessionId,
      sdp: "v=0\r\na=mid:0\r\na=mid:1\r\n",
      track_map: [{ mid: "0", kind: "screen" }, { mid: "1", kind: "camera" }],
    }),
  });
  sockets[0]!.onmessage?.({
    data: JSON.stringify({
      type: "ice_candidate",
      session_id: sessionId,
      candidate: { candidate: "candidate:immediate" },
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(viewer.lifecycle, "NEGOTIATING");
  assert.equal(connections[0]!.answerCalls, 1);
  assert.equal(connections[0]!.candidateCalls, 1);
  assert.ok(sockets[0]!.sent.some((data) => JSON.parse(data).type === "answer"));
  viewer.close();
});

test("recoverable attachment waits beyond initial negotiation deadline and resumes before grace expires", async () => {
  const socket = new MockSocket();
  const scheduler = new ManualScheduler();
  const connections: MockConnection[] = [];
  const deviceId = "00000000-0000-0000-0000-000000000001";
  const sessionId = "00000000-0000-0000-0000-000000000002";
  const viewer = new ViewerWebRtcClient({
    socketFactory: () => socket,
    peerFactory: () => {
      const connection = new MockConnection();
      connections.push(connection);
      return connection;
    },
    browserSessionToken: "browser-session-token",
    deviceId,
    reconnect: { scheduler },
  });
  viewer.start();
  socket.open();
  socket.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "viewer" }) });
  await new Promise((resolve) => setImmediate(resolve));
  socket.onmessage?.({
    data: JSON.stringify({
      type: "session_attached",
      session_id: sessionId,
      device_id: deviceId,
      screen: true,
      camera: true,
      owner_recovery_remaining_ms: 90_000,
    }),
  });
  assert.equal(viewer.lifecycle, "RECONNECTING");
  assert.equal(connections.length, 1);
  assert.equal([...scheduler.timers.values()].some((timer) => timer.delay === 30_000), false);

  scheduler.nowValue = 30_001;
  assert.equal(viewer.lifecycle, "RECONNECTING");
  socket.onmessage?.({
    data: JSON.stringify({ type: "session_recovery", session_id: sessionId }),
  });
  assert.equal(viewer.lifecycle, "NEGOTIATING");
  assert.equal(connections.length, 1);
  socket.onmessage?.({
    data: JSON.stringify({
      type: "offer",
      session_id: sessionId,
      sdp: "v=0\r\na=mid:0\r\na=mid:1\r\n",
      track_map: [{ mid: "0", kind: "screen" }, { mid: "1", kind: "camera" }],
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connections[0]?.answerCalls, 1);
  assert.ok(socket.sent.some((data) => JSON.parse(data).type === "answer"));

  connections[0]!.connectionState = "connected";
  connections[0]!.onconnectionstatechange?.();
  assert.equal(viewer.lifecycle, "CONNECTED");
  assert.equal(connections.length, 1);
  viewer.close();
});

test("recoverable attachment retires its peer when owner recovery grace expires and accepts a later session", async () => {
  const socket = new MockSocket();
  const scheduler = new ManualScheduler();
  const failures: Error[] = [];
  const connections: MockConnection[] = [];
  const diagnostics: Array<WebRtcDiagnostic | RecoveryDiagnostic | ClientSignalingDiagnostic> = [];
  const deviceId = "00000000-0000-0000-0000-000000000001";
  const sessionId = "00000000-0000-0000-0000-000000000002";
  const viewer = new ViewerWebRtcClient({
    socketFactory: () => socket,
    peerFactory: () => {
      const connection = new MockConnection();
      connections.push(connection);
      return connection;
    },
    browserSessionToken: "browser-session-token",
    deviceId,
    reconnect: { scheduler },
    onTerminalError: (error) => failures.push(error),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  viewer.start();
  socket.open();
  socket.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "viewer" }) });
  await new Promise((resolve) => setImmediate(resolve));
  socket.onmessage?.({
    data: JSON.stringify({
      type: "session_attached",
      session_id: sessionId,
      device_id: deviceId,
      screen: true,
      camera: false,
      owner_recovery_remaining_ms: 45_000,
    }),
  });
  assert.equal(viewer.lifecycle, "RECONNECTING");

  scheduler.runDelay(45_000);

  assert.equal(viewer.lifecycle, "RECONNECTING");
  assert.equal(viewer.failure, undefined);
  assert.equal(failures.length, 0);
  assert.equal(connections[0]!.closed, true);
  assert.equal(socket.readyState, 1);
  assert.equal(
    socket.sent.filter((data) => JSON.parse(data).type === "create_session").length,
    1,
  );

  socket.onmessage?.({
    data: JSON.stringify({
      type: "device_sharing_state",
      device_id: deviceId,
      screen: true,
      camera: true,
    }),
  });
  assert.equal(
    socket.sent.filter((data) => JSON.parse(data).type === "create_session").length,
    2,
  );
  socket.onmessage?.({
    data: JSON.stringify({
      type: "session_created",
      session_id: "00000000-0000-0000-0000-000000000003",
      device_id: deviceId,
    }),
  });
  assert.equal(connections.length, 2);
  assert.equal(connections[1]!.closed, false);

  socket.onmessage?.({
    data: JSON.stringify({
      type: "offer",
      session_id: sessionId,
      negotiation_id: "expired-negotiation",
      sdp: "stale-offer",
      track_map: [{ mid: "0", kind: "screen" }, { mid: "1", kind: "camera" }],
    }),
  });
  assert.equal(viewer.lifecycle, "NEGOTIATING");
  assert.equal(connections[1]!.answerCalls, 0);
  assert.equal(viewer.failure, undefined);
  assert.ok(diagnostics.some((diagnostic) =>
    "phase" in diagnostic &&
    diagnostic.phase === "stale_session_signaling_ignored" &&
    diagnostic.sessionId === sessionId));
  viewer.close();
});

test("viewer recovers from repeated recovery timeouts without refreshing or duplicating sessions", async () => {
  const scheduler = new ManualScheduler();
  const socket = new MockSocket();
  const connections: MockConnection[] = [];
  const remoteTracks: Array<{ track: WebRtcTrack; kind?: "screen" | "camera" }> = [];
  const failures: Error[] = [];
  const diagnostics: Array<WebRtcDiagnostic | RecoveryDiagnostic | ClientSignalingDiagnostic> = [];
  const deviceId = "00000000-0000-0000-0000-000000000001";
  const sessionIds = [
    "00000000-0000-0000-0000-000000000002",
    "00000000-0000-0000-0000-000000000003",
    "00000000-0000-0000-0000-000000000004",
  ];
  let socketFactoryCalls = 0;
  const viewer = new ViewerWebRtcClient({
    socketFactory: () => {
      socketFactoryCalls += 1;
      return socket;
    },
    peerFactory: () => {
      const connection = new MockConnection();
      connections.push(connection);
      return connection;
    },
    browserSessionToken: "browser-session-token",
    deviceId,
    reconnect: { scheduler },
    onTerminalError: (error) => failures.push(error),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  viewer.onRemoteTrack = (track, _mid, kind) => {
    if (kind) remoteTracks.push({ track, kind });
  };

  viewer.start();
  socket.open();
  socket.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "viewer" }) });
  await new Promise((resolve) => setImmediate(resolve));

  const createSessionCount = (): number =>
    socket.sent.filter((data) => JSON.parse(data).type === "create_session").length;
  const negotiate = async (sessionId: string, negotiationId: string): Promise<void> => {
    socket.onmessage?.({
      data: JSON.stringify({ type: "session_created", session_id: sessionId, device_id: deviceId }),
    });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "offer",
        session_id: sessionId,
        negotiation_id: negotiationId,
        sdp: "v=0\r\na=mid:0\r\na=mid:1\r\n",
        track_map: [{ mid: "0", kind: "screen" }, { mid: "1", kind: "camera" }],
      }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(connections.at(-1)!.answerCalls, 1);
    assert.ok(socket.sent.some((data) => {
      const message = JSON.parse(data);
      return message.type === "answer" &&
        message.session_id === sessionId &&
        message.negotiation_id === negotiationId;
    }));
    for (const [kind, mid] of [["screen", "0"], ["camera", "1"]] as const) {
      const track: WebRtcTrack = { kind: "video", readyState: "live" };
      connections.at(-1)!.ontrack?.({ track, transceiver: { mid } });
      assert.equal(remoteTracks.at(-1)?.track, track);
      assert.equal(remoteTracks.at(-1)?.kind, kind);
    }
    connections.at(-1)!.connectionState = "connected";
    connections.at(-1)!.onconnectionstatechange?.();
    assert.equal(viewer.lifecycle, "CONNECTED");
  };

  assert.equal(createSessionCount(), 1);
  await negotiate(sessionIds[0]!, "negotiation-0");
  for (let cycle = 0; cycle < 2; cycle += 1) {
    const expiredSessionId = sessionIds[cycle]!;
    const expiredPeer = connections[cycle]!;
    expiredPeer.connectionState = "disconnected";
    expiredPeer.onconnectionstatechange?.();
    scheduler.runDelay(NETWORK_RECOVERY_TIMEOUT_MS);

    assert.equal(viewer.lifecycle, "RECONNECTING");
    assert.equal(viewer.failure, undefined);
    assert.equal(expiredPeer.closed, true);
    assert.equal(socket.readyState, 1);

    socket.onmessage?.({
      data: JSON.stringify({
        type: "ice_candidate",
        session_id: expiredSessionId,
        negotiation_id: `negotiation-${cycle}`,
        candidate: { candidate: "candidate:stale" },
      }),
    });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "answer",
        session_id: expiredSessionId,
        negotiation_id: `negotiation-${cycle}`,
        sdp: "stale-answer",
      }),
    });
    assert.equal(viewer.lifecycle, "RECONNECTING");
    assert.equal(viewer.failure, undefined);
    assert.equal(
      diagnostics.filter((diagnostic) =>
        "phase" in diagnostic &&
        diagnostic.phase === "stale_session_signaling_ignored" &&
        diagnostic.sessionId === expiredSessionId).length,
      2,
    );

    socket.onmessage?.({
      data: JSON.stringify({
        type: "device_sharing_state",
        device_id: deviceId,
        screen: true,
        camera: true,
      }),
    });
    socket.onmessage?.({
      data: JSON.stringify({
        type: "device_sharing_state",
        device_id: deviceId,
        screen: true,
        camera: true,
      }),
    });
    assert.equal(createSessionCount(), cycle + 2);

    await negotiate(sessionIds[cycle + 1]!, `negotiation-${cycle + 1}`);
    assert.equal(connections.length, cycle + 2);
  }

  assert.equal(socketFactoryCalls, 1);
  assert.equal(createSessionCount(), 3);
  assert.equal(connections.length, 3);
  assert.equal(failures.length, 0);
  viewer.close();
});

test("reconnect retires replaced session signaling but still rejects unknown session IDs", async () => {
  const scheduler = new ManualScheduler();
  const sockets: MockSocket[] = [];
  const connections: MockConnection[] = [];
  const diagnostics: Array<WebRtcDiagnostic | RecoveryDiagnostic | ClientSignalingDiagnostic> = [];
  const viewer = new ViewerWebRtcClient({
    socketFactory: () => {
      const socket = new MockSocket();
      sockets.push(socket);
      return socket;
    },
    peerFactory: () => {
      const connection = new MockConnection();
      connections.push(connection);
      return connection;
    },
    browserSessionToken: "browser-session-token",
    deviceId: "00000000-0000-0000-0000-000000000001",
    reconnect: { scheduler },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  const oldSessionId = "00000000-0000-0000-0000-000000000002";
  const currentSessionId = "00000000-0000-0000-0000-000000000003";
  viewer.start();
  sockets[0]!.open();
  sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "viewer" }) });
  sockets[0]!.onmessage?.({
    data: JSON.stringify({
      type: "session_created",
      session_id: oldSessionId,
      device_id: "00000000-0000-0000-0000-000000000001",
    }),
  });
  sockets[0]!.onmessage?.({
    data: JSON.stringify({
      type: "offer",
      session_id: oldSessionId,
      sdp: "v=0\r\na=mid:0\r\na=mid:1\r\n",
      track_map: [{ mid: "0", kind: "screen" }, { mid: "1", kind: "camera" }],
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  connections[0]!.connectionState = "connected";
  connections[0]!.onconnectionstatechange?.();
  sockets[0]!.disconnect();
  assert.equal(scheduler.runNext(), 1_500);
  await new Promise((resolve) => setImmediate(resolve));
  sockets[1]!.open();
  sockets[1]!.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "viewer" }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(sockets[1]!.sent.at(-1)!), {
    type: "create_session",
    device_id: "00000000-0000-0000-0000-000000000001",
    active_session_id: oldSessionId,
  });
  sockets[1]!.onmessage?.({
    data: JSON.stringify({
      type: "session_created",
      session_id: currentSessionId,
      device_id: "00000000-0000-0000-0000-000000000001",
    }),
  });
  assert.equal(connections.length, 2);
  assert.equal(connections[0]!.closed, true);
  sockets[1]!.onmessage?.({
    data: JSON.stringify({
      type: "ice_candidate",
      session_id: oldSessionId,
      candidate: { candidate: "candidate:stale" },
    }),
  });
  assert.equal(viewer.lifecycle, "NEGOTIATING");
  assert.ok(diagnostics.some((diagnostic) =>
    "event" in diagnostic &&
    diagnostic.event === "recovery" &&
    diagnostic.phase === "stale_session_signaling_ignored" &&
    diagnostic.sessionId === oldSessionId));
  sockets[1]!.onmessage?.({
    data: JSON.stringify({
      type: "ice_candidate",
      session_id: "00000000-0000-0000-0000-000000000004",
      candidate: { candidate: "candidate:unknown" },
    }),
  });
  assert.equal(viewer.lifecycle, "FAILED");
  viewer.close();
});

async function createSleepMarkedViewer(): Promise<{
  viewer: ViewerWebRtcClient;
  scheduler: ManualScheduler;
  sockets: MockSocket[];
  connections: MockConnection[];
  sessionId: string;
}> {
  const scheduler = new ManualScheduler();
  const sockets: MockSocket[] = [];
  const connections: MockConnection[] = [];
  const sessionId = "00000000-0000-0000-0000-000000000002";
  const deviceId = "00000000-0000-0000-0000-000000000001";
  const viewer = new ViewerWebRtcClient({
    socketFactory: () => {
      const socket = new MockSocket();
      sockets.push(socket);
      return socket;
    },
    peerFactory: () => {
      const connection = new MockConnection();
      connections.push(connection);
      return connection;
    },
    browserSessionToken: "browser-session-token",
    deviceId,
    reconnect: { scheduler, recoveryTimeoutMs: 60_000 },
  });
  viewer.start();
  sockets[0]!.open();
  sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "viewer" }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(sockets[0]!.sent.at(-1)!), {
    type: "create_session",
    device_id: deviceId,
  });
  sockets[0]!.onmessage?.({
    data: JSON.stringify({ type: "session_created", session_id: sessionId, device_id: deviceId }),
  });
  sockets[0]!.onmessage?.({
    data: JSON.stringify({
      type: "offer",
      session_id: sessionId,
      sdp: "v=0\r\na=mid:0\r\na=mid:1\r\n",
      track_map: [{ mid: "0", kind: "screen" }, { mid: "1", kind: "camera" }],
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  connections[0]!.connectionState = "connected";
  connections[0]!.onconnectionstatechange?.();
  sockets[0]!.onmessage?.({
    data: JSON.stringify({
      type: "sleep_marked",
      session_id: sessionId,
      epoch: 1,
      capability: "viewer-resume-capability",
      expires_at: 60_000,
      request_id: "sleep-request",
    }),
  });
  return { viewer, scheduler, sockets, connections, sessionId };
}

test("viewer reconnect during sleep resumes the saved session exactly once", async () => {
  const { viewer, scheduler, sockets, connections, sessionId } = await createSleepMarkedViewer();
  sockets[0]!.disconnect();
  assert.equal(scheduler.runNext(), 1_500);
  await new Promise((resolve) => setImmediate(resolve));
  sockets[1]!.open();
  sockets[1]!.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "viewer" }) });
  sockets[1]!.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "viewer" }) });
  await new Promise((resolve) => setImmediate(resolve));

  const resumeMessages = sockets[1]!.sent
    .map((data) => JSON.parse(data) as Record<string, unknown>)
    .filter((message) => message.type === "resume_session");
  assert.equal(resumeMessages.length, 1);
  assert.equal(resumeMessages[0]?.session_id, sessionId);
  assert.equal(resumeMessages[0]?.capability, "viewer-resume-capability");
  assert.equal(sockets[1]!.sent.some((data) => JSON.parse(data).type === "create_session"), false);

  sockets[1]!.onmessage?.({
    data: JSON.stringify({
      type: "resume_pending",
      session_id: sessionId,
      epoch: 1,
      capability: "rotated-viewer-capability",
      expires_at: 60_000,
      request_id: resumeMessages[0]?.request_id,
    }),
  });
  sockets[1]!.onmessage?.({
    data: JSON.stringify({ type: "session_resumed", session_id: sessionId, epoch: 1 }),
  });
  assert.equal(connections.length, 1);
  assert.equal(connections[0]!.closed, false);
  assert.equal(
    sockets[1]!.sent.filter((data) => JSON.parse(data).type === "resume_session").length,
    1,
  );
  viewer.close();
});

test("viewer retries a lost sleep-resume acknowledgement idempotently", async () => {
  const { viewer, scheduler, sockets, sessionId } = await createSleepMarkedViewer();
  sockets[0]!.disconnect();
  assert.equal(scheduler.runNext(), 1_500);
  await new Promise((resolve) => setImmediate(resolve));
  sockets[1]!.open();
  sockets[1]!.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "viewer" }) });
  await new Promise((resolve) => setImmediate(resolve));
  const firstResume = JSON.parse(sockets[1]!.sent.at(-1)!) as Record<string, unknown>;
  assert.equal(firstResume.type, "resume_session");

  sockets[1]!.disconnect();
  assert.equal(scheduler.runNext(), 3_000);
  await new Promise((resolve) => setImmediate(resolve));
  sockets[2]!.open();
  sockets[2]!.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "viewer" }) });
  await new Promise((resolve) => setImmediate(resolve));
  const retriedResume = JSON.parse(sockets[2]!.sent.at(-1)!) as Record<string, unknown>;

  assert.equal(retriedResume.type, "resume_session");
  assert.equal(retriedResume.session_id, sessionId);
  assert.equal(retriedResume.capability, firstResume.capability);
  assert.equal(retriedResume.request_id, firstResume.request_id);
  assert.equal(sockets[2]!.sent.filter((data) => JSON.parse(data).type === "create_session").length, 0);
  viewer.close();
});

test("expired viewer sleep-resume capability fails closed without creating a new session", async () => {
  const { viewer, scheduler, sockets } = await createSleepMarkedViewer();
  scheduler.nowValue = 60_000;
  sockets[0]!.disconnect();
  assert.equal(scheduler.runNext(), 1_500);
  await new Promise((resolve) => setImmediate(resolve));
  sockets[1]!.open();
  sockets[1]!.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "viewer" }) });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(viewer.lifecycle, "FAILED");
  assert.equal(sockets[1]!.sent.some((data) => JSON.parse(data).type === "create_session"), false);
  assert.equal(sockets[1]!.sent.some((data) => JSON.parse(data).type === "resume_session"), false);
  viewer.close();
});

test("rejected viewer sleep-resume capability remains failed and is not bypassed", async () => {
  const { viewer, scheduler, sockets } = await createSleepMarkedViewer();
  sockets[0]!.disconnect();
  assert.equal(scheduler.runNext(), 1_500);
  await new Promise((resolve) => setImmediate(resolve));
  sockets[1]!.open();
  sockets[1]!.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "viewer" }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.parse(sockets[1]!.sent.at(-1)!).type, "resume_session");

  sockets[1]!.onmessage?.({ data: JSON.stringify({ type: "error", code: "RESUME_INVALID" }) });
  assert.equal(viewer.lifecycle, "FAILED");
  assert.equal(sockets[1]!.sent.some((data) => JSON.parse(data).type === "create_session"), false);
  assert.equal(
    sockets[1]!.sent.filter((data) => JSON.parse(data).type === "resume_session").length,
    1,
  );
  assert.match(viewer.failure?.message ?? "", /RESUME_INVALID/);
  viewer.close();
});

test("a fresh desktop client after restart starts idle and requires local sharing activation", async () => {
  const socket = new MockSocket();
  socket.authenticationManaged = true;
  const connection = new MockConnection();
  const client = new DesktopWebRtcClient({
    socketFactory: () => socket,
    peerFactory: () => connection,
    managedAuthentication: true,
    loadManagedIceServers: async () => ({ iceServers: [] }),
    isSharingActive: () => false,
  });
  await client.start();
  socket.open();
  socket.onmessage?.({
    data: JSON.stringify({ type: "authenticated", role: "owner", device_id: "device" }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.lifecycle, "CONNECTING");
  assert.deepEqual(JSON.parse(socket.sent.at(-1)!), {
    type: "sharing_state",
    screen: false,
    camera: false,
  });
  socket.onmessage?.({
    data: JSON.stringify({
      type: "session_recovery",
      session_id: "00000000-0000-0000-0000-000000000002",
    }),
  });
  assert.equal(connection.offerCalls, 0);
  await client.setSharingState(true, false);
  assert.deepEqual(JSON.parse(socket.sent.at(-1)!), {
    type: "sharing_state",
    screen: true,
    camera: false,
  });
  client.close();
});

test("lost backend session is replaced only after a new authorized viewer session joins", async () => {
  const socket = new MockSocket();
  const connections: MockConnection[] = [];
  const diagnostics: DesktopDiagnostic[] = [];
  const deviceId = "00000000-0000-0000-0000-000000000001";
  const client = new DesktopWebRtcClient({
    socketFactory: () => socket,
    peerFactory: () => {
      const connection = new MockConnection();
      connections.push(connection);
      return connection;
    },
    loadRefreshCredential: async () => "credential",
    isSharingActive: () => true,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  await client.start();
  socket.open();
  socket.onmessage?.({
    data: JSON.stringify({ type: "authenticated", role: "owner", device_id: deviceId }),
  });
  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_joined",
      session_id: "00000000-0000-0000-0000-000000000002",
      viewer_user_id: "viewer",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  socket.onmessage?.({
    data: JSON.stringify({
      type: "answer",
      session_id: "00000000-0000-0000-0000-000000000002",
      sdp: "initial-answer",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  connections[0]!.connectionState = "connected";
  connections[0]!.onconnectionstatechange?.();
  await client.setSharingState(true, false);

  socket.onmessage?.({
    data: JSON.stringify({
      type: "sharing_state_updated",
      device_id: deviceId,
      screen: true,
      camera: false,
    }),
  });
  assert.equal(connections[0]!.closed, true);
  assert.equal(client.lifecycle, "IDLE", JSON.stringify(diagnostics));
  assert.equal(connections.length, 1);

  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_joined",
      session_id: "00000000-0000-0000-0000-000000000003",
      viewer_user_id: "viewer",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connections.length, 2);
  assert.equal(connections[1]!.closed, false);
  assert.equal(client.lifecycle, "NEGOTIATING");
  client.close();
});
