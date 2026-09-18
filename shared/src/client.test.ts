import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DesktopWebRtcClient,
  ViewerWebRtcClient,
  type SignalingSocket,
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

  async createOffer() { return { type: "offer" as const, sdp: "owner-offer" }; }
  async createAnswer() { return { type: "answer" as const, sdp: "viewer-answer" }; }
  async setLocalDescription(value: unknown) { this.local = value; }
  async setRemoteDescription(value: unknown) { this.remote = value; }
  async addIceCandidate() {}
  close() { this.closed = true; }
}

class MockSocket implements SignalingSocket {
  readyState = 0;
  peer: MockSocket | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: string): void {
    this.peer?.onmessage?.({ data });
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
