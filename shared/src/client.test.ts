import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DesktopWebRtcClient,
  INITIAL_NEGOTIATION_TIMEOUT_MS,
  MAX_PENDING_SESSION_RETIREMENTS,
  ViewerWebRtcClient,
  type DesktopDiagnostic,
  type ClientSignalingDiagnostic,
  NETWORK_RECOVERY_TIMEOUT_MS,
  type RecoveryDiagnostic,
  type SignalingSocket,
  type ClientScheduler,
} from "./client.js";
import { parseServerMessage } from "./protocol.js";
import {
  attachApprovedTracks,
  handleTerminalCaptureFailure,
  invalidateCapture,
  stopCapturedTracks,
  stopOwnerCapture,
} from "../../apps/desktop/src/renderer/sharing-status.js";
import { createSignalingSocket } from "../../apps/desktop/src/renderer/signaling-socket.js";
import type { LivePresenceBridge, SocketEvent } from "../../apps/desktop/src/ipc-contract.js";
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
  offerGate: Promise<void> | undefined;
  localDescriptionGate: Promise<void> | undefined;
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
    await this.offerGate;
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
    await this.localDescriptionGate;
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
  connectionGeneration?: number;
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

  send(data: string, _peerGeneration?: number, isCurrent?: () => boolean): void {
    if (isCurrent && !isCurrent()) throw new Error("signaling message belongs to a superseded peer");
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

function createSessionRequestId(socket: MockSocket): string {
  const request = [...socket.sent]
    .reverse()
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .find((message) => message.type === "create_session");
  assert.equal(typeof request?.request_id, "string");
  return request!.request_id as string;
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

async function createConnectedViewer(
  scheduler: ManualScheduler,
  configurePeer: (connection: MockConnection, index: number) => void = () => {},
) {
  const socket = new MockSocket();
  const connections: MockConnection[] = [];
  const sessionId = "00000000-0000-0000-0000-000000000002";
  const deviceId = "00000000-0000-0000-0000-000000000001";
  const viewer = new ViewerWebRtcClient({
    socketFactory: () => socket,
    peerFactory: () => {
      const connection = new MockConnection();
      connections.push(connection);
      configurePeer(connection, connections.length - 1);
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
      type: "session_created",
      session_id: sessionId,
      device_id: deviceId,
      request_id: createSessionRequestId(socket),
    }),
  });
  socket.onmessage?.({
    data: JSON.stringify({
      type: "offer",
      session_id: sessionId,
      negotiation_id: "negotiation-1",
      sdp: "v=0\r\na=mid:0\r\na=mid:1\r\n",
      track_map: [{ mid: "0", kind: "screen" }, { mid: "1", kind: "camera" }],
    }),
  });
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connections[0]?.answerCalls, 1);
  connections[0]!.connectionState = "connected";
  connections[0]!.onconnectionstatechange?.();
  assert.equal(viewer.lifecycle, "CONNECTED");

  return { viewer, socket, connections, sessionId, deviceId };
}

test("viewer retires a temporary-disconnect session and attaches to a fresh authorized session", async () => {
  const scheduler = new ManualScheduler();
  const socket = new MockSocket();
  const connections: MockConnection[] = [];
  const sessionId = "00000000-0000-0000-0000-000000000002";
  const deviceId = "00000000-0000-0000-0000-000000000001";
  const viewer = new ViewerWebRtcClient({
    socketFactory: () => socket,
    peerFactory: () => {
      const peer = new MockConnection();
      connections.push(peer);
      return peer;
    },
    browserSessionToken: "browser-session-token",
    deviceId,
    reconnect: { scheduler },
  });
  viewer.start();
  socket.open();
  socket.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "viewer" }) });
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(socket.sent.filter((raw) => JSON.parse(raw).type === "create_session").length, 1);
  socket.onmessage?.({
    data: JSON.stringify({
      type: "session_created",
      session_id: sessionId,
      device_id: deviceId,
      request_id: createSessionRequestId(socket),
    }),
  });
  socket.onmessage?.({
    data: JSON.stringify({
      type: "offer",
      session_id: sessionId,
      negotiation_id: "negotiation-1",
      sdp: "v=0\r\na=mid:0\r\na=mid:1\r\n",
      track_map: [{ mid: "0", kind: "screen" }, { mid: "1", kind: "camera" }],
    }),
  });
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  connections[0]!.connectionState = "connected";
  connections[0]!.onconnectionstatechange?.();
  assert.equal(viewer.lifecycle, "CONNECTED");

  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_left",
      session_id: sessionId,
      viewer_user_id: "viewer",
      reason: "temporary_disconnect",
    }),
  });

  assert.equal(connections[0]!.closed, true);
  assert.equal(viewer.lifecycle, "RECONNECTING");
  assert.equal(scheduler.timers.size, 0);
  assert.equal(
    socket.sent.filter((raw) => JSON.parse(raw).type === "create_session").length,
    2,
  );
  assert.notEqual(viewer.lifecycle, "FAILED");

  const nextSessionId = "00000000-0000-0000-0000-000000000003";
  socket.onmessage?.({
    data: JSON.stringify({
      type: "session_created",
      session_id: nextSessionId,
      device_id: deviceId,
      request_id: createSessionRequestId(socket),
    }),
  });
  socket.onmessage?.({
    data: JSON.stringify({
      type: "offer",
      session_id: nextSessionId,
      negotiation_id: "fresh-negotiation",
      sdp: "v=0\r\na=mid:0\r\na=mid:1\r\n",
      track_map: [{ mid: "0", kind: "screen" }, { mid: "1", kind: "camera" }],
    }),
  });
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(connections.length, 2);
  assert.equal(connections[1]!.answerCalls, 1);
  connections[1]!.connectionState = "connected";
  connections[1]!.onconnectionstatechange?.();
  assert.equal(viewer.lifecycle, "CONNECTED");

  socket.onmessage?.({
    data: JSON.stringify({
      type: "offer",
      session_id: sessionId,
      negotiation_id: "stale-negotiation",
      sdp: "stale-offer",
      track_map: [{ mid: "0", kind: "screen" }, { mid: "1", kind: "camera" }],
    }),
  });
  assert.equal(connections.length, 2);
  viewer.close();
});

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
  await new Promise((resolve) => setImmediate(resolve));
  viewerSocket.onmessage?.({
    data: JSON.stringify({
      type: "session_created",
      session_id: "00000000-0000-0000-0000-000000000002",
      device_id: "00000000-0000-0000-0000-000000000001",
      request_id: createSessionRequestId(viewerSocket),
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
      request_id: "stale-request-id",
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
  const diagnostics: DesktopDiagnostic[] = [];
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
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

  await client.start();
  sockets[0]!.open();
  sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "owner", device_id: "device" }) });
  await new Promise((resolve) => setImmediate(resolve));
  sockets[0]!.close();
  assert.equal(
    diagnostics.some((diagnostic) => diagnostic.event === "reconnect_scheduled"),
    true,
  );
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

test("a superseded pending renderer adapter clears the shared socket and reconnects", async () => {
  const scheduler = new ManualScheduler();
  const connects: Array<ReturnType<typeof deferred<number>>> = [];
  const listeners: Array<(event: SocketEvent) => void> = [];
  const rendererDiagnostics: Array<Record<string, unknown>> = [];
  const clientDiagnostics: DesktopDiagnostic[] = [];
  const bridge: Pick<
    LivePresenceBridge,
    "connectSignaling" | "sendSignaling" | "closeSignaling" | "onSocketEvent"
  > = {
    connectSignaling: () => {
      const request = deferred<number>();
      connects.push(request);
      return request.promise;
    },
    sendSignaling: async () => {},
    closeSignaling: () => {},
    onSocketEvent: (callback) => {
      listeners.push(callback);
      return () => {
        const index = listeners.indexOf(callback);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
  };
  const adapters: SignalingSocket[] = [];
  const client = new DesktopWebRtcClient({
    socketFactory: () => {
      const socket = createSignalingSocket(bridge, (_level, event) => rendererDiagnostics.push(event));
      adapters.push(socket);
      return socket;
    },
    peerFactory: () => new MockConnection(),
    managedAuthentication: true,
    reconnect: { scheduler, maxAttempts: 2 },
    onDiagnostic: (diagnostic) => clientDiagnostics.push(diagnostic),
  });

  await client.start();
  assert.equal(clientDiagnostics.some((item) => item.event === "client_start_requested"), true);
  assert.equal(clientDiagnostics.some((item) => item.event === "socket_adapter_created"), true);
  assert.equal(clientDiagnostics.some((item) => item.event === "socket_connect_invoked"), true);
  assert.equal(connects.length, 1);
  const replacement = createSignalingSocket(bridge, (_level, event) => rendererDiagnostics.push(event));
  replacement.connect?.();
  assert.equal(connects.length, 2);

  connects[0]!.resolve(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(adapters[0]!.readyState, 3);
  assert.equal(clientDiagnostics.some((item) => item.event === "socket_reference_cleared"), true);
  assert.equal(clientDiagnostics.some((item) => item.event === "reconnect_scheduled"), true);
  assert.equal(
    rendererDiagnostics.some((item) =>
      item.event === "renderer_connection_generation_association_rejected"),
    true,
  );

  client.setSharingState(true, false);
  assert.equal(
    clientDiagnostics.some((item) =>
      item.event === "publication_attempted_without_socket"),
    true,
  );
  scheduler.runNext();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    clientDiagnostics.some((item) => item.event === "reconnect_attempt_started"),
    true,
  );
  assert.equal(connects.length, 3);

  connects[2]!.resolve(3);
  await new Promise((resolve) => setImmediate(resolve));
  connects[1]!.resolve(2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(adapters[1]!.connectionGeneration, 3);
  assert.equal(adapters[1]!.readyState, 0);
  assert.equal(adapters[0]!.readyState, 3);

  client.close();
  replacement.close();
});

test("an authenticated main-transport reuse authenticates the new renderer adapter on open", async () => {
  const pending = deferred<number>();
  const listeners: Array<(event: SocketEvent) => void> = [];
  const sends: Array<{ data: string; generation: number }> = [];
  const diagnostics: DesktopDiagnostic[] = [];
  const confirmations: Array<{ deviceId: string; screen: boolean; camera: boolean }> = [];
  const bridge: Pick<
    LivePresenceBridge,
    "connectSignaling" | "sendSignaling" | "closeSignaling" | "onSocketEvent"
  > = {
    connectSignaling: () => pending.promise,
    sendSignaling: async (data, generation) => { sends.push({ data, generation }); },
    closeSignaling: () => {},
    onSocketEvent: (callback) => {
      listeners.push(callback);
      return () => {
        const index = listeners.indexOf(callback);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
  };
  const client = new DesktopWebRtcClient({
    socketFactory: () => createSignalingSocket(bridge, () => {}),
    peerFactory: () => new MockConnection(),
    managedAuthentication: true,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    onSharingStateConfirmed: ({ deviceId, screen, camera }) =>
      confirmations.push({ deviceId, screen, camera }),
  });
  client.setSharingState(true, false);

  await client.start();
  pending.resolve(42);
  await new Promise((resolve) => setImmediate(resolve));
  listeners[0]!({
    type: "open",
    connectionGeneration: 42,
    authenticatedTransportReuse: true,
    deviceId: "00000000-0000-0000-0000-000000000042",
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(sends, [{
    data: JSON.stringify({ type: "sharing_state", screen: true, camera: false }),
    generation: 42,
  }]);
  assert.equal(
    diagnostics.some((diagnostic) =>
      diagnostic.event === "socket_authentication_received" &&
      diagnostic.reason === "authenticated main-process transport reused"),
    true,
  );
  assert.equal(
    diagnostics.some((diagnostic) =>
      diagnostic.event === "owner_authentication_completed" &&
      diagnostic.reason === "authenticated main-process transport reused"),
    true,
  );

  listeners[0]!({
    type: "message",
    connectionGeneration: 42,
    data: JSON.stringify({
      type: "sharing_state_updated",
      device_id: "00000000-0000-0000-0000-000000000042",
      screen: true,
      camera: false,
    }),
  });
  assert.deepEqual(confirmations, [{
    deviceId: "00000000-0000-0000-0000-000000000042",
    screen: true,
    camera: false,
  }]);
  assert.notEqual(client.lifecycle, "FAILED");

  client.close();
});

test("open followed by authenticated message does not duplicate pending authentication work", async () => {
  const pendingAuthenticationWork = deferred<void>();
  const listeners: Array<(event: SocketEvent) => void> = [];
  const sentMessages: Array<Record<string, unknown>> = [];
  const diagnostics: DesktopDiagnostic[] = [];
  let refreshPresenceCalls = 0;
  const bridge: Pick<
    LivePresenceBridge,
    "connectSignaling" | "sendSignaling" | "closeSignaling" | "onSocketEvent"
  > = {
    connectSignaling: async () => 43,
    sendSignaling: async (data) => {
      sentMessages.push(JSON.parse(data) as Record<string, unknown>);
    },
    closeSignaling: () => {},
    onSocketEvent: (callback) => {
      listeners.push(callback);
      return () => {
        const index = listeners.indexOf(callback);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
  };
  const client = new DesktopWebRtcClient({
    socketFactory: () => createSignalingSocket(bridge, () => {}),
    peerFactory: () => new MockConnection(),
    managedAuthentication: true,
    refreshPresence: () => {
      refreshPresenceCalls += 1;
      return pendingAuthenticationWork.promise;
    },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  client.setSharingState(true, false);

  try {
    await client.start();
    await new Promise((resolve) => setImmediate(resolve));
    listeners[0]!({
      type: "open",
      connectionGeneration: 43,
      authenticatedTransportReuse: true,
      deviceId: "00000000-0000-0000-0000-000000000043",
    });
    await new Promise((resolve) => setImmediate(resolve));

    listeners[0]!({
      type: "message",
      connectionGeneration: 43,
      data: JSON.stringify({
        type: "authenticated",
        role: "owner",
        device_id: "00000000-0000-0000-0000-000000000043",
      }),
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(refreshPresenceCalls, 1);
    pendingAuthenticationWork.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sentMessages, [{
      type: "sharing_state",
      screen: true,
      camera: false,
    }]);
    assert.equal(
      diagnostics.filter((diagnostic) => diagnostic.event === "owner_authentication_completed").length,
      1,
    );
  } finally {
    pendingAuthenticationWork.resolve();
    client.close();
  }
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
  socket.connectionGeneration = 1;
  socket.authenticationManaged = true;
  const diagnostics: DesktopDiagnostic[] = [];
  const confirmations: Array<{
    deviceId: string;
    screen: boolean;
    camera: boolean;
    rendererConnectionGeneration: number | null;
  }> = [];
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
  assert.equal(diagnostics.at(-1)?.publicationOutcome, "socket_not_open");
  assert.equal(diagnostics.at(-1)?.signalingState, "not-connected");
  assert.equal(diagnostics.at(-1)?.socketConnectionGeneration, 0);
  assert.equal(diagnostics.at(-1)?.rendererConnectionGeneration, null);
  assert.equal(confirmations.length, 0);

  await client.start();
  await client.setSharingState(true, false);
  assert.equal(diagnostics.at(-1)?.publicationOutcome, "socket_not_open");
  assert.equal(diagnostics.at(-1)?.signalingState, "connecting");
  assert.equal(diagnostics.at(-1)?.socketConnectionGeneration, 1);
  assert.equal(diagnostics.at(-1)?.rendererConnectionGeneration, 1);
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
  assert.equal(
    diagnostics.filter((diagnostic) => diagnostic.event === "sharing-state").at(-1)?.publicationOutcome,
    "sent",
  );
  assert.equal(
    diagnostics.filter((diagnostic) => diagnostic.event === "sharing-state").at(-1)?.socketConnectionGeneration,
    1,
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
    rendererConnectionGeneration: 1,
  }]);

  socket.disconnect();
  assert.equal(diagnostics.some((diagnostic) => diagnostic.event === "socket_close_received"), true);
  assert.equal(diagnostics.some((diagnostic) => diagnostic.event === "socket_reference_cleared"), true);
  assert.equal(diagnostics.some((diagnostic) => diagnostic.event === "reconnect_scheduled"), true);
  client.setSharingState(true, false);
  assert.equal(
    diagnostics.some((diagnostic) => diagnostic.event === "publication_attempted_without_socket"),
    true,
  );
  assert.equal(diagnostics.at(-1)?.sent, false);
  assert.equal(diagnostics.at(-1)?.publicationOutcome, "socket_not_open");
  assert.equal(confirmations.length, 1);
  client.close();
});

test("diagnostic callback failures do not interrupt authenticated signaling", async () => {
  const socket = new MockSocket();
  socket.authenticationManaged = true;
  const client = new DesktopWebRtcClient({
    socketFactory: () => socket,
    peerFactory: () => new MockConnection(),
    managedAuthentication: true,
    onDiagnostic: () => { throw new Error("diagnostic sink failed"); },
  });
  client.setSharingState(true, false);

  await client.start();
  socket.open();
  socket.onmessage?.({
    data: JSON.stringify({
      type: "authenticated",
      role: "owner",
      device_id: "00000000-0000-0000-0000-000000000001",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(JSON.parse(socket.sent.at(-1)!), {
    type: "sharing_state",
    screen: true,
    camera: false,
  });
  assert.equal(client.lifecycle, "CONNECTING");
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
      request_id: createSessionRequestId(socket),
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
      request_id: createSessionRequestId(socket),
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
      request_id: createSessionRequestId(socket),
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
      request_id: createSessionRequestId(socket),
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
      request_id: createSessionRequestId(socket),
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
      request_id: createSessionRequestId(socket),
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
      request_id: createSessionRequestId(socket),
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
      request_id: createSessionRequestId(socket),
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
  await new Promise((resolve) => setImmediate(resolve));
  sockets[0]!.onmessage?.({
    data: JSON.stringify({
      type: "session_created",
      session_id: "00000000-0000-0000-0000-000000000002",
      device_id: "00000000-0000-0000-0000-000000000001",
      request_id: createSessionRequestId(sockets[0]!),
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
    isCameraActive?: () => boolean;
    getSharingGeneration?: () => number;
    prepareOwnerPeer?: (peer: WebRtcPeer) => Promise<void>;
    peerFactory?: () => MockConnection;
    onOwnerSessionEnded?: (reason: string) => void;
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
    isCameraActive: configuration?.isCameraActive,
    getSharingGeneration: configuration?.getSharingGeneration,
    onTerminalError,
    onDiagnostic: configuration?.onDiagnostic,
    onOwnerSessionEnded: configuration?.onOwnerSessionEnded,
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

test("abandonSleepRecovery preserves an open signaling socket and recreates peer recovery", async () => {
  const scheduler = new ManualScheduler();
  const connection = new MockConnection();
  const screenTrack: WebRtcTrack = { kind: "video", readyState: "live" };
  const { client, socket, connection: peerConnection } = await connectedDesktop(
    scheduler,
    connection,
    undefined,
    {
      isSharingActive: () => true,
      prepareOwnerPeer: async (peer) => {
        await peer.replaceTrack("screen", screenTrack);
      },
    },
  );
  await client.setSharingState(true, false);
  peerConnection.connectionState = "disconnected";
  peerConnection.onconnectionstatechange?.();

  client.abandonSleepRecovery();
  assert.equal(connection.closed, true);
  assert.equal(socket.readyState, 1);
  assert.equal(client.lifecycle, "RECONNECTING");
  const abandonedInternal = client as unknown as {
    recoverySessionId: string | undefined;
  };
  assert.equal(
    abandonedInternal.recoverySessionId,
    "00000000-0000-0000-0000-000000000002",
  );
  connection.closed = false;

  socket.onmessage?.({
    data: JSON.stringify({
      type: "session_recovery",
      session_id: "00000000-0000-0000-0000-000000000002",
      recovery_attempt_id: "post-abandon-recovery",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  peerConnection.closed = false;
  assert.equal(peerConnection.offerCalls, 2);
  assert.equal(peerConnection.closed, false);
  assert.equal(
    peerConnection.replaceCalls.some((call) =>
      call.index === 0 && call.track === screenTrack),
    true,
  );
  client.close();
});

test("desktop wake recovers the approved session after sleep marking times out", async () => {
  const scheduler = new ManualScheduler();
  const connection = new MockConnection();
  const { client, socket, sockets, connection: peerConnection } = await connectedDesktop(
    scheduler,
    connection,
    undefined,
    {
    isSharingActive: () => true,
    },
  );

  await client.setSharingState(true, false);
  const marker = client.prepareForSleep();
  scheduler.runDelay(2_000);
  await assert.rejects(marker, /not acknowledged/);
  client.resumeAfterWake();

  assert.equal(socket.readyState, 3);
  assert.equal(peerConnection.closed, false);
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
      recovery_attempt_id: "sleep-recovery-attempt",
    }),
  });
  assert.equal(scheduler.runNext(), 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peerConnection.offerCalls, 2);
  assert.equal(peerConnection.closed, false);
  sockets[1]!.onmessage?.({
    data: JSON.stringify({
      type: "answer",
      session_id: "00000000-0000-0000-0000-000000000002",
      sdp: "sleep-recovery-answer",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  peerConnection.connectionState = "connected";
  peerConnection.onconnectionstatechange?.();
  assert.equal(client.lifecycle, "CONNECTED");
  client.close();
});

test("desktop resume sends one capability request for duplicate wake notifications", async () => {
  const scheduler = new ManualScheduler();
  const connection = new MockConnection();
  const { client, socket } = await connectedDesktop(scheduler, connection, undefined, {
    isSharingActive: () => true,
  });

  await client.setSharingState(true, false);
  const marker = client.prepareForSleep();
  const markerRequest = JSON.parse(socket.sent.at(-1)!) as { request_id: string };
  socket.onmessage?.({
    data: JSON.stringify({
      type: "sleep_marked",
      session_id: "00000000-0000-0000-0000-000000000002",
      epoch: 1,
      capability: "resume-capability",
      expires_at: 60_000,
      request_id: markerRequest.request_id,
    }),
  });
  await marker;

  client.resumeAfterWake();
  client.resumeAfterWake();
  assert.equal(
    socket.sent.filter((data) => JSON.parse(data).type === "resume_session").length,
    1,
  );
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

test("desktop resumes a pending ICE restart after signaling reauthentication", async () => {
  const scheduler = new ManualScheduler();
  const connection = new MockConnection();
  const diagnostics: DesktopDiagnostic[] = [];
  const screen = { readyState: "live" };
  const camera = { readyState: "live" };
  const { client, socket, sockets, connection: peerConnection } = await connectedDesktop(
    scheduler,
    connection,
    undefined,
    {
      isSharingActive: () => true,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      prepareOwnerPeer: async (peer) => {
        await peer.replaceTrack("screen", screen);
        await peer.replaceTrack("camera", camera);
      },
    },
  );
  await client.setSharingState(true, true);
  const internal = client as unknown as { retiredSessionIds: Set<string>; sessionId: string | undefined };
  assert.equal(internal.sessionId, "00000000-0000-0000-0000-000000000002");
  assert.equal(internal.retiredSessionIds.has("00000000-0000-0000-0000-000000000002"), false);
  peerConnection.connectionState = "disconnected";
  peerConnection.onconnectionstatechange?.();
  socket.disconnect(1013);
  assert.equal(peerConnection.closed, false);
  assert.equal(scheduler.runNext(), 1_500);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sockets.length, 2);
  sockets[1]!.open();
  sockets[1]!.onmessage?.({
    data: JSON.stringify({ type: "authenticated", role: "owner", device_id: "device" }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.runNext(), 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peerConnection.closed, false);
  assert.equal(peerConnection.offerCalls, 2);
  assert.equal(peerConnection.replaceCalls[0]?.track, screen);
  assert.equal(peerConnection.replaceCalls[1]?.track, camera);
  assert.ok(diagnostics.some((diagnostic) =>
    diagnostic.event === "recovery_attempt_started" && diagnostic.attempt === 1));
  assert.ok(sockets[1]!.sent.some((raw) => {
    const message = JSON.parse(raw) as Record<string, unknown>;
    return message.type === "offer" &&
      message.session_id === "00000000-0000-0000-0000-000000000002";
  }));
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

test("desktop retires its peer at the recovery deadline while preserving approved capture", async () => {
  const scheduler = new ManualScheduler();
  const connection = new MockConnection();
  const connections = [connection];
  let factoryCalls = 0;
  const terminalErrors: Error[] = [];
  const diagnostics: DesktopDiagnostic[] = [];
  const endedReasons: string[] = [];
  const { client, socket, connection: peerConnection } = await connectedDesktop(
    scheduler,
    connection,
    (error) => terminalErrors.push(error),
    {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      onOwnerSessionEnded: (reason) => endedReasons.push(reason),
      isSharingActive: () => true,
      isCameraActive: () => false,
      peerFactory: () => {
        if (factoryCalls++ === 0) return connection;
        const replacement = new MockConnection();
        connections.push(replacement);
        return replacement;
      },
    },
  );
  await client.setSharingState(true, false);
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
  assert.equal(connections.length, 2);
  assert.equal(connections[1]!.offerCalls, 1);
  assert.equal(scheduler.runNext(), NETWORK_RECOVERY_TIMEOUT_MS);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.lifecycle, "RECONNECTING");
  assert.equal(peerConnection.closed, true);
  assert.equal(connections[1]!.closed, true);
  assert.deepEqual(endedReasons, []);
  assert.ok(socket.sent.some((raw) => {
    const message = JSON.parse(raw) as Record<string, unknown>;
    return message.type === "retire_session";
  }));
  assert.ok(socket.sent.some((raw) => {
    const message = JSON.parse(raw) as Record<string, unknown>;
    return message.type === "sharing_state" && message.screen === true && message.camera === false;
  }));
  assert.equal(terminalErrors.length, 0);
  assert.ok(diagnostics.some((diagnostic) =>
    diagnostic.event === "recovery_timed_out" &&
    diagnostic.sessionId === "00000000-0000-0000-0000-000000000002" &&
    diagnostic.peerGeneration !== undefined));
  client.close();
});

test("retirement accepts a fresh viewer join without a server departure and ignores old peer callbacks", async () => {
  const scheduler = new ManualScheduler();
  const original = new MockConnection();
  const connections = [original];
  let factoryCalls = 0;
  const { client, socket } = await connectedDesktop(scheduler, original, undefined, {
    isSharingActive: () => true,
    peerFactory: () => {
      if (factoryCalls++ === 0) return original;
      const peer = new MockConnection();
      connections.push(peer);
      return peer;
    },
  });
  await client.setSharingState(true, false);
  const oldStateChange = original.onconnectionstatechange;
  original.connectionState = "failed";
  original.onconnectionstatechange?.();
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  scheduler.runDelay(NETWORK_RECOVERY_TIMEOUT_MS);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(original.closed, true);
  assert.ok(socket.sent.some((raw) => JSON.parse(raw).type === "retire_session"));
  assert.equal(client.lifecycle, "RECONNECTING");

  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_joined",
      session_id: "00000000-0000-0000-0000-000000000003",
      viewer_user_id: "viewer",
    }),
  });
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(connections.length, 2);
  assert.equal(connections[1]!.offerCalls, 1);
  assert.equal(client.lifecycle, "NEGOTIATING");

  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_joined",
      session_id: "00000000-0000-0000-0000-000000000002",
      viewer_user_id: "stale-viewer",
    }),
  });
  socket.onmessage?.({
    data: JSON.stringify({
      type: "answer",
      session_id: "00000000-0000-0000-0000-000000000002",
      negotiation_id: "old-negotiation",
      sdp: "stale-answer",
    }),
  });
  oldStateChange?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connections.length, 2);
  assert.equal(connections[1]!.closed, false);
  assert.equal(client.lifecycle, "NEGOTIATING");
  client.close();
});

test("Stop during fresh attachment after retirement prevents tracks and offers", async () => {
  const scheduler = new ManualScheduler();
  const original = new MockConnection();
  const connections = [original];
  const preparation = deferred<void>();
  const screenTrack: WebRtcTrack & { stop(): void } = {
    kind: "video",
    readyState: "live",
    stop() {},
  };
  const capture = { generation: 1, screen: screenTrack };
  let factoryCalls = 0;
  const { client, socket } = await connectedDesktop(scheduler, original, undefined, {
    isSharingActive: () => capture.screen?.readyState === "live",
    getSharingGeneration: () => capture.generation,
    prepareOwnerPeer: async (peer) => {
      const generation = capture.generation;
      await preparation.promise;
      await attachApprovedTracks(peer, capture, generation);
    },
    peerFactory: () => {
      if (factoryCalls++ === 0) return original;
      const peer = new MockConnection();
      connections.push(peer);
      return peer;
    },
  });
  await client.setSharingState(true, false);
  original.connectionState = "failed";
  original.onconnectionstatechange?.();
  scheduler.runDelay(NETWORK_RECOVERY_TIMEOUT_MS);
  await new Promise((resolve) => setImmediate(resolve));

  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_joined",
      session_id: "00000000-0000-0000-0000-000000000003",
      viewer_user_id: "viewer",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connections.length, 2);
  const replacementStateChange = connections[1]!.onconnectionstatechange;

  const tracks = invalidateCapture(capture);
  stopCapturedTracks(tracks.screen, tracks.camera);
  await client.stopSharingSession();
  preparation.resolve();
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(connections[1]!.closed, true);
  assert.equal(connections[1]!.replaceCalls.length, 0);
  assert.equal(connections[1]!.offerCalls, 0);
  replacementStateChange?.();
  assert.equal(client.lifecycle, "IDLE");
  client.close();
});

test("recovery timeout retains approved tracks and reauthenticates with fresh sharing state", async () => {
  const scheduler = new ManualScheduler();
  const connection = new MockConnection();
  const screenTrack = {
    readyState: "live",
    stopped: false,
    stop() { this.stopped = true; this.readyState = "ended"; },
  };
  const cameraTrack = {
    readyState: "live",
    stopped: false,
    stop() { this.stopped = true; this.readyState = "ended"; },
  };
  let ownerPeerPreparations = 0;
  const endedReasons: string[] = [];
  const { client, socket, sockets, connection: peerConnection } = await connectedDesktop(
    scheduler,
    connection,
    undefined,
    {
      isSharingActive: () => screenTrack.readyState === "live",
      isCameraActive: () => cameraTrack.readyState === "live",
      prepareOwnerPeer: async () => { ownerPeerPreparations += 1; },
      onOwnerSessionEnded: (reason) => endedReasons.push(reason),
    },
  );
  await client.setSharingState(true, true);
  const initialPreparations = ownerPeerPreparations;
  socket.disconnect(1013);
  assert.equal(peerConnection.closed, false);
  scheduler.runDelay(NETWORK_RECOVERY_TIMEOUT_MS);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(peerConnection.closed, true);
  assert.equal(screenTrack.stopped, false);
  assert.equal(cameraTrack.stopped, false);
  assert.equal(client.lifecycle, "RECONNECTING");
  assert.equal(client.failure, undefined);
  assert.deepEqual(endedReasons, []);

  scheduler.runNext();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sockets.length, 2);
  sockets[1]!.open();
  sockets[1]!.onmessage?.({
    data: JSON.stringify({ type: "authenticated", role: "owner", device_id: "device" }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(client.lifecycle, "RECONNECTING");
  assert.equal(client.failure, undefined);
  assert.equal(ownerPeerPreparations, initialPreparations);
  assert.equal(sockets[1]!.sent.filter((raw) => {
    const message = JSON.parse(raw) as Record<string, unknown>;
    return message.type === "sharing_state" && message.screen === true && message.camera === true;
  }).length, 1);
  assert.equal(sockets[1]!.sent.some((raw) => {
    const message = JSON.parse(raw) as Record<string, unknown>;
    return message.type === "offer";
  }), false);
  client.close();
});

test("recovery republishes only independently consented, live tracks without reacquiring", async () => {
  const expireWithTracks = async (
    screenInitiallyLive: boolean,
    cameraInitiallyLive: boolean,
    screenAfterRecovery: boolean,
    cameraAfterRecovery: boolean,
    expected: { screen: boolean; camera: boolean },
  ): Promise<void> => {
    const scheduler = new ManualScheduler();
    const connection = new MockConnection();
    let screenLive = screenInitiallyLive;
    let cameraLive = cameraInitiallyLive;
    let peerPreparations = 0;
    const { client, socket } = await connectedDesktop(
      scheduler,
      connection,
      undefined,
      {
        isSharingActive: () => screenLive,
        isCameraActive: () => cameraLive,
        prepareOwnerPeer: async () => { peerPreparations += 1; },
      },
    );
    await client.setSharingState(true, true);
    const initialPreparations = peerPreparations;
    screenLive = screenAfterRecovery;
    cameraLive = cameraAfterRecovery;
    connection.connectionState = "failed";
    connection.onconnectionstatechange?.();
    scheduler.runDelay(NETWORK_RECOVERY_TIMEOUT_MS);
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(socket.sent.some((raw) => {
      const message = JSON.parse(raw) as Record<string, unknown>;
      return message.type === "sharing_state" &&
        message.screen === expected.screen &&
        message.camera === expected.camera;
    }));
    assert.equal(peerPreparations, initialPreparations);
    client.close();
  };

  await expireWithTracks(true, true, true, true, { screen: true, camera: true });
  await expireWithTracks(true, true, true, false, { screen: true, camera: false });
  await expireWithTracks(true, true, false, true, { screen: false, camera: false });
  await expireWithTracks(true, true, false, false, { screen: false, camera: false });
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
  assert.equal(peerConnection.offerCalls, 2);

  const newRecoveryEvent = {
    type: "session_recovery",
    session_id: "00000000-0000-0000-0000-000000000002",
    recovery_attempt_id: "recovery-attempt-new-cycle",
  };
  socket.onmessage?.({ data: JSON.stringify(newRecoveryEvent) });
  socket.onmessage?.({ data: JSON.stringify(newRecoveryEvent) });
  await new Promise((resolve) => setImmediate(resolve));
  const receivedDiagnostic = diagnostics.find((diagnostic) =>
    diagnostic.event === "session_recovery_received" &&
    diagnostic.recoveryAttemptId === "recovery-attempt-new-cycle");
  assert.ok(receivedDiagnostic);
  assert.ok(receivedDiagnostic.timestamp);
  assert.equal(receivedDiagnostic.sessionId, "00000000-0000-0000-0000-000000000002");
  assert.ok(receivedDiagnostic.peerGeneration !== undefined);
  assert.ok(receivedDiagnostic.negotiationId);
  assert.ok(receivedDiagnostic.socketConnectionGeneration !== undefined);
  assert.equal(peerConnection.offerCalls, 2);
  assert.equal(
    diagnostics.filter((diagnostic) => diagnostic.event === "ice_restart_started").length,
    1,
  );

  const firstRestartOffer = socket.sent
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter((message) => message.type === "offer").at(-1)!;
  socket.onmessage?.({
    data: JSON.stringify({
      type: "answer",
      session_id: "00000000-0000-0000-0000-000000000002",
      negotiation_id: firstRestartOffer.negotiation_id,
      sdp: "first-restart-answer",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.runNext(), 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peerConnection.offerCalls, 3);
  assert.equal(
    diagnostics.filter((diagnostic) => diagnostic.event === "ice_restart_started").length,
    2,
  );
  assert.ok(diagnostics.some((diagnostic) =>
    diagnostic.event === "ice_restart_retry_scheduled" &&
    diagnostic.reason === "new-recovery-event" &&
    diagnostic.attempt === 1));

  const queuedRecoveryEvent = {
    type: "session_recovery",
    session_id: "00000000-0000-0000-0000-000000000002",
    recovery_attempt_id: "recovery-attempt-queued",
  };
  socket.onmessage?.({ data: JSON.stringify(queuedRecoveryEvent) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peerConnection.offerCalls, 3);
  assert.equal(scheduler.timers.size, 2);
  const secondRestartOffer = socket.sent
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter((message) => message.type === "offer").at(-1)!;
  socket.onmessage?.({
    data: JSON.stringify({
      type: "answer",
      session_id: "00000000-0000-0000-0000-000000000002",
      negotiation_id: secondRestartOffer.negotiation_id,
      sdp: "second-restart-answer",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.runNext(), 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peerConnection.offerCalls, 4);
  assert.equal(
    diagnostics.filter((diagnostic) => diagnostic.event === "ice_restart_started").length,
    3,
  );
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
  await client.setSharingState(true, false);
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
  const diagnostics: DesktopDiagnostic[] = [];
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
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
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
  assert.deepEqual(
    sockets[1]!.sent.map((message) => JSON.parse(message) as Record<string, unknown>)
      .find((message) => message.type === "sharing_state"),
    { type: "sharing_state", screen: true, camera: true },
  );
  assert.equal(
    diagnostics.filter((diagnostic) =>
      diagnostic.event === "sharing-state" && diagnostic.publicationOutcome === "sent").length >= 1,
    true,
  );
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

test("device revocation rejection on reconnect stops both renderer capture tracks", async () => {
  const scheduler = new ManualScheduler();
  const connection = new MockConnection();
  const stoppedTracks: string[] = [];
  const cleanupOperations: string[] = [];
  const messages: string[] = [];
  let screenState = "live";
  let cameraState = "live";
  const capture = {
    generation: 7,
    screen: {
      get readyState() { return screenState; },
      stop() {
        screenState = "ended";
        stoppedTracks.push("screen");
      },
    },
    camera: {
      get readyState() { return cameraState; },
      stop() {
        cameraState = "ended";
        stoppedTracks.push("camera");
      },
    },
  };
  let cleanup: Promise<boolean> | undefined;
  const { client, socket, sockets } = await connectedDesktop(
    scheduler,
    connection,
    (error) => {
      handleTerminalCaptureFailure(capture, error, () => {
        const tracks = invalidateCapture(capture);
        cleanup = stopOwnerCapture(
          tracks.screen,
          tracks.camera,
          async () => { cleanupOperations.push("camera"); },
          async () => { cleanupOperations.push("screen"); },
          () => {},
        );
      }, (message) => messages.push(message));
    },
    {
      isSharingActive: () => screenState === "live",
      isCameraActive: () => cameraState === "live",
    },
  );
  await client.setSharingState(true, true);

  socket.disconnect(1006);
  assert.equal(screenState, "live");
  assert.equal(cameraState, "live");
  assert.equal(capture.generation, 7);
  assert.equal(cleanup, undefined);
  await client.start(true);
  sockets[1]!.open();
  sockets[1]!.disconnect(1008);

  assert.equal(client.lifecycle, "FAILED");
  assert.equal(connection.closed, true);
  assert.equal(await cleanup, false);
  assert.equal(capture.generation, 8);
  assert.equal(capture.screen, undefined);
  assert.equal(capture.camera, undefined);
  assert.deepEqual(stoppedTracks, ["screen", "camera"]);
  assert.deepEqual(cleanupOperations.sort(), ["camera", "screen"]);
  assert.deepEqual(messages, []);
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
  await new Promise((resolve) => setImmediate(resolve));
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

test("owner waits for an in-flight ICE restart offer before replacing its peer", async () => {
  const scheduler = new ManualScheduler();
  const original = new MockConnection();
  const connections = [original];
  const gate = deferred<void>();
  const screenTrack: WebRtcTrack = { kind: "video", readyState: "live" };
  const cameraTrack: WebRtcTrack = { kind: "video", readyState: "live" };
  let factoryCalls = 0;
  const { client, socket } = await connectedDesktop(scheduler, original, undefined, {
    isSharingActive: () => true,
    prepareOwnerPeer: async (peer) => {
      await peer.replaceTrack("screen", screenTrack);
      await peer.replaceTrack("camera", cameraTrack);
    },
    peerFactory: () => {
      if (factoryCalls++ === 0) return original;
      const peer = new MockConnection();
      connections.push(peer);
      return peer;
    },
  });
  await client.setSharingState(true, true);
  original.offerGate = gate.promise;
  original.connectionState = "disconnected";
  original.onconnectionstatechange?.();
  assert.equal(scheduler.runNext(), 8_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(original.offerCalls, 2);

  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_rejoined",
      session_id: "00000000-0000-0000-0000-000000000002",
      viewer_user_id: "viewer",
    }),
  });
  assert.equal(connections.length, 1);
  assert.equal(original.closed, false);

  gate.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(connections.length, 2);
  assert.equal(original.closed, true);
  assert.deepEqual(connections[1]!.replaceCalls, [
    { index: 0, track: screenTrack },
    { index: 1, track: cameraTrack },
  ]);
  assert.equal(connections[1]!.offerCalls, 1);
  const offers = socket.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter((message) => message.type === "offer");
  assert.equal(offers.length, 3);
  assert.notEqual(offers[1]!.negotiation_id, offers[2]!.negotiation_id);
  client.close();
});

test("owner awaits delayed signaling delivery before replacing a peer", async () => {
  const scheduler = new ManualScheduler();
  const original = new MockConnection();
  const connections = [original];
  const delivery = deferred<void>();
  let factoryCalls = 0;
  const { client, socket } = await connectedDesktop(scheduler, original, undefined, {
    isSharingActive: () => true,
    peerFactory: () => {
      if (factoryCalls++ === 0) return original;
      const peer = new MockConnection();
      connections.push(peer);
      return peer;
    },
  });
  await client.setSharingState(true, false);
  const sendImmediately = socket.send.bind(socket);
  let offerCount = 0;
  socket.send = async (data, _peerGeneration, isCurrent) => {
    const message = JSON.parse(data) as { type?: string };
    if (message.type === "offer" && ++offerCount === 1) {
      await delivery.promise;
      if (socket.readyState !== 1) throw new Error("signaling socket closed during delivery");
      if (isCurrent && !isCurrent()) throw new Error("peer was superseded during delivery");
    }
    sendImmediately(data, _peerGeneration, isCurrent);
  };

  original.connectionState = "disconnected";
  original.onconnectionstatechange?.();
  assert.equal(scheduler.runNext(), 8_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(original.offerCalls, 2);
  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_rejoined",
      session_id: "00000000-0000-0000-0000-000000000002",
      viewer_user_id: "viewer",
    }),
  });
  assert.equal(connections.length, 1);

  delivery.resolve();
  for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connections.length, 2);
  assert.equal(connections[1]!.offerCalls, 1);
  client.close();
});

test("owner automatically uses a fresh peer after both ICE restart attempts are exhausted", async () => {
  const scheduler = new ManualScheduler();
  const original = new MockConnection();
  const connections = [original];
  const diagnostics: DesktopDiagnostic[] = [];
  const screenTrack: WebRtcTrack = { kind: "video", readyState: "live" };
  const cameraTrack: WebRtcTrack = { kind: "video", readyState: "live" };
  let factoryCalls = 0;
  const { client, socket } = await connectedDesktop(scheduler, original, undefined, {
    isSharingActive: () => true,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    prepareOwnerPeer: async (peer) => {
      await peer.replaceTrack("screen", screenTrack);
      await peer.replaceTrack("camera", cameraTrack);
    },
    peerFactory: () => {
      if (factoryCalls++ === 0) return original;
      const peer = new MockConnection();
      connections.push(peer);
      return peer;
    },
  });
  await client.setSharingState(true, true);
  original.connectionState = "disconnected";
  original.onconnectionstatechange?.();
  assert.equal(scheduler.runNext(), 8_000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.runNext(), 8_000);
  assert.equal(scheduler.runNext(), 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.runNext(), 8_000);
  assert.equal(original.offerCalls, 3);
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(connections.length, 2);
  assert.equal(original.closed, true);
  assert.deepEqual(connections[1]!.replaceCalls, [
    { index: 0, track: screenTrack },
    { index: 1, track: cameraTrack },
  ]);
  assert.equal(connections[1]!.offerCalls, 1);
  assert.ok([...scheduler.timers.values()].some((timer) => timer.delay === NETWORK_RECOVERY_TIMEOUT_MS));
  assert.ok(diagnostics.some((diagnostic) => diagnostic.event === "fresh_peer_fallback_offer_sent"));
  assert.ok(!diagnostics.some((diagnostic) => diagnostic.event === "fresh_peer_fallback_completed"));
  const replacementOffer = socket.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter((message) => message.type === "offer").at(-1)!;
  socket.onmessage?.({
    data: JSON.stringify({
      type: "answer",
      session_id: "00000000-0000-0000-0000-000000000002",
      negotiation_id: "stale-negotiation-id",
      sdp: "stale-viewer-answer",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok([...scheduler.timers.values()].some((timer) => timer.delay === NETWORK_RECOVERY_TIMEOUT_MS));
  assert.ok(!diagnostics.some((diagnostic) => diagnostic.event === "fresh_peer_fallback_completed"));
  socket.onmessage?.({
    data: JSON.stringify({
      type: "answer",
      session_id: "00000000-0000-0000-0000-000000000002",
      negotiation_id: replacementOffer.negotiation_id,
      sdp: "viewer-answer",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok([...scheduler.timers.values()].some((timer) => timer.delay === NETWORK_RECOVERY_TIMEOUT_MS));
  assert.ok(!diagnostics.some((diagnostic) => diagnostic.event === "fresh_peer_fallback_completed"));
  connections[1]!.connectionState = "connected";
  connections[1]!.onconnectionstatechange?.();
  assert.ok(diagnostics.some((diagnostic) => diagnostic.event === "fresh_peer_fallback_completed"));
  assert.ok(![...scheduler.timers.values()].some((timer) => timer.delay === NETWORK_RECOVERY_TIMEOUT_MS));
  client.close();
});

test("duplicate and reordered viewer reattachment events create one replacement offer", async () => {
  const scheduler = new ManualScheduler();
  const original = new MockConnection();
  const connections = [original];
  const preparation = deferred<void>();
  const terminalErrors: Error[] = [];
  let factoryCalls = 0;
  const { client, socket } = await connectedDesktop(scheduler, original, (error) => terminalErrors.push(error), {
    isSharingActive: () => true,
    prepareOwnerPeer: async () => preparation.promise,
    peerFactory: () => {
      if (factoryCalls++ === 0) return original;
      const peer = new MockConnection();
      connections.push(peer);
      return peer;
    },
  });
  await client.setSharingState(true, false);
  const message = JSON.stringify({
    type: "viewer_rejoined",
    session_id: "00000000-0000-0000-0000-000000000002",
    viewer_user_id: "viewer",
  });
  socket.onmessage?.({ data: message });
  await new Promise((resolve) => setImmediate(resolve));
  socket.onmessage?.({ data: message });
  socket.onmessage?.({ data: message });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connections.length, 2);
  assert.equal(connections[1]!.offerCalls, 0);

  preparation.resolve();
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(connections.length, 2);
  assert.equal(connections[1]!.offerCalls, 1);
  assert.equal(
    socket.sent.map((raw) => JSON.parse(raw) as { type: string })
      .filter((message) => message.type === "offer").length,
    1,
    `${client.lifecycle}: ${terminalErrors[0]?.message ?? "no terminal error"}`,
  );
  socket.onmessage?.({ data: message });
  for (let index = 0; index < 3; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(connections.length, 2);
  assert.equal(socket.sent.map((raw) => JSON.parse(raw) as { type: string })
    .filter((message) => message.type === "offer").length, 1);
  client.close();
});

test("stale answers, candidates, and old peer state events cannot affect a replacement", async () => {
  const scheduler = new ManualScheduler();
  const original = new MockConnection();
  const connections = [original];
  const screenTrack: WebRtcTrack = { kind: "video", readyState: "live" };
  let factoryCalls = 0;
  const { client, socket } = await connectedDesktop(scheduler, original, undefined, {
    isSharingActive: () => true,
    prepareOwnerPeer: async (peer) => peer.replaceTrack("screen", screenTrack),
    peerFactory: () => {
      if (factoryCalls++ === 0) return original;
      const peer = new MockConnection();
      connections.push(peer);
      return peer;
    },
  });
  await client.setSharingState(true, false);
  const oldStateChange = original.onconnectionstatechange;
  const oldIceStateChange = original.oniceconnectionstatechange;
  const oldNegotiationId = socket.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .find((message) => message.type === "offer")!.negotiation_id as string;
  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_rejoined",
      session_id: "00000000-0000-0000-0000-000000000002",
      viewer_user_id: "viewer",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const replacement = connections[1]!;
  const replacementLifecycle = client.lifecycle;
  const newOffer = socket.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter((message) => message.type === "offer").at(-1)!;
  assert.notEqual(newOffer.negotiation_id, oldNegotiationId);

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
      candidate: { candidate: "candidate:stale" },
    }),
  });
  original.connectionState = "failed";
  oldStateChange?.();
  oldIceStateChange?.();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(replacement.remote, undefined);
  assert.equal(replacement.candidateCalls, 0);
  assert.equal(replacement.closed, false);
  assert.equal(client.lifecycle, replacementLifecycle);
  client.close();
});

test("Stop Sharing during asynchronous replacement track attachment aborts recovery", async () => {
  const scheduler = new ManualScheduler();
  const original = new MockConnection();
  const connections = [original];
  const preparation = deferred<void>();
  let active = true;
  let captureGeneration = 1;
  let factoryCalls = 0;
  const { client, socket } = await connectedDesktop(scheduler, original, undefined, {
    isSharingActive: () => active,
    getSharingGeneration: () => captureGeneration,
    prepareOwnerPeer: async () => preparation.promise,
    peerFactory: () => {
      if (factoryCalls++ === 0) return original;
      const peer = new MockConnection();
      connections.push(peer);
      return peer;
    },
  });
  await client.setSharingState(true, false);
  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_rejoined",
      session_id: "00000000-0000-0000-0000-000000000002",
      viewer_user_id: "viewer",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connections.length, 2);

  active = false;
  captureGeneration += 1;
  await client.stopSharingSession();
  preparation.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(connections.length, 2);
  assert.equal(connections[1]!.offerCalls, 0);
  assert.equal(connections[1]!.closed, true);
  client.close();
});

test("fresh-peer recovery preserves the original deadline and times out without a viewer answer", async () => {
  const scheduler = new ManualScheduler();
  const original = new MockConnection();
  const connections = [original];
  let active = true;
  let factoryCalls = 0;
  const endedReasons: string[] = [];
  const diagnostics: DesktopDiagnostic[] = [];
  const { client, socket } = await connectedDesktop(scheduler, original, undefined, {
    isSharingActive: () => active,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    prepareOwnerPeer: async () => {},
    onOwnerSessionEnded: (reason) => {
      endedReasons.push(reason);
      active = false;
    },
    peerFactory: () => {
      if (factoryCalls++ === 0) return original;
      const peer = new MockConnection();
      connections.push(peer);
      return peer;
    },
  });
  await client.setSharingState(true, false);
  original.connectionState = "disconnected";
  original.onconnectionstatechange?.();
  assert.ok([...scheduler.timers.values()].some((timer) => timer.delay === NETWORK_RECOVERY_TIMEOUT_MS));
  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_rejoined",
      session_id: "00000000-0000-0000-0000-000000000002",
      viewer_user_id: "viewer",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(connections.length, 2);
  assert.ok([...scheduler.timers.values()].some((timer) => timer.delay === NETWORK_RECOVERY_TIMEOUT_MS));
  assert.ok(![...scheduler.timers.values()].some((timer) => timer.delay === INITIAL_NEGOTIATION_TIMEOUT_MS));
  connections[1]!.connectionState = "connected";
  connections[1]!.onconnectionstatechange?.();
  assert.ok([...scheduler.timers.values()].some((timer) => timer.delay === NETWORK_RECOVERY_TIMEOUT_MS));
  assert.equal(client.lifecycle, "RECONNECTING");
  assert.ok(!diagnostics.some((diagnostic) => diagnostic.event === "fresh_peer_fallback_completed"));
  scheduler.runDelay(NETWORK_RECOVERY_TIMEOUT_MS);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(endedReasons, []);
  assert.equal(connections[1]!.closed, true);
  client.close();
});

test("replacement peer failure preserves and honors the original recovery deadline", async () => {
  const scheduler = new ManualScheduler();
  const original = new MockConnection();
  const connections = [original];
  const terminalErrors: Error[] = [];
  const endedReasons: string[] = [];
  let active = true;
  let factoryCalls = 0;
  const { client, socket } = await connectedDesktop(scheduler, original, (error) => terminalErrors.push(error), {
    isSharingActive: () => active,
    onOwnerSessionEnded: (reason) => {
      endedReasons.push(reason);
      active = false;
    },
    peerFactory: () => {
      if (factoryCalls++ === 0) return original;
      const peer = new MockConnection();
      connections.push(peer);
      return peer;
    },
  });
  await client.setSharingState(true, false);
  original.connectionState = "disconnected";
  original.onconnectionstatechange?.();
  const recoveryTimer = [...scheduler.timers.entries()]
    .find(([, timer]) => timer.delay === NETWORK_RECOVERY_TIMEOUT_MS)?.[0];
  assert.notEqual(recoveryTimer, undefined);
  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_rejoined",
      session_id: "00000000-0000-0000-0000-000000000002",
      viewer_user_id: "viewer",
    }),
  });
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connections.length, 2);

  connections[1]!.connectionState = "failed";
  connections[1]!.onconnectionstatechange?.();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(connections[1]!.closed, true);
  assert.equal(client.lifecycle, "RECONNECTING");
  assert.deepEqual(terminalErrors, []);
  assert.deepEqual(endedReasons, []);
  assert.equal(scheduler.timers.has(recoveryTimer!), true);

  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_left",
      session_id: "00000000-0000-0000-0000-000000000002",
      viewer_user_id: "viewer",
      reason: "temporary_disconnect",
    }),
  });
  assert.equal(client.lifecycle, "RECONNECTING");
  assert.equal(scheduler.timers.has(recoveryTimer!), true);

  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_rejoined",
      session_id: "00000000-0000-0000-0000-000000000002",
      viewer_user_id: "viewer",
    }),
  });
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connections.length, 3);
  assert.equal(connections[2]!.offerCalls, 1);
  assert.equal(scheduler.timers.has(recoveryTimer!), true);

  scheduler.runDelay(NETWORK_RECOVERY_TIMEOUT_MS);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(endedReasons, []);
  client.close();
});

test("recovery timeout retires the captured session after closePeer(true)", async () => {
  for (const socketAvailableAtTimeout of [true, false]) {
    const scheduler = new ManualScheduler();
    const original = new MockConnection();
    const connections = [original];
    let factoryCalls = 0;
    const { client, socket } = await connectedDesktop(scheduler, original, undefined, {
      isSharingActive: () => true,
      peerFactory: () => {
        if (factoryCalls++ === 0) return original;
        const peer = new MockConnection();
        connections.push(peer);
        return peer;
      },
    });
    const originalSessionId = "00000000-0000-0000-0000-000000000002";
    await client.setSharingState(true, false);
    original.connectionState = "disconnected";
    original.onconnectionstatechange?.();
    socket.onmessage?.({
      data: JSON.stringify({
        type: "viewer_rejoined",
        session_id: originalSessionId,
        viewer_user_id: "viewer",
      }),
    });
    for (let index = 0; index < 4; index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(connections.length, 2);

    // A failed replacement closes through the production closePeer(true) path.
    connections[1]!.connectionState = "failed";
    connections[1]!.onconnectionstatechange?.();
    await new Promise((resolve) => setImmediate(resolve));
    const internal = client as unknown as {
      sessionId: string | undefined;
      recoverySessionId: string | undefined;
      retiredSessionIds: Set<string>;
    };
    assert.equal(connections[1]!.closed, true);
    assert.equal(internal.sessionId, undefined);
    assert.equal(internal.recoverySessionId, originalSessionId);
    assert.ok([...scheduler.timers.values()].some(
      (timer) => timer.delay === NETWORK_RECOVERY_TIMEOUT_MS,
    ));

    if (!socketAvailableAtTimeout) socket.disconnect();
    scheduler.runDelay(NETWORK_RECOVERY_TIMEOUT_MS);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(internal.recoverySessionId, originalSessionId);
    assert.equal(internal.retiredSessionIds.has(originalSessionId), true);
    const retireMessages = socket.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((message) => message.type === "retire_session");
    if (socketAvailableAtTimeout) {
      assert.deepEqual(retireMessages, [{
        type: "retire_session",
        session_id: originalSessionId,
      }]);
      socket.onmessage?.({
        data: JSON.stringify({
          type: "viewer_joined",
          session_id: originalSessionId,
          viewer_user_id: "stale-viewer",
        }),
      });
      assert.equal(connections.length, 2);
    } else {
      assert.deepEqual(retireMessages, []);
    }
    client.close();
  }
});

test("desktop recovery timeout flushes pending retirement after authentication and handles acknowledgments", async () => {
  const scheduler = new ManualScheduler();
  const original = new MockConnection();
  const connections = [original];
  let factoryCalls = 0;
  const { client, socket, sockets } = await connectedDesktop(scheduler, original, undefined, {
    isSharingActive: () => true,
    peerFactory: () => {
      if (factoryCalls++ === 0) return original;
      const peer = new MockConnection();
      connections.push(peer);
      return peer;
    },
  });
  const timedOutSessionId = "00000000-0000-0000-0000-000000000002";

  await client.setSharingState(true, false);
  original.connectionState = "disconnected";
  original.onconnectionstatechange?.();
  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_rejoined",
      session_id: timedOutSessionId,
      viewer_user_id: "viewer",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  connections[1]!.connectionState = "failed";
  connections[1]!.onconnectionstatechange?.();
  await new Promise((resolve) => setImmediate(resolve));
  socket.disconnect();
  await client.start(true);
  await new Promise((resolve) => setImmediate(resolve));
  const replacement = sockets[1]!;

  const internal = client as unknown as {
    sessionId: string | undefined;
    recoverySessionId: string | undefined;
    pendingSessionRetirements: Map<string, number>;
    retiredSessionIds: Set<string>;
  };
  assert.equal(internal.recoverySessionId, timedOutSessionId);
  scheduler.runDelay(NETWORK_RECOVERY_TIMEOUT_MS);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(internal.recoverySessionId, timedOutSessionId);
  assert.equal(internal.pendingSessionRetirements.has(timedOutSessionId), true);
  assert.equal(internal.retiredSessionIds.has(timedOutSessionId), true);

  replacement.open();
  replacement.onmessage?.({
    data: JSON.stringify({ type: "authenticated", role: "owner", device_id: "device" }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    replacement.sent.some((raw) => {
      const message = JSON.parse(raw) as Record<string, unknown>;
      return message.type === "retire_session" && message.session_id === timedOutSessionId;
    }),
    true,
  );

  replacement.onmessage?.({
    data: JSON.stringify({
      type: "session_retired",
      session_id: timedOutSessionId,
      outcome: "retired",
    }),
  });
  assert.equal(internal.pendingSessionRetirements.has(timedOutSessionId), false);
  assert.equal(internal.retiredSessionIds.has(timedOutSessionId), true);

  replacement.onmessage?.({
    data: JSON.stringify({
      type: "session_retired",
      session_id: timedOutSessionId,
      outcome: "not_found",
    }),
  });
  assert.equal(internal.pendingSessionRetirements.has(timedOutSessionId), false);
  assert.equal(original.closed, true);
  client.close();
});

test("pending retirement capacity refuses new sessions without evicting unresolved entries", async () => {
  const scheduler = new ManualScheduler();
  const connection = new MockConnection();
  const { client, socket } = await connectedDesktop(scheduler, connection);
  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_left",
      session_id: "00000000-0000-0000-0000-000000000002",
      viewer_user_id: "viewer",
      reason: "viewer_grace_expired",
    }),
  });
  const internal = client as unknown as {
    pendingSessionRetirements: Map<string, number>;
  };
  for (let index = 0; index < MAX_PENDING_SESSION_RETIREMENTS; index += 1) {
    internal.pendingSessionRetirements.set(`pending-session-${index}`, index);
  }
  const retained = [...internal.pendingSessionRetirements.keys()];
  const refusedSessionId = "00000000-0000-0000-0000-000000000099";

  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_joined",
      session_id: refusedSessionId,
      viewer_user_id: "viewer",
    }),
  });

  assert.equal(internal.pendingSessionRetirements.size, MAX_PENDING_SESSION_RETIREMENTS);
  assert.deepEqual([...internal.pendingSessionRetirements.keys()], retained);
  assert.equal(socket.sent.some((raw) => {
    const message = JSON.parse(raw) as Record<string, unknown>;
    return message.type === "retire_session" && message.session_id === refusedSessionId;
  }), true);
  client.close();
});

test("recovery timeout retains and directly retires the 65th unresolved session", async () => {
  const scheduler = new ManualScheduler();
  const connection = new MockConnection();
  const { client, socket, sockets } = await connectedDesktop(scheduler, connection, undefined, {
    isSharingActive: () => true,
  });
  const internal = client as unknown as {
    pendingSessionRetirements: Map<string, number>;
    overflowPendingRetirement: { sessionId: string; peerGeneration: number } | undefined;
  };
  for (let index = 0; index < MAX_PENDING_SESSION_RETIREMENTS; index += 1) {
    internal.pendingSessionRetirements.set(`pending-session-${index}`, index);
  }
  const retained = [...internal.pendingSessionRetirements.entries()];
  const timedOutSessionId = "00000000-0000-0000-0000-000000000002";

  await client.setSharingState(true, false);
  connection.connectionState = "disconnected";
  connection.onconnectionstatechange?.();
  scheduler.runDelay(NETWORK_RECOVERY_TIMEOUT_MS);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual([...internal.pendingSessionRetirements.entries()], retained);
  assert.equal(internal.overflowPendingRetirement?.sessionId, timedOutSessionId);
  assert.equal(socket.sent.some((raw) => {
    const message = JSON.parse(raw) as Record<string, unknown>;
    return message.type === "retire_session" && message.session_id === timedOutSessionId;
  }), true);
  client.close();
});

test("offline 65th retirement remains pending until signaling reauthenticates", async () => {
  const scheduler = new ManualScheduler();
  const connection = new MockConnection();
  const { client, socket, sockets } = await connectedDesktop(scheduler, connection, undefined, {
    isSharingActive: () => true,
  });
  const internal = client as unknown as {
    pendingSessionRetirements: Map<string, number>;
    overflowPendingRetirement: { sessionId: string; peerGeneration: number } | undefined;
  };
  for (let index = 0; index < MAX_PENDING_SESSION_RETIREMENTS; index += 1) {
    internal.pendingSessionRetirements.set(`pending-session-${index}`, index);
  }
  const retained = [...internal.pendingSessionRetirements.entries()];
  const timedOutSessionId = "00000000-0000-0000-0000-000000000002";
  await client.setSharingState(true, false);
  socket.disconnect();
  scheduler.runDelay(NETWORK_RECOVERY_TIMEOUT_MS);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual([...internal.pendingSessionRetirements.entries()], retained);
  assert.equal(internal.overflowPendingRetirement?.sessionId, timedOutSessionId);
  assert.equal(socket.sent.some((raw) => JSON.parse(raw).type === "retire_session"), false);

  await client.start(true);
  const replacement = sockets[1]!;
  replacement.open();
  replacement.onmessage?.({
    data: JSON.stringify({ type: "authenticated", role: "owner", device_id: "device" }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replacement.sent.some((raw) => {
    const message = JSON.parse(raw) as Record<string, unknown>;
    return message.type === "retire_session" && message.session_id === timedOutSessionId;
  }), true);
  client.close();
});

test("pending retirement retries after synchronous and asynchronous send failures without stopping capture", async () => {
  for (const failureMode of ["synchronous", "asynchronous"] as const) {
    const scheduler = new ManualScheduler();
    const connection = new MockConnection();
    let captureActive = true;
    const { client, socket } = await connectedDesktop(scheduler, connection, undefined, {
      isSharingActive: () => captureActive,
    });
    await client.setSharingState(true, false);
    const originalSend = socket.send.bind(socket);
    socket.send = (data, peerGeneration, isCurrent) => {
      const message = JSON.parse(data) as Record<string, unknown>;
      if (message.type === "retire_session") {
        if (failureMode === "synchronous") throw new Error("temporary send failure");
        return Promise.reject(new Error("temporary async send failure"));
      }
      return originalSend(data, peerGeneration, isCurrent);
    };

    connection.connectionState = "disconnected";
    connection.onconnectionstatechange?.();
    scheduler.runDelay(NETWORK_RECOVERY_TIMEOUT_MS);
    await new Promise((resolve) => setImmediate(resolve));
    const internal = client as unknown as {
      pendingSessionRetirements: Map<string, number>;
      pendingRetirementRetryTimer: ReturnType<typeof setTimeout> | undefined;
    };
    const sessionId = "00000000-0000-0000-0000-000000000002";
    assert.equal(internal.pendingSessionRetirements.has(sessionId), true);
    assert.notEqual(internal.pendingRetirementRetryTimer, undefined);
    assert.equal(client.lifecycle, "RECONNECTING");
    assert.equal(captureActive, true);

    socket.send = originalSend;
    scheduler.runDelay(5_000);
    assert.ok(socket.sent.some((raw) => {
      const message = JSON.parse(raw) as Record<string, unknown>;
      return message.type === "retire_session" && message.session_id === sessionId;
    }));
    socket.onmessage?.({
      data: JSON.stringify({
        type: "session_retired",
        session_id: sessionId,
        outcome: "retired",
      }),
    });
    assert.equal(internal.pendingSessionRetirements.has(sessionId), false);
    assert.equal(internal.pendingRetirementRetryTimer, undefined);
    assert.equal(captureActive, true);
    client.close();
  }
});

test("asynchronous old-session revocation acknowledgment failure preserves newer capture", async () => {
  const scheduler = new ManualScheduler();
  const connection = new MockConnection();
  const sessionA = "00000000-0000-0000-0000-000000000002";
  const sessionB = "00000000-0000-0000-0000-000000000003";
  let captureActive = true;
  const replacementConnection = new MockConnection();
  let peerCalls = 0;
  const { client, socket, sockets } = await connectedDesktop(scheduler, connection, undefined, {
    isSharingActive: () => captureActive,
    peerFactory: () => peerCalls++ === 0 ? connection : replacementConnection,
  });
  await client.setSharingState(true, false);
  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_joined",
      session_id: sessionA,
      viewer_user_id: "old-viewer",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  connection.connectionState = "disconnected";
  connection.onconnectionstatechange?.();
  scheduler.runDelay(NETWORK_RECOVERY_TIMEOUT_MS);
  await new Promise((resolve) => setImmediate(resolve));
  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_joined",
      session_id: sessionB,
      viewer_user_id: "new-viewer",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  const internal = client as unknown as {
    sessionId: string | undefined;
    approvedCaptureSessionId: string | undefined;
    pendingSessionRetirements: Map<string, number>;
  };
  assert.equal(internal.sessionId, sessionB);
  assert.equal(internal.approvedCaptureSessionId, sessionB);
  assert.equal(internal.pendingSessionRetirements.has(sessionA), true);

  const originalSend = socket.send.bind(socket);
  socket.send = (data, peerGeneration, isCurrent) => {
    const message = JSON.parse(data) as Record<string, unknown>;
    if (message.type === "retire_session_ack") {
      return Promise.reject(new Error("temporary acknowledgment failure"));
    }
    return originalSend(data, peerGeneration, isCurrent);
  };
  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_left",
      session_id: sessionA,
      viewer_user_id: "viewer",
      reason: "authorization_revoked",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(client.lifecycle, "NEGOTIATING");
  assert.equal(internal.sessionId, sessionB);
  assert.equal(internal.approvedCaptureSessionId, sessionB);
  assert.equal(internal.pendingSessionRetirements.has(sessionA), false);
  assert.equal(captureActive, true);

  socket.disconnect();
  await client.start(true);
  const retrySocket = sockets[1]!;
  retrySocket.open();
  retrySocket.onmessage?.({
    data: JSON.stringify({ type: "authenticated", role: "owner", device_id: "device" }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  retrySocket.onmessage?.({
    data: JSON.stringify({
      type: "session_retired",
      session_id: sessionA,
      outcome: "authorization_revoked",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(retrySocket.sent.some((raw) => {
    const message = JSON.parse(raw) as Record<string, unknown>;
    return message.type === "retire_session_ack" &&
      message.session_id === sessionA &&
      message.outcome === "authorization_revoked";
  }));
  assert.equal(internal.sessionId, sessionB);
  assert.equal(internal.approvedCaptureSessionId, sessionB);
  assert.equal(captureActive, true);
  client.close();
});

test("desktop authorization revocation reaches lifecycle after recovery timeout retires the session", async () => {
  const scheduler = new ManualScheduler();
  const original = new MockConnection();
  const endedReasons: string[] = [];
  const stoppedTracks: string[] = [];
  let rendererCleanup: Promise<boolean> | undefined;
  const { client, socket } = await connectedDesktop(scheduler, original, undefined, {
    isSharingActive: () => true,
    onOwnerSessionEnded: (reason) => {
      endedReasons.push(reason);
      if (reason === "authorization_revoked") {
        rendererCleanup = stopOwnerCapture(
          { stop: () => stoppedTracks.push("screen") },
          { stop: () => stoppedTracks.push("camera") },
          async () => {},
          async () => {},
          () => {},
        );
      }
    },
  });
  const sessionId = "00000000-0000-0000-0000-000000000002";

  await client.setSharingState(true, false);
  original.connectionState = "disconnected";
  original.onconnectionstatechange?.();
  scheduler.runDelay(NETWORK_RECOVERY_TIMEOUT_MS);
  await new Promise((resolve) => setImmediate(resolve));

  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_left",
      session_id: sessionId,
      viewer_user_id: "viewer",
      reason: "authorization_revoked",
    }),
  });
  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_left",
      session_id: sessionId,
      viewer_user_id: "viewer",
      reason: "authorization_revoked",
    }),
  });
  assert.deepEqual(endedReasons, ["authorization_revoked"]);
  assert.equal(socket.sent.filter((raw) => {
    const message = JSON.parse(raw) as Record<string, unknown>;
    return message.type === "retire_session_ack" && message.session_id === sessionId;
  }).length, 2);
  assert.equal(
    socket.sent.some((raw) => {
      const message = JSON.parse(raw) as Record<string, unknown>;
      return message.type === "retire_session_ack" &&
        message.session_id === sessionId &&
        message.outcome === "authorization_revoked";
    }),
    true,
  );
  assert.equal(await rendererCleanup, false);
  assert.deepEqual(stoppedTracks, ["screen", "camera"]);
  client.close();
});

test("viewer grace expiry preserves live capture identity until revocation invalidates it", async () => {
  const scheduler = new ManualScheduler();
  const original = new MockConnection();
  const sessionId = "00000000-0000-0000-0000-000000000002";
  const stoppedTracks: string[] = [];
  let screenState = "live";
  let cameraState = "live";
  const screenTrack = {
    get readyState() { return screenState; },
    stop() {
      screenState = "ended";
      stoppedTracks.push("screen");
    },
  };
  const cameraTrack = {
    get readyState() { return cameraState; },
    stop() {
      cameraState = "ended";
      stoppedTracks.push("camera");
    },
  };
  const capture = { generation: 4, screen: screenTrack, camera: cameraTrack };
  const endedReasons: string[] = [];
  let rendererCleanup: Promise<boolean> | undefined;
  const { client, socket } = await connectedDesktop(scheduler, original, undefined, {
    isSharingActive: () => screenState === "live",
    isCameraActive: () => cameraState === "live",
    onOwnerSessionEnded: (reason) => {
      endedReasons.push(reason);
      if (reason !== "authorization_revoked") return;
      const tracks = invalidateCapture(capture);
      rendererCleanup = stopOwnerCapture(
        tracks.screen,
        tracks.camera,
        async () => {},
        async () => {},
        () => {},
      );
    },
  });
  await client.setSharingState(true, true);

  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_left",
      session_id: sessionId,
      viewer_user_id: "viewer",
      reason: "viewer_grace_expired",
    }),
  });
  assert.equal(original.closed, true);
  assert.equal(screenState, "live");
  assert.equal(cameraState, "live");
  assert.equal(capture.generation, 4);
  assert.deepEqual(endedReasons, []);

  socket.onmessage?.({
    data: JSON.stringify({
      type: "session_retired",
      session_id: sessionId,
      outcome: "retired",
    }),
  });
  assert.equal(screenState, "live");
  assert.equal(cameraState, "live");
  assert.deepEqual(endedReasons, []);

  socket.onmessage?.({
    data: JSON.stringify({
      type: "session_retired",
      session_id: sessionId,
      outcome: "authorization_revoked",
    }),
  });
  assert.deepEqual(endedReasons, ["authorization_revoked"]);
  assert.equal(capture.generation, 5);
  assert.equal(capture.screen, undefined);
  assert.equal(capture.camera, undefined);
  assert.equal(await rendererCleanup, false);
  assert.equal(screenState, "ended");
  assert.equal(cameraState, "ended");
  assert.deepEqual(stoppedTracks, ["screen", "camera"]);
  assert.ok(socket.sent.some((raw) => {
    const message = JSON.parse(raw) as Record<string, unknown>;
    return message.type === "retire_session_ack" &&
      message.session_id === sessionId &&
      message.outcome === "authorization_revoked";
  }));
  client.close();
});

test("a retired session revocation cannot stop a newer approved capture", async () => {
  const scheduler = new ManualScheduler();
  const original = new MockConnection();
  const connections = [original];
  const oldSessionId = "00000000-0000-0000-0000-000000000002";
  const newSessionId = "00000000-0000-0000-0000-000000000003";
  let screenActive = true;
  const endedReasons: string[] = [];
  let factoryCalls = 0;
  const { client, socket } = await connectedDesktop(scheduler, original, undefined, {
    isSharingActive: () => screenActive,
    onOwnerSessionEnded: (reason) => {
      endedReasons.push(reason);
      screenActive = false;
    },
    peerFactory: () => {
      if (factoryCalls++ === 0) return original;
      const peer = new MockConnection();
      connections.push(peer);
      return peer;
    },
  });
  await client.setSharingState(true, false);
  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_left",
      session_id: oldSessionId,
      viewer_user_id: "viewer",
      reason: "viewer_grace_expired",
    }),
  });
  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_joined",
      session_id: newSessionId,
      viewer_user_id: "new-viewer",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connections.length, 2);

  socket.onmessage?.({
    data: JSON.stringify({
      type: "session_retired",
      session_id: oldSessionId,
      outcome: "authorization_revoked",
    }),
  });
  assert.deepEqual(endedReasons, []);
  assert.equal(screenActive, true);
  assert.equal(client.lifecycle, "NEGOTIATING");
  assert.ok(socket.sent.some((raw) => {
    const message = JSON.parse(raw) as Record<string, unknown>;
    return message.type === "retire_session_ack" &&
      message.session_id === oldSessionId &&
      message.outcome === "authorization_revoked";
  }));
  client.close();
});

test("pending old-session revocation only cleans up its own capture association", async () => {
  for (const oldNotification of ["viewer_left", "session_retired"] as const) {
    const scheduler = new ManualScheduler();
    const original = new MockConnection();
    const connections = [original];
    const sessionA = "00000000-0000-0000-0000-000000000002";
    const sessionB = "00000000-0000-0000-0000-000000000003";
    let screenState = "live";
    let cameraState = "live";
    const stoppedTracks: string[] = [];
    const capture = {
      generation: 1,
      screen: {
        get readyState() { return screenState; },
        stop() {
          screenState = "ended";
          stoppedTracks.push("screen");
        },
      },
      camera: {
        get readyState() { return cameraState; },
        stop() {
          cameraState = "ended";
          stoppedTracks.push("camera");
        },
      },
    };
    const endedReasons: string[] = [];
    let rendererCleanup: Promise<boolean> | undefined;
    let factoryCalls = 0;
    const { client, socket } = await connectedDesktop(scheduler, original, undefined, {
      isSharingActive: () => screenState === "live",
      isCameraActive: () => cameraState === "live",
      onOwnerSessionEnded: (reason) => {
        endedReasons.push(reason);
        if (reason !== "authorization_revoked") return;
        const tracks = invalidateCapture(capture);
        rendererCleanup = stopOwnerCapture(
          tracks.screen,
          tracks.camera,
          async () => {},
          async () => {},
          () => {},
        );
      },
      peerFactory: () => {
        if (factoryCalls++ === 0) return original;
        const peer = new MockConnection();
        connections.push(peer);
        return peer;
      },
    });
    await client.setSharingState(true, true);

    original.connectionState = "disconnected";
    original.onconnectionstatechange?.();
    scheduler.runDelay(NETWORK_RECOVERY_TIMEOUT_MS);
    await new Promise((resolve) => setImmediate(resolve));

    const internal = client as unknown as {
      sessionId: string | undefined;
      approvedCaptureSessionId: string | undefined;
      pendingSessionRetirements: Map<string, number>;
      pendingRetirementRetryTimer: ReturnType<typeof setTimeout> | undefined;
      retiredSessionIds: Set<string>;
      handledRevocationSessionIds: Set<string>;
    };
    assert.equal(internal.pendingSessionRetirements.has(sessionA), true);

    socket.onmessage?.({
      data: JSON.stringify({
        type: "viewer_joined",
        session_id: sessionB,
        viewer_user_id: "new-viewer",
      }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(connections.length, 2);
    assert.equal(internal.sessionId, sessionB);
    assert.equal(internal.approvedCaptureSessionId, sessionB);

    const sendRevocation = (sessionId: string, type: "viewer_left" | "session_retired") => {
      socket.onmessage?.({
        data: JSON.stringify(type === "viewer_left" ? {
          type,
          session_id: sessionId,
          viewer_user_id: "viewer",
          reason: "authorization_revoked",
        } : {
          type,
          session_id: sessionId,
          outcome: "authorization_revoked",
        }),
      });
    };
    sendRevocation(sessionA, oldNotification);
    assert.equal(internal.pendingSessionRetirements.has(sessionA), false);
    assert.equal(internal.retiredSessionIds.has(sessionA), true);
    assert.equal(internal.handledRevocationSessionIds.has(sessionA), true);
    assert.equal(internal.pendingRetirementRetryTimer, undefined);
    assert.equal(internal.sessionId, sessionB);
    assert.equal(internal.approvedCaptureSessionId, sessionB);
    assert.deepEqual(endedReasons, []);
    assert.equal(screenState, "live");
    assert.equal(cameraState, "live");
    assert.equal(capture.generation, 1);
    assert.deepEqual(stoppedTracks, []);
    assert.ok(socket.sent.some((raw) => {
      const message = JSON.parse(raw) as Record<string, unknown>;
      return message.type === "retire_session_ack" &&
        message.session_id === sessionA &&
        message.outcome === "authorization_revoked";
    }));

    sendRevocation(sessionB, oldNotification === "viewer_left" ? "session_retired" : "viewer_left");
    assert.deepEqual(endedReasons, ["authorization_revoked"]);
    assert.equal(await rendererCleanup, false);
    assert.equal(capture.generation, 2);
    assert.equal(screenState, "ended");
    assert.equal(cameraState, "ended");
    assert.deepEqual(stoppedTracks, ["screen", "camera"]);
    client.close();
  }
});

test("authentication reconciliation clears retired capture identity before a new capture starts", async () => {
  const scheduler = new ManualScheduler();
  const connection = new MockConnection();
  const sessionA = "00000000-0000-0000-0000-000000000002";
  let screenState = "live";
  let cameraState = "live";
  const stoppedTracks: string[] = [];
  const screenTrack = {
    get readyState() { return screenState; },
    stop() {
      screenState = "ended";
      stoppedTracks.push("screen");
    },
  };
  const cameraTrack = {
    get readyState() { return cameraState; },
    stop() {
      cameraState = "ended";
      stoppedTracks.push("camera");
    },
  };
  const capture = { generation: 1, screen: screenTrack, camera: cameraTrack };
  const endedReasons: string[] = [];
  const { client, socket, sockets } = await connectedDesktop(scheduler, connection, undefined, {
    isSharingActive: () => screenState === "live",
    isCameraActive: () => cameraState === "live",
    onOwnerSessionEnded: (reason) => {
      endedReasons.push(reason);
      if (reason !== "authorization_revoked") return;
      const tracks = invalidateCapture(capture);
      void stopOwnerCapture(
        tracks.screen,
        tracks.camera,
        async () => {},
        async () => {},
        () => {},
      );
    },
  });
  await client.setSharingState(true, true);

  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_left",
      session_id: sessionA,
      viewer_user_id: "viewer",
      reason: "viewer_grace_expired",
    }),
  });
  assert.equal((client as unknown as { approvedCaptureSessionId?: string })
    .approvedCaptureSessionId, sessionA);

  screenState = "ended";
  cameraState = "ended";
  socket.disconnect(1006);
  await client.start(true);
  const reconnectedSocket = sockets[1]!;
  reconnectedSocket.open();
  reconnectedSocket.onmessage?.({
    data: JSON.stringify({
      type: "authenticated",
      role: "owner",
      device_id: "device",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((client as unknown as { sharingState: { screen: boolean } })
    .sharingState.screen, false);
  assert.equal((client as unknown as { approvedCaptureSessionId?: string })
    .approvedCaptureSessionId, undefined);

  screenState = "live";
  cameraState = "live";
  capture.generation += 1;
  capture.screen = {
    get readyState() { return screenState; },
    stop() {
      screenState = "ended";
      stoppedTracks.push("screen-b");
    },
  };
  capture.camera = {
    get readyState() { return cameraState; },
    stop() {
      cameraState = "ended";
      stoppedTracks.push("camera-b");
    },
  };
  await client.setSharingState(true, true);
  assert.equal((client as unknown as { sharingState: { screen: boolean } })
    .sharingState.screen, true);

  reconnectedSocket.onmessage?.({
    data: JSON.stringify({
      type: "session_retired",
      session_id: sessionA,
      outcome: "authorization_revoked",
    }),
  });

  assert.deepEqual(endedReasons, []);
  assert.equal(screenState, "live");
  assert.equal(cameraState, "live");
  assert.deepEqual(stoppedTracks, []);
  assert.equal(capture.generation, 2);
  assert.ok(reconnectedSocket.sent.some((raw) => {
    const message = JSON.parse(raw) as Record<string, unknown>;
    return message.type === "retire_session_ack" &&
      message.session_id === sessionA &&
      message.outcome === "authorization_revoked";
  }));
  client.close();
});

test("explicit stop and screen-track termination clear retired capture associations", async () => {
  for (const stopCause of ["explicit_stop", "screen_track_ended"] as const) {
    const scheduler = new ManualScheduler();
    const original = new MockConnection();
    const sessionId = "00000000-0000-0000-0000-000000000002";
    let screenState = "live";
    let cameraState = "live";
    const screenTrack = {
      get readyState() { return screenState; },
      stop() { screenState = "ended"; },
    };
    const cameraTrack = {
      get readyState() { return cameraState; },
      stop() { cameraState = "ended"; },
    };
    const capture = { generation: 1, screen: screenTrack, camera: cameraTrack };
    const endedReasons: string[] = [];
    const { client, socket } = await connectedDesktop(scheduler, original, undefined, {
      isSharingActive: () => screenState === "live",
      isCameraActive: () => cameraState === "live",
      onOwnerSessionEnded: (reason) => endedReasons.push(reason),
    });
    await client.setSharingState(true, true);
    socket.onmessage?.({
      data: JSON.stringify({
        type: "viewer_left",
        session_id: sessionId,
        viewer_user_id: "viewer",
        reason: "viewer_grace_expired",
      }),
    });

    if (stopCause === "screen_track_ended") screenState = "ended";
    const tracks = invalidateCapture(capture);
    await stopOwnerCapture(
      tracks.screen,
      tracks.camera,
      async () => {},
      async () => {},
      () => {},
    );
    await client.stopSharingSession();

    socket.onmessage?.({
      data: JSON.stringify({
        type: "session_retired",
        session_id: sessionId,
        outcome: "authorization_revoked",
      }),
    });
    assert.equal(capture.generation, 2, stopCause);
    assert.equal(capture.screen, undefined, stopCause);
    assert.equal(capture.camera, undefined, stopCause);
    assert.equal(screenState, "ended", stopCause);
    assert.equal(cameraState, "ended", stopCause);
    assert.deepEqual(endedReasons, [], stopCause);
    client.close();
  }
});

test("revocation after ordinary retirement still stops the approved capture", async () => {
  const scheduler = new ManualScheduler();
  const original = new MockConnection();
  const endedReasons: string[] = [];
  const { client, socket } = await connectedDesktop(scheduler, original, undefined, {
    isSharingActive: () => true,
    onOwnerSessionEnded: (reason) => endedReasons.push(reason),
  });
  const sessionId = "00000000-0000-0000-0000-000000000002";
  await client.setSharingState(true, false);

  original.connectionState = "disconnected";
  original.onconnectionstatechange?.();
  scheduler.runDelay(NETWORK_RECOVERY_TIMEOUT_MS);
  socket.onmessage?.({
    data: JSON.stringify({
      type: "session_retired",
      session_id: sessionId,
      outcome: "retired",
    }),
  });
  assert.equal(endedReasons.length, 0);
  assert.equal(
    (client as unknown as { pendingSessionRetirements: Map<string, number> })
      .pendingSessionRetirements.has(sessionId),
    false,
  );

  socket.onmessage?.({
    data: JSON.stringify({
      type: "session_retired",
      session_id: sessionId,
      outcome: "authorization_revoked",
    }),
  });
  assert.deepEqual(endedReasons, ["authorization_revoked"]);
  client.close();
});

test("desktop terminal failure cancels pending retirement retries", async () => {
  const scheduler = new ManualScheduler();
  const original = new MockConnection();
  const { client, socket } = await connectedDesktop(scheduler, original, undefined, {
    isSharingActive: () => true,
  });
  original.connectionState = "disconnected";
  original.onconnectionstatechange?.();
  scheduler.runDelay(NETWORK_RECOVERY_TIMEOUT_MS);
  await new Promise((resolve) => setImmediate(resolve));

  const internal = client as unknown as {
    pendingSessionRetirements: Map<string, number>;
    pendingRetirementRetryTimer: ReturnType<typeof setTimeout> | undefined;
  };
  assert.equal(internal.pendingSessionRetirements.size > 0, true);

  socket.onmessage?.({ data: JSON.stringify({ type: "error", code: "NOT_AUTHORIZED" }) });
  assert.equal(internal.pendingSessionRetirements.size, 0);
  assert.equal(internal.pendingRetirementRetryTimer, undefined);
  assert.equal([...scheduler.timers.values()].some((timer) => timer.delay === 5000), false);
  client.close();
});

test("desktop pending retirement ignores a newer session and Stop clears pending state", async () => {
  const scheduler = new ManualScheduler();
  const original = new MockConnection();
  const { client, socket } = await connectedDesktop(scheduler, original, undefined, {
    isSharingActive: () => true,
  });
  const oldSessionId = "00000000-0000-0000-0000-000000000002";
  const newerSessionId = "00000000-0000-0000-0000-000000000003";

  original.connectionState = "disconnected";
  original.onconnectionstatechange?.();
  assert.ok([...scheduler.timers.values()].some((timer) => timer.delay === NETWORK_RECOVERY_TIMEOUT_MS));
  scheduler.runDelay(NETWORK_RECOVERY_TIMEOUT_MS);
  await new Promise((resolve) => setImmediate(resolve));

  const internal = client as unknown as {
    sessionId: string | undefined;
    pendingSessionRetirements: Map<string, number>;
  };
  assert.equal(internal.pendingSessionRetirements.has(oldSessionId), true);
  assert.equal(internal.pendingSessionRetirements.has(newerSessionId), false);
  await client.stopSharingSession();
  assert.equal(internal.pendingSessionRetirements.size, 0);
  client.close();
});

test("ordinary not-found retirement preserves approved desktop capture", async () => {
  const scheduler = new ManualScheduler();
  const original = new MockConnection();
  const endedReasons: string[] = [];
  let captureActive = true;
  const { client, socket } = await connectedDesktop(scheduler, original, undefined, {
    isSharingActive: () => captureActive,
    onOwnerSessionEnded: (reason) => endedReasons.push(reason),
  });
  const sessionId = "00000000-0000-0000-0000-000000000002";

  socket.onmessage?.({
    data: JSON.stringify({
      type: "session_retired",
      session_id: sessionId,
      outcome: "not_found",
    }),
  });
  assert.equal(captureActive, true);
  assert.deepEqual(endedReasons, []);
  client.close();
});

test("desktop completed session and revocation history stays bounded", async () => {
  const scheduler = new ManualScheduler();
  const original = new MockConnection();
  const endedReasons: string[] = [];
  const { client, socket } = await connectedDesktop(scheduler, original, undefined, {
    onOwnerSessionEnded: (reason) => endedReasons.push(reason),
  });
  const internal = client as unknown as {
    retiredSessionIds: Set<string>;
    handledRevocationSessionIds: Set<string>;
  };
  for (let index = 10; index < 90; index += 1) {
    const sessionId = `00000000-0000-0000-0000-${index.toString().padStart(12, "0")}`;
    socket.onmessage?.({
      data: JSON.stringify({
        type: "session_retired",
        session_id: sessionId,
        outcome: "authorization_revoked",
      }),
    });
  }
  assert.equal(internal.retiredSessionIds.size, 64);
  assert.equal(internal.handledRevocationSessionIds.size, 64);
  socket.onmessage?.({
    data: JSON.stringify({
      type: "session_retired",
      session_id: "00000000-0000-0000-0000-000000000010",
      outcome: "authorization_revoked",
    }),
  });
  assert.deepEqual(endedReasons, []);
  client.close();
});

test("viewer rejects delayed session replies after completed history is cleaned up", async () => {
  const scheduler = new ManualScheduler();
  const socket = new MockSocket();
  const connections: MockConnection[] = [];
  const deviceId = "00000000-0000-0000-0000-000000000001";
  const viewer = new ViewerWebRtcClient({
    socketFactory: () => socket,
    peerFactory: () => {
      const peer = new MockConnection();
      connections.push(peer);
      return peer;
    },
    browserSessionToken: "browser-session-token",
    deviceId,
    reconnect: { scheduler },
  });
  viewer.start();
  socket.open();
  socket.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "viewer" }) });
  await new Promise((resolve) => setImmediate(resolve));
  const createRequest = socket.sent
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .find((message) => message.type === "create_session");
  assert.equal(typeof createRequest?.request_id, "string");
  const requestId = createRequest!.request_id as string;
  const oldSessionId = "00000000-0000-0000-0000-000000000002";
  const freshSessionId = "00000000-0000-0000-0000-000000000003";

  socket.onmessage?.({
    data: JSON.stringify({
      type: "session_created",
      session_id: oldSessionId,
      device_id: deviceId,
    }),
  });
  assert.equal(connections.length, 0);
  socket.onmessage?.({
    data: JSON.stringify({
      type: "session_created",
      session_id: oldSessionId,
      device_id: deviceId,
      request_id: "stale-request-id",
    }),
  });
  assert.equal(connections.length, 0);

  socket.onmessage?.({
    data: JSON.stringify({
      type: "session_created",
      session_id: freshSessionId,
      device_id: deviceId,
      request_id: requestId,
    }),
  });
  socket.onmessage?.({
    data: JSON.stringify({
      type: "offer",
      session_id: freshSessionId,
      negotiation_id: "fresh-negotiation",
      sdp: "v=0\r\na=mid:0\r\na=mid:1\r\n",
      track_map: [{ mid: "0", kind: "screen" }, { mid: "1", kind: "camera" }],
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connections.length, 1);
  assert.equal(connections[0]?.answerCalls, 1);
  connections[0]!.connectionState = "connected";
  connections[0]!.onconnectionstatechange?.();
  assert.equal(viewer.lifecycle, "CONNECTED");

  const internal = viewer as unknown as {
    retireSession(sessionId: string): void;
    retiredSessionIds: Set<string>;
    sessionId: string | undefined;
  };
  internal.retireSession(oldSessionId);
  for (let index = 4; index < 84; index += 1) {
    internal.retireSession(
      `00000000-0000-0000-0000-${index.toString().padStart(12, "0")}`,
    );
  }
  assert.equal(internal.retiredSessionIds.size, 64);
  assert.equal(internal.retiredSessionIds.has(oldSessionId), false);

  socket.onmessage?.({
    data: JSON.stringify({
      type: "session_attached",
      session_id: oldSessionId,
      device_id: deviceId,
      screen: true,
      camera: true,
      request_id: requestId,
    }),
  });
  socket.onmessage?.({
    data: JSON.stringify({
      type: "offer",
      session_id: oldSessionId,
      negotiation_id: "stale-negotiation",
      sdp: "stale-offer",
      track_map: [{ mid: "0", kind: "screen" }, { mid: "1", kind: "camera" }],
    }),
  });
  assert.equal(internal.sessionId, freshSessionId);
  assert.equal(connections.length, 1);
  assert.equal(connections[0]!.closed, false);
  assert.equal(viewer.lifecycle, "CONNECTED");
  viewer.close();
});

test("a new viewer session supersedes peerless recovery after replacement failure", async () => {
  const scheduler = new ManualScheduler();
  const original = new MockConnection();
  const connections = [original];
  let factoryCalls = 0;
  const { client, socket } = await connectedDesktop(scheduler, original, undefined, {
    isSharingActive: () => true,
    peerFactory: () => {
      if (factoryCalls++ === 0) return original;
      const peer = new MockConnection();
      connections.push(peer);
      return peer;
    },
  });
  await client.setSharingState(true, false);
  original.connectionState = "disconnected";
  original.onconnectionstatechange?.();
  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_rejoined",
      session_id: "00000000-0000-0000-0000-000000000002",
      viewer_user_id: "viewer",
    }),
  });
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connections.length, 2);

  connections[1]!.connectionState = "failed";
  connections[1]!.onconnectionstatechange?.();
  assert.ok([...scheduler.timers.values()].some((timer) => timer.delay === NETWORK_RECOVERY_TIMEOUT_MS));

  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_joined",
      session_id: "00000000-0000-0000-0000-000000000003",
      viewer_user_id: "another-viewer",
    }),
  });
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));

  assert.equal(connections.length, 3);
  assert.equal(connections[1]!.closed, true);
  assert.equal(connections[2]!.offerCalls, 1);
  assert.ok(![...scheduler.timers.values()].some((timer) => timer.delay === NETWORK_RECOVERY_TIMEOUT_MS));
  assert.deepEqual(client.lifecycle, "NEGOTIATING");
  client.close();
});

test("replacement connected and failed before signaling authentication stays under the original recovery deadline", async () => {
  const scheduler = new ManualScheduler();
  const original = new MockConnection();
  const connections = [original];
  const terminalErrors: Error[] = [];
  const endedReasons: string[] = [];
  let active = true;
  let factoryCalls = 0;
  const { client, socket } = await connectedDesktop(
    scheduler,
    original,
    (error) => terminalErrors.push(error),
    {
      isSharingActive: () => active,
      onOwnerSessionEnded: (reason) => {
        endedReasons.push(reason);
        active = false;
      },
      peerFactory: () => {
        if (factoryCalls++ === 0) return original;
        const peer = new MockConnection();
        connections.push(peer);
        return peer;
      },
    },
  );
  await client.setSharingState(true, false);
  original.connectionState = "disconnected";
  original.onconnectionstatechange?.();
  const recoveryTimer = [...scheduler.timers.entries()]
    .find(([, timer]) => timer.delay === NETWORK_RECOVERY_TIMEOUT_MS)?.[0];
  assert.notEqual(recoveryTimer, undefined);
  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_rejoined",
      session_id: "00000000-0000-0000-0000-000000000002",
      viewer_user_id: "viewer",
    }),
  });
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connections.length, 2);

  socket.disconnect();
  connections[1]!.connectionState = "connected";
  connections[1]!.onconnectionstatechange?.();
  assert.equal(client.lifecycle, "RECONNECTING");
  assert.equal(scheduler.timers.has(recoveryTimer!), true);
  connections[1]!.connectionState = "failed";
  connections[1]!.onconnectionstatechange?.();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(connections[1]!.closed, true);
  assert.equal(client.lifecycle, "RECONNECTING");
  assert.equal(scheduler.timers.has(recoveryTimer!), true);
  assert.deepEqual(terminalErrors, []);
  assert.deepEqual(endedReasons, []);
  scheduler.runDelay(NETWORK_RECOVERY_TIMEOUT_MS);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(endedReasons, []);
  client.close();
});

test("replacement recovery completes after signaling authentication and re-arms viewer reattachment", async () => {
  const scheduler = new ManualScheduler();
  const original = new MockConnection();
  const connections = [original];
  let factoryCalls = 0;
  const { client, socket: originalSocket, sockets } = await connectedDesktop(
    scheduler,
    original,
    undefined,
    {
      isSharingActive: () => true,
      peerFactory: () => {
        if (factoryCalls++ === 0) return original;
        const peer = new MockConnection();
        connections.push(peer);
        return peer;
      },
    },
  );
  await client.setSharingState(true, false);
  original.connectionState = "disconnected";
  original.onconnectionstatechange?.();
  const recoveryTimer = [...scheduler.timers.entries()]
    .find(([, timer]) => timer.delay === NETWORK_RECOVERY_TIMEOUT_MS)?.[0];
  assert.notEqual(recoveryTimer, undefined);
  const rejoin = JSON.stringify({
    type: "viewer_rejoined",
    session_id: "00000000-0000-0000-0000-000000000002",
    viewer_user_id: "viewer",
  });
  originalSocket.onmessage?.({ data: rejoin });
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connections.length, 2);

  originalSocket.disconnect();
  connections[1]!.connectionState = "connected";
  connections[1]!.onconnectionstatechange?.();
  assert.equal(client.lifecycle, "RECONNECTING");
  assert.equal(scheduler.timers.has(recoveryTimer!), true);

  assert.equal(scheduler.runNext(), 1_500);
  for (let index = 0; index < 3; index += 1) await new Promise((resolve) => setImmediate(resolve));
  const authenticatedSocket = sockets[1]!;
  authenticatedSocket.open();
  authenticatedSocket.onmessage?.({
    data: JSON.stringify({ type: "authenticated", role: "owner", device_id: "device" }),
  });
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.lifecycle, "RECONNECTING");
  assert.equal(scheduler.timers.has(recoveryTimer!), true);
  const replacementOffer = originalSocket.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .filter((message) => message.type === "offer").at(-1)!;
  authenticatedSocket.onmessage?.({
    data: JSON.stringify({
      type: "answer",
      session_id: "00000000-0000-0000-0000-000000000002",
      negotiation_id: replacementOffer.negotiation_id,
      sdp: "viewer-answer",
    }),
  });
  for (let index = 0; index < 3; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.lifecycle, "CONNECTED");
  assert.equal(scheduler.timers.has(recoveryTimer!), false);

  authenticatedSocket.onmessage?.({ data: rejoin });
  authenticatedSocket.onmessage?.({ data: rejoin });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connections.length, 3);
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connections.length, 3);
  assert.equal(connections[2]!.offerCalls, 1);
  client.close();
});

test("peer error outside recovery remains terminal", async () => {
  const scheduler = new ManualScheduler();
  const connection = new MockConnection();
  const terminalErrors: Error[] = [];
  const { client } = await connectedDesktop(scheduler, connection, (error) => terminalErrors.push(error));

  connection.onerror?.();

  assert.equal(client.lifecycle, "FAILED");
  assert.equal(terminalErrors.length, 1);
  client.close();
});

test("queued viewer reattachment is invalidated across socket reconnection", async () => {
  const scheduler = new ManualScheduler();
  const original = new MockConnection();
  const connections = [original];
  const delivery = deferred<void>();
  let factoryCalls = 0;
  const { client, socket: oldSocket, sockets } = await connectedDesktop(scheduler, original, undefined, {
    isSharingActive: () => true,
    peerFactory: () => {
      if (factoryCalls++ === 0) return original;
      const peer = new MockConnection();
      connections.push(peer);
      return peer;
    },
  });
  await client.setSharingState(true, false);
  const sendImmediately = oldSocket.send.bind(oldSocket);
  oldSocket.send = async (data, _peerGeneration, isCurrent) => {
    const message = JSON.parse(data) as { type?: string };
    if (message.type === "offer") {
      await delivery.promise;
      if (oldSocket.readyState !== 1) throw new Error("obsolete signaling socket");
      if (isCurrent && !isCurrent()) throw new Error("peer was superseded");
    }
    sendImmediately(data, _peerGeneration, isCurrent);
  };

  original.connectionState = "disconnected";
  original.onconnectionstatechange?.();
  assert.equal(scheduler.runNext(), 8_000);
  await new Promise((resolve) => setImmediate(resolve));
  oldSocket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_rejoined",
      session_id: "00000000-0000-0000-0000-000000000002",
      viewer_user_id: "viewer",
    }),
  });
  assert.equal(connections.length, 1);
  oldSocket.disconnect();
  assert.equal(scheduler.runNext(), 1_500);
  for (let index = 0; index < 3; index += 1) await new Promise((resolve) => setImmediate(resolve));

  const newSocket = sockets[1]!;
  newSocket.open();
  newSocket.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "owner", device_id: "device" }) });
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));

  oldSocket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_rejoined",
      session_id: "00000000-0000-0000-0000-000000000002",
      viewer_user_id: "viewer",
    }),
  });
  assert.equal(connections.length, 1);
  const newRejoin = JSON.stringify({
    type: "viewer_rejoined",
    session_id: "00000000-0000-0000-0000-000000000002",
    viewer_user_id: "viewer",
  });
  newSocket.onmessage?.({ data: newRejoin });
  newSocket.onmessage?.({ data: newRejoin });
  assert.equal(connections.length, 1);

  delivery.resolve();
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connections.length, 2);
  assert.equal(connections[1]!.offerCalls, 1);
  assert.equal(newSocket.sent.map((raw) => JSON.parse(raw) as { type: string })
    .filter((message) => message.type === "offer").length, 1);
  client.close();
});

test("viewer reattachment after Stop Sharing and generic owner recovery do not replace the peer", async () => {
  const scheduler = new ManualScheduler();
  const original = new MockConnection();
  const connections = [original];
  let active = true;
  let factoryCalls = 0;
  const { client, socket } = await connectedDesktop(scheduler, original, undefined, {
    isSharingActive: () => active,
    peerFactory: () => {
      if (factoryCalls++ === 0) return original;
      const peer = new MockConnection();
      connections.push(peer);
      return peer;
    },
  });
  await client.setSharingState(true, false);
  socket.onmessage?.({
    data: JSON.stringify({
      type: "session_recovery",
      session_id: "00000000-0000-0000-0000-000000000002",
      recovery_attempt_id: "owner-reconnect",
    }),
  });
  assert.equal(connections.length, 1);

  active = false;
  await client.stopSharingSession();
  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_rejoined",
      session_id: "00000000-0000-0000-0000-000000000002",
      viewer_user_id: "viewer",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connections.length, 1);
  assert.equal(original.closed, true);
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
    assert.equal(previousPeer.closed, true, `viewer left did not close peer at index ${index}`);

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
      request_id: createSessionRequestId(sockets[0]!),
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
  const createRequest = JSON.parse(sockets[0]!.sent.at(-1)!) as Record<string, unknown>;
  assert.deepEqual({
    type: createRequest.type,
    device_id: createRequest.device_id,
  }, {
    type: "create_session",
    device_id: deviceId,
  });
  assert.equal(typeof createRequest.request_id, "string");
  const requestId = createRequest.request_id as string;
  for (const response of [
    { type: "session_attached", session_id: sessionId, device_id: deviceId, screen: true, camera: true },
    {
      type: "session_attached",
      session_id: sessionId,
      device_id: deviceId,
      screen: true,
      camera: true,
      request_id: "stale-request-id",
    },
  ]) {
    sockets[0]!.onmessage?.({ data: JSON.stringify(response) });
    assert.equal(connections.length, 0);
  }
  sockets[0]!.onmessage?.({
    data: JSON.stringify({
      type: "session_attached",
      session_id: sessionId,
      device_id: deviceId,
      screen: true,
      camera: true,
      request_id: requestId,
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
      request_id: createSessionRequestId(socket),
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
      request_id: createSessionRequestId(socket),
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
      request_id: createSessionRequestId(socket),
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

test("viewer recovery deadline expiry remains reconnectable", async () => {
  const scheduler = new ManualScheduler();
  const { viewer, socket, connections, sessionId } = await createConnectedViewer(scheduler);
  const original = connections[0]!;
  original.connectionState = "disconnected";
  original.onconnectionstatechange?.();

  assert.ok([...scheduler.timers.values()].some((timer) => timer.delay === NETWORK_RECOVERY_TIMEOUT_MS));
  scheduler.runDelay(NETWORK_RECOVERY_TIMEOUT_MS);

  assert.equal(viewer.lifecycle, "RECONNECTING");
  assert.equal(viewer.failure, undefined);
  assert.equal(original.closed, true);
  assert.equal(socket.readyState, 3);
  socket.onmessage?.({
    data: JSON.stringify({
      type: "offer",
      session_id: sessionId,
      negotiation_id: "stale-negotiation",
      sdp: "v=0\r\na=mid:0\r\na=mid:1\r\n",
      track_map: [{ mid: "0", kind: "screen" }, { mid: "1", kind: "camera" }],
    }),
  });
  assert.equal(connections.length, 1);
});

test("viewer recovery timeout retires the captured session and ignores it on the new socket", async () => {
  const scheduler = new ManualScheduler();
  const sockets: MockSocket[] = [];
  const connections: MockConnection[] = [];
  const diagnostics: Array<WebRtcDiagnostic | RecoveryDiagnostic | ClientSignalingDiagnostic> = [];
  const sessionId = "00000000-0000-0000-0000-000000000002";
  const newerSessionId = "00000000-0000-0000-0000-000000000003";
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
      session_id: sessionId,
      device_id: deviceId,
      request_id: createSessionRequestId(sockets[0]!),
    }),
  });
  sockets[0]!.onmessage?.({
    data: JSON.stringify({
      type: "offer",
      session_id: sessionId,
      negotiation_id: "negotiation-1",
      sdp: "v=0\r\na=mid:0\r\na=mid:1\r\n",
      track_map: [{ mid: "0", kind: "screen" }, { mid: "1", kind: "camera" }],
    }),
  });
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
  connections[0]!.connectionState = "connected";
  connections[0]!.onconnectionstatechange?.();

  connections[0]!.connectionState = "disconnected";
  connections[0]!.onconnectionstatechange?.();
  const internal = viewer as unknown as {
    closePeer(preserveRecovery?: boolean): void;
    sessionId: string | undefined;
    recoverySessionId: string | undefined;
    retiredSessionIds: Set<string>;
  };
  internal.closePeer(true);
  assert.equal(internal.sessionId, undefined);
  assert.equal(internal.recoverySessionId, sessionId);

  // A distinct current ID must not replace the identity captured for this recovery cycle.
  internal.sessionId = newerSessionId;
  scheduler.runDelay(NETWORK_RECOVERY_TIMEOUT_MS);
  assert.equal(internal.recoverySessionId, undefined);
  assert.equal(internal.retiredSessionIds.has(sessionId), true);
  assert.equal(internal.retiredSessionIds.has(newerSessionId), false);
  assert.equal(connections[0]!.closed, true);
  assert.equal(viewer.lifecycle, "RECONNECTING");
  assert.equal(sockets[0]!.readyState, 3);
  assert.equal(
    sockets.some((socket) => socket.sent.some((raw) => JSON.parse(raw).type === "retire_session")),
    false,
  );

  scheduler.runNext();
  assert.equal(sockets.length, 2);
  sockets[1]!.open();
  sockets[1]!.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "viewer" }) });
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sockets[1]!.readyState, 1);
  assert.ok(sockets[1]!.sent.some((raw) => JSON.parse(raw).type === "create_session"));

  sockets[1]!.onmessage?.({
    data: JSON.stringify({
      type: "offer",
      session_id: sessionId,
      negotiation_id: "stale-negotiation",
      sdp: "stale-offer",
      track_map: [{ mid: "0", kind: "screen" }, { mid: "1", kind: "camera" }],
    }),
  });
  assert.equal(connections.length, 1);
  assert.equal(viewer.failure, undefined);
  assert.equal(viewer.lifecycle, "CONNECTING");
  assert.ok(diagnostics.some((diagnostic) =>
    "phase" in diagnostic &&
    diagnostic.phase === "stale_session_signaling_ignored" &&
    diagnostic.sessionId === sessionId));

  sockets[1]!.onmessage?.({
    data: JSON.stringify({
      type: "session_attached",
      session_id: sessionId,
      device_id: deviceId,
      screen: true,
      camera: false,
      request_id: createSessionRequestId(sockets[1]!),
    }),
  });
  assert.equal(connections.length, 1);

  sockets[1]!.onmessage?.({
    data: JSON.stringify({
      type: "session_created",
      session_id: sessionId,
      device_id: deviceId,
      request_id: createSessionRequestId(sockets[1]!),
    }),
  });
  assert.equal(connections.length, 1);

  sockets[1]!.onmessage?.({
    data: JSON.stringify({ type: "session_recovery", session_id: sessionId }),
  });
  assert.equal(viewer.lifecycle, "CONNECTING");

  for (const reason of ["temporary_disconnect", "authorization_revoked", "closed"]) {
    sockets[1]!.onmessage?.({
      data: JSON.stringify({
        type: "viewer_left",
        session_id: sessionId,
        viewer_user_id: "viewer",
        reason,
      }),
    });
  }
  assert.equal(viewer.lifecycle, "CONNECTING");
  assert.equal(viewer.failure, undefined);

  sockets[1]!.onmessage?.({
    data: JSON.stringify({
      type: "share_request",
      session_id: sessionId,
      request_id: "share-request-1",
      kind: "camera",
      viewer_user_id: "viewer",
    }),
  });
  sockets[1]!.onmessage?.({
    data: JSON.stringify({
      type: "session_resumed",
      session_id: sessionId,
      epoch: 1,
    }),
  });
  sockets[1]!.onmessage?.({
    data: JSON.stringify({
      type: "answer",
      session_id: sessionId,
      negotiation_id: "stale-negotiation",
      sdp: "stale-answer",
    }),
  });
  sockets[1]!.onmessage?.({
    data: JSON.stringify({
      type: "ice_candidate",
      session_id: sessionId,
      negotiation_id: "stale-negotiation",
      candidate: { candidate: "candidate:stale" },
    }),
  });
  assert.equal(connections.length, 1);
  assert.equal(viewer.failure, undefined);

  sockets[1]!.onmessage?.({
    data: JSON.stringify({
      type: "session_created",
      session_id: newerSessionId,
      device_id: deviceId,
      request_id: createSessionRequestId(sockets[1]!),
    }),
  });
  assert.equal(connections.length, 2);

  sockets[1]!.onmessage?.({
    data: JSON.stringify({
      type: "session_attached",
      session_id: sessionId,
      device_id: deviceId,
      screen: true,
      camera: false,
      request_id: createSessionRequestId(sockets[1]!),
    }),
  });
  assert.equal(connections.length, 2);
  assert.equal(connections[1]!.closed, false);
  viewer.close();
});

test("viewer processes authorization revocation after owner recovery expires on an open socket", async () => {
  const scheduler = new ManualScheduler();
  const socket = new MockSocket();
  const connections: MockConnection[] = [];
  const endedReasons: string[] = [];
  const sessionId = "00000000-0000-0000-0000-000000000002";
  const deviceId = "00000000-0000-0000-0000-000000000001";
  const viewer = new ViewerWebRtcClient({
    socketFactory: () => socket,
    peerFactory: () => {
      const peer = new MockConnection();
      connections.push(peer);
      return peer;
    },
    browserSessionToken: "browser-session-token",
    deviceId,
    reconnect: { scheduler },
    onSessionEnded: (reason) => endedReasons.push(reason),
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
      owner_recovery_remaining_ms: 45_000,
      request_id: createSessionRequestId(socket),
    }),
  });
  assert.equal(viewer.lifecycle, "RECONNECTING");
  scheduler.runDelay(45_000);
  assert.equal(socket.readyState, 1);
  assert.equal(viewer.lifecycle, "RECONNECTING");
  assert.equal(connections[0]?.closed, true);
  assert.equal(endedReasons[0], "recovery_timeout");

  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_left",
      session_id: sessionId,
      viewer_user_id: "viewer",
      reason: "authorization_revoked",
    }),
  });

  assert.equal(viewer.lifecycle, "CLOSED");
  assert.equal(viewer.failure, undefined);
  assert.deepEqual(endedReasons, ["recovery_timeout", "authorization_revoked"]);
  assert.equal(scheduler.timers.size, 0);
  viewer.close();
});

test("revocation for a timed-out retired session cannot terminate a newer viewer session", async () => {
  const scheduler = new ManualScheduler();
  const socket = new MockSocket();
  const connections: MockConnection[] = [];
  const sessionA = "00000000-0000-0000-0000-000000000002";
  const sessionB = "00000000-0000-0000-0000-000000000003";
  const deviceId = "00000000-0000-0000-0000-000000000001";
  const viewer = new ViewerWebRtcClient({
    socketFactory: () => socket,
    peerFactory: () => {
      const peer = new MockConnection();
      connections.push(peer);
      return peer;
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
      session_id: sessionA,
      device_id: deviceId,
      screen: true,
      camera: false,
      owner_recovery_remaining_ms: 45_000,
      request_id: createSessionRequestId(socket),
    }),
  });
  scheduler.runDelay(45_000);
  socket.onmessage?.({
    data: JSON.stringify({
      type: "device_sharing_state",
      device_id: deviceId,
      screen: true,
      camera: false,
    }),
  });
  const requestId = createSessionRequestId(socket);
  socket.onmessage?.({
    data: JSON.stringify({
      type: "session_created",
      session_id: sessionB,
      device_id: deviceId,
      request_id: requestId,
    }),
  });
  assert.equal(connections.length, 2);

  socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_left",
      session_id: sessionA,
      viewer_user_id: "viewer",
      reason: "authorization_revoked",
    }),
  });

  assert.equal(viewer.lifecycle, "NEGOTIATING");
  assert.equal(viewer.failure, undefined);
  assert.equal(
    (viewer as unknown as { sessionId: string | undefined }).sessionId,
    sessionB,
  );
  assert.equal(connections[1]?.closed, false);
  viewer.close();
});

test("viewer peer replacement preserves the recovery deadline and rejects stale peer events", async () => {
  const scheduler = new ManualScheduler();
  const { viewer, socket, connections, sessionId } = await createConnectedViewer(scheduler);
  const original = connections[0]!;
  original.connectionState = "disconnected";
  original.onconnectionstatechange?.();
  const recoveryTimerId = [...scheduler.timers.entries()]
    .find(([, timer]) => timer.delay === NETWORK_RECOVERY_TIMEOUT_MS)?.[0];
  assert.notEqual(recoveryTimerId, undefined);

  socket.onmessage?.({
    data: JSON.stringify({
      type: "offer",
      session_id: sessionId,
      negotiation_id: "negotiation-2",
      sdp: "v=0\r\na=mid:0\r\na=mid:1\r\n",
      track_map: [{ mid: "0", kind: "screen" }, { mid: "1", kind: "camera" }],
    }),
  });
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));

  assert.equal(connections.length, 2);
  assert.equal(connections[1]!.answerCalls, 1);
  assert.equal(scheduler.timers.has(recoveryTimerId!), true);
  assert.ok(![...scheduler.timers.values()].some((timer) => timer.delay === INITIAL_NEGOTIATION_TIMEOUT_MS));
  assert.equal(viewer.lifecycle, "RECONNECTING");

  scheduler.nowValue = INITIAL_NEGOTIATION_TIMEOUT_MS;
  assert.equal(viewer.lifecycle, "RECONNECTING");
  assert.equal(viewer.failure, undefined);
  assert.equal(scheduler.timers.has(recoveryTimerId!), true);

  original.connectionState = "failed";
  original.onconnectionstatechange?.();
  socket.onmessage?.({
    data: JSON.stringify({
      type: "offer",
      session_id: sessionId,
      negotiation_id: "negotiation-1",
      sdp: "stale-offer",
      track_map: [{ mid: "0", kind: "screen" }, { mid: "1", kind: "camera" }],
    }),
  });
  socket.onmessage?.({
    data: JSON.stringify({
      type: "ice_candidate",
      session_id: sessionId,
      negotiation_id: "negotiation-1",
      candidate: { candidate: "candidate:stale" },
    }),
  });
  assert.equal(connections.length, 2);
  assert.equal(connections[1]!.candidateCalls, 0);
  assert.equal(viewer.lifecycle, "RECONNECTING");

  connections[1]!.connectionState = "connected";
  connections[1]!.onconnectionstatechange?.();
  assert.equal(viewer.lifecycle, "CONNECTED");
  assert.equal(scheduler.timers.has(recoveryTimerId!), false);
  viewer.close();
});

test("failed viewer replacement can retry within the original recovery deadline", async () => {
  const scheduler = new ManualScheduler();
  const { viewer, socket, connections, sessionId } = await createConnectedViewer(scheduler, (connection, index) => {
    if (index === 1) connection.remoteDescriptionError = new Error("replacement offer failed");
  });
  connections[0]!.connectionState = "disconnected";
  connections[0]!.onconnectionstatechange?.();
  const recoveryTimerId = [...scheduler.timers.entries()]
    .find(([, timer]) => timer.delay === NETWORK_RECOVERY_TIMEOUT_MS)?.[0];
  assert.notEqual(recoveryTimerId, undefined);

  socket.onmessage?.({
    data: JSON.stringify({
      type: "offer",
      session_id: sessionId,
      negotiation_id: "negotiation-2",
      sdp: "v=0\r\na=mid:0\r\na=mid:1\r\n",
      track_map: [{ mid: "0", kind: "screen" }, { mid: "1", kind: "camera" }],
    }),
  });
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connections[1]!.answerCalls, 0);
  assert.equal(viewer.lifecycle, "RECONNECTING");
  assert.equal(viewer.failure, undefined);
  assert.equal(scheduler.timers.has(recoveryTimerId!), true);

  socket.onmessage?.({
    data: JSON.stringify({
      type: "offer",
      session_id: sessionId,
      negotiation_id: "negotiation-3",
      sdp: "v=0\r\na=mid:0\r\na=mid:1\r\n",
      track_map: [{ mid: "0", kind: "screen" }, { mid: "1", kind: "camera" }],
    }),
  });
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connections[2]!.answerCalls, 1);
  connections[2]!.connectionState = "failed";
  connections[2]!.onconnectionstatechange?.();
  assert.equal(viewer.lifecycle, "RECONNECTING");
  assert.equal(viewer.failure, undefined);

  assert.equal(connections.length, 3);
  assert.equal(scheduler.timers.has(recoveryTimerId!), true);
  assert.ok(![...scheduler.timers.values()].some((timer) => timer.delay === INITIAL_NEGOTIATION_TIMEOUT_MS));
  scheduler.runDelay(NETWORK_RECOVERY_TIMEOUT_MS);
  assert.equal(viewer.lifecycle, "RECONNECTING");
  assert.equal(viewer.failure, undefined);
  assert.equal(connections[2]!.closed, true);
});

test("viewer leave and authorization revocation cancel active recovery", async () => {
  const leaveScheduler = new ManualScheduler();
  const leaveFixture = await createConnectedViewer(leaveScheduler);
  leaveFixture.connections[0]!.connectionState = "disconnected";
  leaveFixture.connections[0]!.onconnectionstatechange?.();
  assert.ok([...leaveScheduler.timers.values()].some((timer) => timer.delay === NETWORK_RECOVERY_TIMEOUT_MS));
  leaveFixture.viewer.close();
  assert.equal(leaveScheduler.timers.size, 0);
  assert.ok(leaveFixture.socket.sent.some((data) => JSON.parse(data).type === "leave_session"));

  const revokeScheduler = new ManualScheduler();
  const revokeFixture = await createConnectedViewer(revokeScheduler);
  revokeFixture.connections[0]!.connectionState = "disconnected";
  revokeFixture.connections[0]!.onconnectionstatechange?.();
  revokeFixture.socket.onmessage?.({
    data: JSON.stringify({
      type: "viewer_left",
      session_id: revokeFixture.sessionId,
      viewer_user_id: "viewer",
      reason: "authorization_revoked",
    }),
  });
  assert.equal(revokeScheduler.timers.size, 0);
  assert.equal(revokeFixture.viewer.lifecycle, "CLOSED");
  assert.equal(revokeFixture.connections[0]!.closed, true);
});

test("reconnect ignores replaced and unknown session signaling without affecting the active session", async () => {
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
  await new Promise((resolve) => setImmediate(resolve));
  sockets[0]!.onmessage?.({
    data: JSON.stringify({
      type: "session_created",
      session_id: oldSessionId,
      device_id: "00000000-0000-0000-0000-000000000001",
      request_id: createSessionRequestId(sockets[0]!),
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
  const createRequest = JSON.parse(sockets[1]!.sent.at(-1)!) as Record<string, unknown>;
  assert.deepEqual({
    type: createRequest.type,
    device_id: createRequest.device_id,
    active_session_id: createRequest.active_session_id,
  }, {
    type: "create_session",
    device_id: "00000000-0000-0000-0000-000000000001",
    active_session_id: oldSessionId,
  });
  assert.equal(typeof createRequest.request_id, "string");
  sockets[1]!.onmessage?.({
    data: JSON.stringify({
      type: "session_created",
      session_id: currentSessionId,
      device_id: "00000000-0000-0000-0000-000000000001",
      request_id: createRequest.request_id,
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
  assert.equal(viewer.lifecycle, "NEGOTIATING");
  assert.equal(connections[1]!.closed, false);
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
  const createRequest = JSON.parse(sockets[0]!.sent.at(-1)!) as Record<string, unknown>;
  assert.deepEqual({
    type: createRequest.type,
    device_id: createRequest.device_id,
  }, {
    type: "create_session",
    device_id: deviceId,
  });
  assert.equal(typeof createRequest.request_id, "string");
  sockets[0]!.onmessage?.({
    data: JSON.stringify({
      type: "session_created",
      session_id: sessionId,
      device_id: deviceId,
      request_id: createRequest.request_id,
    }),
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
  const statusRequest = JSON.parse(sockets[2]!.sent.at(-1)!) as Record<string, unknown>;

  assert.equal(statusRequest.type, "resume_status");
  assert.equal(statusRequest.session_id, sessionId);
  assert.equal(statusRequest.request_id, firstResume.request_id);
  sockets[2]!.onmessage?.({
    data: JSON.stringify({
      type: "resume_status",
      session_id: sessionId,
      epoch: 1,
      request_id: firstResume.request_id,
      status: "retryable",
    }),
  });
  const retriedResume = JSON.parse(sockets[2]!.sent.at(-1)!) as Record<string, unknown>;
  assert.equal(retriedResume.type, "resume_session");
  assert.equal(retriedResume.capability, firstResume.capability);
  assert.equal(retriedResume.request_id, firstResume.request_id);
  assert.equal(sockets[2]!.sent.filter((data) => JSON.parse(data).type === "create_session").length, 0);
  viewer.close();
});

test("viewer reconciles pending resume status by replaying the rotated capability", async () => {
  const { viewer, scheduler, sockets, sessionId } = await createSleepMarkedViewer();
  viewer.resumeAfterWake();
  const firstResume = JSON.parse(sockets[0]!.sent.at(-1)!) as Record<string, string>;
  sockets[0]!.onmessage?.({
    data: JSON.stringify({
      type: "resume_pending",
      session_id: sessionId,
      epoch: 1,
      capability: "rotated-before-disconnect",
      expires_at: 60_000,
      request_id: firstResume.request_id,
    }),
  });
  sockets[0]!.disconnect();
  assert.equal(scheduler.runNext(), 1_500);
  await new Promise((resolve) => setImmediate(resolve));
  sockets[1]!.open();
  sockets[1]!.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "viewer" }) });
  await new Promise((resolve) => setImmediate(resolve));
  const firstStatus = JSON.parse(sockets[1]!.sent.at(-1)!) as Record<string, string>;
  assert.equal(firstStatus.type, "resume_status");

  sockets[1]!.onmessage?.({
    data: JSON.stringify({
      type: "resume_status",
      session_id: sessionId,
      epoch: 1,
      request_id: firstStatus.request_id,
      status: "pending",
      capability: "rotated-viewer-capability",
      expires_at: 60_000,
    }),
  });
  const replay = JSON.parse(sockets[1]!.sent.at(-1)!) as Record<string, string>;
  assert.deepEqual({
    type: replay.type,
    session_id: replay.session_id,
    capability: replay.capability,
    request_id: replay.request_id,
  }, {
    type: "resume_session",
    session_id: sessionId,
    capability: "rotated-viewer-capability",
    request_id: firstStatus.request_id,
  });
  viewer.close();
});

test("owner reconciles pending resume status by replaying the rotated capability", async () => {
  const scheduler = new ManualScheduler();
  const connection = new MockConnection();
  const { client, sockets } = await connectedDesktop(scheduler, connection, undefined, {
    isSharingActive: () => true,
  });
  await client.setSharingState(true, false);
  const marker = client.prepareForSleep();
  const markerRequest = JSON.parse(sockets[0]!.sent.at(-1)!) as Record<string, string>;
  sockets[0]!.onmessage?.({
    data: JSON.stringify({
      type: "sleep_marked",
      session_id: "00000000-0000-0000-0000-000000000002",
      epoch: 1,
      capability: "owner-capability",
      expires_at: 60_000,
      request_id: markerRequest.request_id,
    }),
  });
  await marker;
  client.resumeAfterWake();
  const firstResume = JSON.parse(sockets[0]!.sent.at(-1)!) as Record<string, string>;
  sockets[0]!.onmessage?.({
    data: JSON.stringify({
      type: "resume_pending",
      session_id: "00000000-0000-0000-0000-000000000002",
      epoch: 1,
      capability: "rotated-before-disconnect",
      expires_at: 60_000,
      request_id: firstResume.request_id,
    }),
  });
  sockets[0]!.disconnect();
  assert.equal(scheduler.runNext(), 1_500);
  await new Promise((resolve) => setImmediate(resolve));
  sockets[1]!.open();
  sockets[1]!.onmessage?.({
    data: JSON.stringify({ type: "authenticated", role: "owner", device_id: "device" }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  const firstStatus = JSON.parse(sockets[1]!.sent.at(-1)!) as Record<string, string>;
  assert.equal(firstStatus.type, "resume_status");
  sockets[1]!.onmessage?.({
    data: JSON.stringify({
      type: "resume_status",
      session_id: "00000000-0000-0000-0000-000000000002",
      epoch: 1,
      request_id: firstStatus.request_id,
      status: "pending",
      capability: "rotated-owner-capability",
      expires_at: 60_000,
    }),
  });
  const replay = JSON.parse(sockets[1]!.sent.at(-1)!) as Record<string, string>;
  assert.equal(replay.type, "resume_session");
  assert.equal(replay.capability, "rotated-owner-capability");
  assert.equal(replay.request_id, firstStatus.request_id);
  client.close();
});

test("SLEEP_NOT_ALLOWED rejects only its matching pending owner marker", async () => {
  const scheduler = new ManualScheduler();
  const connection = new MockConnection();
  const diagnostics: DesktopDiagnostic[] = [];
  const { client, socket } = await connectedDesktop(scheduler, connection, undefined, {
    isSharingActive: () => true,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  await client.setSharingState(true, false);

  const firstMarker = client.prepareForSleep();
  const firstRequest = JSON.parse(socket.sent.at(-1)!) as Record<string, string>;
  socket.onmessage?.({
    data: JSON.stringify({
      type: "error",
      code: "SLEEP_NOT_ALLOWED",
      session_id: "00000000-0000-0000-0000-000000000002",
      request_id: firstRequest.request_id,
    }),
  });
  await assert.rejects(firstMarker, /SLEEP_NOT_ALLOWED/);
  assert.notEqual(client.lifecycle, "FAILED");
  assert.equal(connection.closed, false);
  assert.equal(
    diagnostics.some((diagnostic) =>
      diagnostic.event === "sleep_marker_error_received" &&
      diagnostic.correlationId === firstRequest.request_id &&
      diagnostic.reason?.includes("matched pending sleep marker")),
    true,
  );

  // A duplicate response for the old marker must not affect a later marker.
  socket.onmessage?.({
    data: JSON.stringify({
      type: "error",
      code: "SLEEP_NOT_ALLOWED",
      session_id: "00000000-0000-0000-0000-000000000002",
      request_id: firstRequest.request_id,
    }),
  });
  const secondMarker = client.prepareForSleep();
  let secondSettled = false;
  void secondMarker.finally(() => { secondSettled = true; });
  const secondRequest = JSON.parse(socket.sent.at(-1)!) as Record<string, string>;
  socket.onmessage?.({
    data: JSON.stringify({
      type: "error",
      code: "SLEEP_NOT_ALLOWED",
      session_id: "00000000-0000-0000-0000-000000000002",
      request_id: firstRequest.request_id,
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondSettled, false);

  socket.onmessage?.({
    data: JSON.stringify({
      type: "sleep_marked",
      session_id: "00000000-0000-0000-0000-000000000002",
      epoch: 2,
      capability: "new-owner-capability",
      expires_at: 60_000,
      request_id: secondRequest.request_id,
    }),
  });
  await secondMarker;
  assert.notEqual(client.lifecycle, "FAILED");
  client.close();
});

test("owner RESUME_INVALID reconnects without stopping approved capture", async () => {
  const scheduler = new ManualScheduler();
  const connection = new MockConnection();
  const { client, socket } = await connectedDesktop(scheduler, connection, undefined, {
    isSharingActive: () => true,
  });
  await client.setSharingState(true, false);
  const marker = client.prepareForSleep();
  const markerRequest = JSON.parse(socket.sent.at(-1)!) as Record<string, string>;
  socket.onmessage?.({
    data: JSON.stringify({
      type: "sleep_marked",
      session_id: "00000000-0000-0000-0000-000000000002",
      epoch: 1,
      capability: "owner-capability",
      expires_at: 60_000,
      request_id: markerRequest.request_id,
    }),
  });
  await marker;
  socket.onmessage?.({ data: JSON.stringify({ type: "error", code: "RESUME_INVALID" }) });
  assert.equal(client.lifecycle, "RECONNECTING");
  assert.ok(scheduler.timers.size >= 1);
  assert.equal(connection.closed, false);
  client.close();
});

test("viewer reconciles completed resume after missing session_resumed", async () => {
  const { viewer, scheduler, sockets, sessionId, connections } = await createSleepMarkedViewer();
  viewer.resumeAfterWake();
  const firstResume = JSON.parse(sockets[0]!.sent.at(-1)!) as Record<string, string>;
  sockets[0]!.onmessage?.({
    data: JSON.stringify({
      type: "resume_pending",
      session_id: sessionId,
      epoch: 1,
      capability: "rotated-viewer-capability",
      expires_at: 60_000,
      request_id: firstResume.request_id,
    }),
  });
  sockets[0]!.disconnect();
  assert.equal(scheduler.runNext(), 1_500);
  await new Promise((resolve) => setImmediate(resolve));
  sockets[1]!.open();
  sockets[1]!.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "viewer" }) });
  await new Promise((resolve) => setImmediate(resolve));
  const statusRequest = JSON.parse(sockets[1]!.sent.at(-1)!) as Record<string, string>;
  sockets[1]!.onmessage?.({
    data: JSON.stringify({
      type: "resume_status",
      session_id: sessionId,
      epoch: 1,
      request_id: statusRequest.request_id,
      status: "completed",
    }),
  });
  const attach = JSON.parse(sockets[1]!.sent.at(-1)!) as Record<string, string>;
  assert.equal(attach.type, "create_session");
  assert.equal(attach.active_session_id, sessionId);
  sockets[1]!.onmessage?.({
    data: JSON.stringify({
      type: "session_attached",
      session_id: sessionId,
      device_id: "00000000-0000-0000-0000-000000000001",
      screen: true,
      camera: true,
      request_id: attach.request_id,
    }),
  });
  sockets[1]!.onmessage?.({
    data: JSON.stringify({
      type: "offer",
      session_id: sessionId,
      negotiation_id: "completed-resume-negotiation",
      sdp: "v=0\r\na=mid:0\r\na=mid:1\r\n",
      track_map: [{ mid: "0", kind: "screen" }, { mid: "1", kind: "camera" }],
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(connections.length, 2);
  viewer.close();
});

test("owner reconciles completed resume after missing session_resumed", async () => {
  const scheduler = new ManualScheduler();
  const connection = new MockConnection();
  const sessionId = "00000000-0000-0000-0000-000000000002";
  const screenTrack: WebRtcTrack = { kind: "video", readyState: "live" };
  const cameraTrack: WebRtcTrack = { kind: "video", readyState: "live" };
  let prepareCalls = 0;
  const { client, sockets, connection: peerConnection } = await connectedDesktop(
    scheduler,
    connection,
    undefined,
    {
      isSharingActive: () => true,
      prepareOwnerPeer: async (peer) => {
        prepareCalls += 1;
        await peer.replaceTrack("screen", screenTrack);
        await peer.replaceTrack("camera", cameraTrack);
      },
    },
  );
  await client.setSharingState(true, true);
  assert.equal(prepareCalls, 1);
  assert.deepEqual(peerConnection.replaceCalls, [
    { index: 0, track: screenTrack },
    { index: 1, track: cameraTrack },
  ]);
  const marker = client.prepareForSleep();
  const markerRequest = JSON.parse(sockets[0]!.sent.at(-1)!) as Record<string, string>;
  sockets[0]!.onmessage?.({
    data: JSON.stringify({
      type: "sleep_marked",
      session_id: sessionId,
      epoch: 1,
      capability: "owner-capability",
      expires_at: 60_000,
      request_id: markerRequest.request_id,
    }),
  });
  await marker;
  client.resumeAfterWake();
  const firstResume = JSON.parse(sockets[0]!.sent.at(-1)!) as Record<string, string>;
  sockets[0]!.onmessage?.({
    data: JSON.stringify({
      type: "resume_pending",
      session_id: sessionId,
      epoch: 1,
      capability: "rotated-owner-capability",
      expires_at: 60_000,
      request_id: firstResume.request_id,
    }),
  });
  peerConnection.connectionState = "disconnected";
  peerConnection.onconnectionstatechange?.();
  sockets[0]!.disconnect();
  assert.equal(scheduler.runNext(), 1_500);
  await new Promise((resolve) => setImmediate(resolve));
  sockets[1]!.open();
  sockets[1]!.onmessage?.({
    data: JSON.stringify({ type: "authenticated", role: "owner", device_id: "device" }),
  });
  // The server emits session_recovery independently of resume_status. The
  // owner must use the existing session and peer rather than creating a new one.
  sockets[1]!.onmessage?.({
    data: JSON.stringify({
      type: "session_recovery",
      session_id: sessionId,
      recovery_attempt_id: "owner-recovery-after-completed-resume",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  const statusRequest = sockets[1]!.sent
    .map((message) => JSON.parse(message) as Record<string, string>)
    .reverse()
    .find((message: Record<string, string>) => message.type === "resume_status");
  assert.ok(statusRequest);
  assert.equal(statusRequest.session_id, sessionId);
  assert.equal(client.lifecycle, "RECONNECTING");
  assert.equal(scheduler.runNext(), 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peerConnection.offerCalls, 2);

  // Duplicate server recovery notifications must not start another negotiation.
  sockets[1]!.onmessage?.({
    data: JSON.stringify({
      type: "session_recovery",
      session_id: sessionId,
      recovery_attempt_id: "owner-recovery-after-completed-resume",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peerConnection.offerCalls, 2);

  sockets[1]!.onmessage?.({
    data: JSON.stringify({
      type: "resume_status",
      session_id: sessionId,
      epoch: 1,
      request_id: statusRequest.request_id,
      status: "completed",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.lifecycle, "RECONNECTING");
  assert.equal(peerConnection.offerCalls, 2);

  // A late duplicate status response is ignored and cannot restart recovery.
  sockets[1]!.onmessage?.({
    data: JSON.stringify({
      type: "resume_status",
      session_id: sessionId,
      epoch: 1,
      request_id: statusRequest.request_id,
      status: "completed",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peerConnection.offerCalls, 2);

  sockets[1]!.onmessage?.({
    data: JSON.stringify({
      type: "answer",
      session_id: sessionId,
      sdp: "recovered-answer",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  peerConnection.connectionState = "connected";
  peerConnection.onconnectionstatechange?.();
  assert.equal(client.lifecycle, "CONNECTED");
  assert.equal(peerConnection.closed, false);
  assert.equal(prepareCalls, 1);
  assert.ok(sockets[1]!.sent.every((message) => JSON.parse(message).type !== "create_session"));
  assert.ok(sockets[1]!.sent
    .map((message) => JSON.parse(message) as Record<string, unknown>)
    .filter((message) => message.type === "offer")
    .every((message) => message.session_id === sessionId));

  // Stop invalidates the recovery cycle; late recovery events cannot restart sharing.
  peerConnection.connectionState = "disconnected";
  peerConnection.onconnectionstatechange?.();
  await client.stopSharingSession();
  const offersAfterStop = peerConnection.offerCalls;
  sockets[1]!.onmessage?.({
    data: JSON.stringify({
      type: "session_recovery",
      session_id: sessionId,
      recovery_attempt_id: "late-recovery-after-stop",
    }),
  });
  sockets[1]!.onmessage?.({
    data: JSON.stringify({
      type: "resume_status",
      session_id: sessionId,
      epoch: 1,
      request_id: statusRequest.request_id,
      status: "completed",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peerConnection.offerCalls, offersAfterStop);
  assert.equal(client.lifecycle, "IDLE");
  assert.equal(connection.closed, true);
  client.close();
});

test("owner ignores duplicate and late session_resumed completions", async () => {
  const scheduler = new ManualScheduler();
  const connection = new MockConnection();
  const { client, socket, sockets, connection: peerConnection } = await connectedDesktop(
    scheduler,
    connection,
    undefined,
    { isSharingActive: () => true },
  );
  await client.setSharingState(true, false);
  peerConnection.connectionState = "disconnected";
  peerConnection.onconnectionstatechange?.();

  socket.onmessage?.({
    data: JSON.stringify({
      type: "session_resumed",
      session_id: "00000000-0000-0000-0000-000000000002",
      epoch: 1,
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  const firstOffers = peerConnection.offerCalls;

  socket.onmessage?.({
    data: JSON.stringify({
      type: "session_resumed",
      session_id: "00000000-0000-0000-0000-000000000002",
      epoch: 1,
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peerConnection.offerCalls, firstOffers);

  await client.stopSharingSession();
  const offersAfterStop = peerConnection.offerCalls;
  socket.onmessage?.({
    data: JSON.stringify({
      type: "session_resumed",
      session_id: "00000000-0000-0000-0000-000000000002",
      epoch: 1,
    }),
  });
  socket.onmessage?.({
    data: JSON.stringify({
      type: "session_recovery",
      session_id: "00000000-0000-0000-0000-000000000002",
      recovery_attempt_id: "late-obsolete-attempt",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peerConnection.offerCalls, offersAfterStop);
  assert.equal(peerConnection.closed, true);
  assert.equal(sockets.length, 1);
  client.close();
});

test("owner ignores old recovery completion after a newer sleep/wake cycle", async () => {
  const scheduler = new ManualScheduler();
  const connection = new MockConnection();
  const { client, socket, connection: peerConnection } = await connectedDesktop(
    scheduler,
    connection,
    undefined,
    { isSharingActive: () => true },
  );
  await client.setSharingState(true, false);

  peerConnection.connectionState = "disconnected";
  peerConnection.onconnectionstatechange?.();
  socket.onmessage?.({
    data: JSON.stringify({
      type: "session_recovery",
      session_id: "00000000-0000-0000-0000-000000000002",
      recovery_attempt_id: "old-cycle-attempt",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  socket.onmessage?.({
    data: JSON.stringify({
      type: "session_recovery",
      session_id: "00000000-0000-0000-0000-000000000002",
      recovery_attempt_id: "new-cycle-attempt",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  const offers = peerConnection.offerCalls;

  socket.onmessage?.({
    data: JSON.stringify({
      type: "answer",
      session_id: "00000000-0000-0000-0000-000000000002",
      negotiation_id: "old-cycle-attempt",
      sdp: "old-answer",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peerConnection.offerCalls, offers);
  assert.equal(peerConnection.closed, false);
  client.close();
});

test("owner timeout cannot fire after successful recovery", async () => {
  const scheduler = new ManualScheduler();
  const connection = new MockConnection();
  const { client, socket, sockets, connection: peerConnection } = await connectedDesktop(
    scheduler,
    connection,
    undefined,
    { isSharingActive: () => true, recoveryTimeoutMs: 120_000 },
  );
  await client.setSharingState(true, false);
  peerConnection.connectionState = "disconnected";
  peerConnection.onconnectionstatechange?.();
  socket.onmessage?.({
    data: JSON.stringify({
      type: "session_recovery",
      session_id: "00000000-0000-0000-0000-000000000002",
      recovery_attempt_id: "successful-before-timeout",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.runNext(), 0);
  await new Promise((resolve) => setImmediate(resolve));
  socket.onmessage?.({
    data: JSON.stringify({
      type: "answer",
      session_id: "00000000-0000-0000-0000-000000000002",
      sdp: "successful-answer",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  peerConnection.connectionState = "connected";
  peerConnection.onconnectionstatechange?.();
  assert.equal(client.lifecycle, "CONNECTED");
  assert.equal([...scheduler.timers.values()].some((timer) => timer.delay === 120_000), false);
  assert.equal(sockets.length, 1);
  client.close();
});

test("expired viewer sleep-resume capability falls back to authorized session creation", async () => {
  const { viewer, scheduler, sockets } = await createSleepMarkedViewer();
  scheduler.nowValue = 60_000;
  sockets[0]!.disconnect();
  assert.equal(scheduler.runNext(), 1_500);
  await new Promise((resolve) => setImmediate(resolve));
  sockets[1]!.open();
  sockets[1]!.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "viewer" }) });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(viewer.lifecycle, "CONNECTED");
  const createRequest = sockets[1]!.sent
    .map((data) => JSON.parse(data) as Record<string, unknown>)
    .find((message) => message.type === "create_session");
  assert.equal(createRequest?.type, "create_session");
  assert.equal(createRequest?.active_session_id, "00000000-0000-0000-0000-000000000002");
  assert.equal(sockets[1]!.sent.some((data) => JSON.parse(data).type === "resume_session"), false);
  viewer.close();
});

test("rejected viewer sleep-resume capability falls back to authorized session creation", async () => {
  const { viewer, scheduler, sockets } = await createSleepMarkedViewer();
  sockets[0]!.disconnect();
  assert.equal(scheduler.runNext(), 1_500);
  await new Promise((resolve) => setImmediate(resolve));
  sockets[1]!.open();
  sockets[1]!.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "viewer" }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.parse(sockets[1]!.sent.at(-1)!).type, "resume_session");

  sockets[1]!.onmessage?.({ data: JSON.stringify({ type: "error", code: "RESUME_INVALID" }) });
  assert.equal(viewer.lifecycle, "RECONNECTING");
  assert.equal(sockets[1]!.sent.some((data) => JSON.parse(data).type === "create_session"), true);
  assert.equal(
    JSON.parse(sockets[1]!.sent.find((data) => JSON.parse(data).type === "create_session")!).active_session_id,
    "00000000-0000-0000-0000-000000000002",
  );
  viewer.close();
});

test("viewer unauthorized resumed reattachment does not bypass authorization or create another session", async () => {
  const { viewer, scheduler, sockets } = await createSleepMarkedViewer();
  sockets[0]!.disconnect();
  assert.equal(scheduler.runNext(), 1_500);
  await new Promise((resolve) => setImmediate(resolve));
  sockets[1]!.open();
  sockets[1]!.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "viewer" }) });
  await new Promise((resolve) => setImmediate(resolve));
  const resumeRequest = sockets[1]!.sent
    .map((data) => JSON.parse(data) as Record<string, unknown>)
    .find((message) => message.type === "resume_session");
  assert.equal(resumeRequest?.type, "resume_session");

  sockets[1]!.onmessage?.({ data: JSON.stringify({ type: "error", code: "NOT_AUTHORIZED" }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    sockets[1]!.sent.filter((data) => JSON.parse(data).type === "create_session").length,
    0,
  );
  assert.equal(
    sockets[1]!.sent.filter((data) => JSON.parse(data).type === "resume_session").length,
    1,
  );
  viewer.close();
});

test("viewer retired resumed session is rejected without unrelated session creation", async () => {
  const { viewer, scheduler, sockets, sessionId } = await createSleepMarkedViewer();
  viewer.resumeAfterWake();
  sockets[0]!.disconnect();
  assert.equal(scheduler.runNext(), 1_500);
  await new Promise((resolve) => setImmediate(resolve));
  sockets[1]!.open();
  sockets[1]!.onmessage?.({ data: JSON.stringify({ type: "authenticated", role: "viewer" }) });
  await new Promise((resolve) => setImmediate(resolve));

  sockets[1]!.onmessage?.({ data: JSON.stringify({ type: "error", code: "RESUME_INVALID" }) });
  await new Promise((resolve) => setImmediate(resolve));
  const createRequests = sockets[1]!.sent
    .map((data) => JSON.parse(data) as Record<string, unknown>)
    .filter((message) => message.type === "create_session");
  assert.equal(createRequests.length, 1);
  assert.equal(createRequests[0]?.active_session_id, sessionId);

  sockets[1]!.onmessage?.({ data: JSON.stringify({ type: "error", code: "SESSION_NOT_FOUND" }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(viewer.lifecycle, "CLOSED");
  assert.equal(
    sockets[1]!.sent.filter((data) => JSON.parse(data).type === "create_session").length,
    1,
  );
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
