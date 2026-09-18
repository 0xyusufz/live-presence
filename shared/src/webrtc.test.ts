import assert from "node:assert/strict";
import { test } from "node:test";
import { WebRtcPeer, type WebRtcPeerConnection, type WebRtcTransceiver } from "./webrtc.js";
import { validTrackMap } from "./protocol.js";

class MockConnection implements WebRtcPeerConnection {
  transceivers: WebRtcTransceiver[] = [];
  connectionState = "new";
  iceConnectionState = "new";
  onicecandidate: ((event: { candidate: unknown | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  closed = false;
  remote: unknown;
  local: unknown;
  candidates: unknown[] = [];
  replaceCalls: Array<{ index: number; track: unknown }> = [];
  failAddIce = false;
  addTransceiver(_kind: string, init: { direction: "sendonly" | "recvonly" }): WebRtcTransceiver {
    const index = this.transceivers.length;
    const tx: WebRtcTransceiver = {
      mid: String(index),
      direction: init.direction,
      sender: { replaceTrack: async (track) => { this.replaceCalls.push({ index, track }); } },
    };
    this.transceivers.push(tx);
    return tx;
  }
  async createOffer() { return { type: "offer" as const, sdp: "offer" }; }
  async createAnswer() { return { type: "answer" as const, sdp: "answer" }; }
  async setLocalDescription(value: unknown) { this.local = value; }
  async setRemoteDescription(value: unknown) { this.remote = value; }
  async addIceCandidate(value: unknown) {
    if (this.failAddIce) throw new Error("candidate failed");
    this.candidates.push(value);
  }
  close() { this.closed = true; }
}

test("owner creates fixed sendonly transceivers and exchanges offer/answer and ICE", async () => {
  const connection = new MockConnection();
  const messages: unknown[] = [];
  const peer = new WebRtcPeer("owner", "session", () => connection, (message) => messages.push(message));
  assert.deepEqual(connection.transceivers.map((tx) => tx.direction), ["sendonly", "sendonly"]);
  await peer.createOffer();
  assert.equal((messages[0] as { type: string }).type, "offer");
  assert.deepEqual((messages[0] as { track_map: unknown }).track_map, [
    { mid: "0", kind: "screen" }, { mid: "1", kind: "camera" },
  ]);
  connection.onicecandidate?.({ candidate: { candidate: "x" } });
  assert.equal((messages[1] as { type: string }).type, "ice_candidate");
  await peer.addIceCandidate({ candidate: "y" });
  assert.deepEqual(connection.candidates, []);
  await peer.acceptAnswer("answer");
  assert.deepEqual(connection.candidates, [{ candidate: "y" }]);
  peer.close();
  assert.equal(connection.closed, true);
  connection.onicecandidate?.({ candidate: { candidate: "after-close" } });
  assert.equal(messages.length, 2);
  await assert.rejects(() => peer.addIceCandidate({ candidate: "after-close" }), /closed/);
});

test("viewer answers with the negotiated canonical map and lifecycle revocation closes cleanly", async () => {
  const connection = new MockConnection();
  const messages: unknown[] = [];
  const peer = new WebRtcPeer("viewer", "session", () => connection, (message) => messages.push(message));
  assert.equal(connection.transceivers.length, 2);
  assert.deepEqual(connection.transceivers.map((tx) => tx.direction), ["recvonly", "recvonly"]);
  assert.deepEqual(connection.transceivers.map((tx) => tx.mid), ["0", "1"]);
  await peer.acceptOffer("offer", [{ mid: "0", kind: "screen" }, { mid: "1", kind: "camera" }]);
  assert.equal((messages[0] as { type: string }).type, "answer");
  connection.connectionState = "failed";
  connection.onconnectionstatechange?.();
  assert.equal(peer.state, "failed");
  peer.close();
  await assert.rejects(() => peer.addIceCandidate({}), /closed/);
});

test("offer and answer state transitions reject wrong, duplicate, and out-of-order operations", async () => {
  const ownerConnection = new MockConnection();
  const owner = new WebRtcPeer("owner", "session", () => ownerConnection, () => undefined);
  await assert.rejects(() => new WebRtcPeer("viewer", "session", () => new MockConnection(), () => undefined).createOffer(), /current state/);
  await assert.rejects(() => owner.acceptAnswer("answer"), /current state/);
  await owner.createOffer();
  await assert.rejects(() => owner.createOffer(), /current state/);
  await owner.acceptAnswer("answer");
  await assert.rejects(() => owner.acceptAnswer("answer-2"), /current state/);

  const viewerConnection = new MockConnection();
  const viewer = new WebRtcPeer("viewer", "session", () => viewerConnection, () => undefined);
  await assert.rejects(() => viewer.createOffer(), /current state/);
  await viewer.acceptOffer("offer", [{ mid: "0", kind: "screen" }, { mid: "1", kind: "camera" }]);
  await assert.rejects(() => viewer.acceptOffer("offer-2", [{ mid: "0", kind: "screen" }, { mid: "1", kind: "camera" }]), /current state/);
});

test("terminal peer failure rejects later negotiation operations", async () => {
  const connection = new MockConnection();
  const peer = new WebRtcPeer("owner", "session", () => connection, () => undefined);
  connection.connectionState = "failed";
  connection.onconnectionstatechange?.();
  await assert.rejects(() => peer.createOffer(), /current state/);
  await assert.rejects(() => peer.addIceCandidate({ candidate: "after-failure" }), /failed/);
});

test("ICE candidates queue before remote description and flush in arrival order", async () => {
  const connection = new MockConnection();
  const peer = new WebRtcPeer("owner", "session", () => connection, () => undefined);
  await peer.addIceCandidate({ candidate: "one" });
  await peer.addIceCandidate({ candidate: "two" });
  assert.deepEqual(connection.candidates, []);
  await peer.createOffer();
  await peer.acceptAnswer("answer");
  assert.deepEqual(connection.candidates, [{ candidate: "one" }, { candidate: "two" }]);
});

test("ICE queue is bounded and invalid candidates are rejected", async () => {
  const peer = new WebRtcPeer("owner", "session", () => new MockConnection(), () => undefined);
  await assert.rejects(() => peer.addIceCandidate(null), /invalid/);
  await assert.rejects(() => peer.addIceCandidate({ candidate: "x".repeat(32 * 1024) }), /invalid/);
  for (let index = 0; index < 64; index += 1) await peer.addIceCandidate({ candidate: String(index) });
  await assert.rejects(() => peer.addIceCandidate({ candidate: "full" }), /full/);
});

test("ICE candidate failures terminate negotiation safely and clear the queue", async () => {
  const connection = new MockConnection();
  const peer = new WebRtcPeer("owner", "session", () => connection, () => undefined);
  await peer.addIceCandidate({ candidate: "queued" });
  connection.failAddIce = true;
  await peer.createOffer();
  await assert.rejects(() => peer.acceptAnswer("answer"), /candidate failed/);
  await assert.rejects(() => peer.addIceCandidate({ candidate: "after-failure" }), /failed/);
});

test("replaceTrack is owner-only and preserves independent transceivers", async () => {
  const ownerConnection = new MockConnection();
  const owner = new WebRtcPeer("owner", "session", () => ownerConnection, () => undefined);
  const screen = { kind: "screen-track" };
  const camera = { kind: "camera-track" };
  await owner.replaceTrack("screen", screen);
  await owner.replaceTrack("camera", camera);
  assert.deepEqual(ownerConnection.replaceCalls, [
    { index: 0, track: screen },
    { index: 1, track: camera },
  ]);
  assert.equal(ownerConnection.transceivers.length, 2);

  const viewerConnection = new MockConnection();
  const viewer = new WebRtcPeer("viewer", "session", () => viewerConnection, () => undefined);
  await assert.rejects(() => viewer.replaceTrack("screen", screen), /owner/);
  assert.deepEqual(viewerConnection.replaceCalls, []);
  owner.close();
  await assert.rejects(() => owner.replaceTrack("screen", null), /state|closed/);
});

test("track map validation rejects missing, duplicate, and reordered identities", () => {
  assert.equal(validTrackMap([{ mid: "0", kind: "screen" }, { mid: "1", kind: "camera" }]), true);
  assert.equal(validTrackMap([{ mid: "0", kind: "screen" }]), false);
  assert.equal(validTrackMap([{ mid: "0", kind: "screen" }, { mid: "0", kind: "camera" }]), false);
  assert.equal(validTrackMap([{ mid: "0", kind: "screen" }, { mid: "1", kind: "screen" }]), false);
  assert.equal(validTrackMap([{ mid: "0", kind: "camera" }, { mid: "1", kind: "screen" }]), false);
});

test("viewer rejects a valid-shaped track map with incorrect negotiated mids", async () => {
  const peer = new WebRtcPeer("viewer", "session", () => new MockConnection(), () => undefined);
  await assert.rejects(
    () => peer.acceptOffer("offer", [{ mid: "1", kind: "screen" }, { mid: "0", kind: "camera" }]),
    /does not match/,
  );
});
