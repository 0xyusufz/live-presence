import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WebRtcPeer,
  type WebRtcConfiguration,
  type WebRtcDiagnostic,
  type WebRtcPeerConnection,
  type WebRtcTransceiver,
} from "./webrtc.js";
import { validTrackMap, type TrackMap } from "./protocol.js";

class MockConnection implements WebRtcPeerConnection {
  transceivers: WebRtcTransceiver[] = [];
  connectionState = "new";
  iceConnectionState = "new";
  signalingState = "stable";
  onicecandidate: ((event: { candidate: unknown | null }) => void) | null = null;
  ontrack: WebRtcPeerConnection["ontrack"] = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  closed = false;
  remote: unknown;
  local: unknown;
  candidates: unknown[] = [];
  replaceCalls: Array<{ index: number; track: unknown }> = [];
  offerCalls = 0;
  answerCalls = 0;
  failOfferCount = 0;
  failAddIce = false;
  remoteDescriptionError: Error | undefined;
  answerError: Error | undefined;
  localDescriptionError: Error | undefined;
  hasAppliedRemoteOffer = false;
  addTransceiver(_kind: string, init: { direction: "sendonly" | "recvonly" }): WebRtcTransceiver {
    const index = this.transceivers.length;
    const tx: WebRtcTransceiver = {
      mid: String(index),
      currentDirection: null,
      direction: init.direction,
      sender: { replaceTrack: async (track) => { this.replaceCalls.push({ index, track }); } },
    };
    this.transceivers.push(tx);
    return tx;
  }
  async createOffer() {
    this.offerCalls += 1;
    if (this.failOfferCount > 0) {
      this.failOfferCount -= 1;
      throw new Error("offer failed");
    }
    return { type: "offer" as const, sdp: `offer-${this.offerCalls}` };
  }
  async createAnswer() {
    this.answerCalls += 1;
    if (this.answerError) throw this.answerError;
    return { type: "answer" as const, sdp: "answer" };
  }
  async setLocalDescription(value: unknown) {
    if (this.localDescriptionError) throw this.localDescriptionError;
    this.local = value;
    if (
      typeof value === "object" && value !== null &&
      "type" in value && value.type === "answer"
    ) this.signalingState = "stable";
    for (const transceiver of this.transceivers) {
      transceiver.currentDirection = transceiver.direction;
    }
  }
  async setRemoteDescription(value: unknown) {
    if (this.remoteDescriptionError) throw this.remoteDescriptionError;
    this.remote = value;
    if (
      typeof value === "object" && value !== null &&
      "type" in value && value.type === "offer" &&
      "sdp" in value && typeof value.sdp === "string"
    ) {
      this.signalingState = "have-remote-offer";
      if (!this.hasAppliedRemoteOffer) {
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
        this.hasAppliedRemoteOffer = true;
      }
    }
    this.ontrack?.({ track: { kind: "video" }, transceiver: { mid: "1" } });
  }
  async addIceCandidate(value: unknown) {
    if (this.failAddIce) throw new Error("candidate failed");
    this.candidates.push(value);
  }
  setConfiguration(_configuration: WebRtcConfiguration): void {}
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

test("viewer relies on remote offer sections to create and negotiate recvonly transceivers", async () => {
  const connection = new MockConnection();
  const messages: unknown[] = [];
  const peer = new WebRtcPeer("viewer", "session", () => connection, (message) => messages.push(message));
  assert.equal(connection.transceivers.length, 0);
  assert.equal(connection.signalingState, "stable");
  await peer.acceptOffer("offer", [{ mid: "0", kind: "screen" }, { mid: "1", kind: "camera" }]);
  assert.equal(connection.signalingState, "stable");
  assert.equal(connection.transceivers.length, 2);
  assert.deepEqual(connection.transceivers.map((tx) => tx.direction), ["recvonly", "recvonly"]);
  assert.deepEqual(connection.transceivers.map((tx) => tx.currentDirection), ["recvonly", "recvonly"]);
  assert.deepEqual(connection.transceivers.map((tx) => tx.mid), ["0", "1"]);
  assert.equal((messages[0] as { type: string }).type, "answer");
  connection.connectionState = "failed";
  connection.onconnectionstatechange?.();
  assert.equal(peer.state, "failed");
  peer.close();
  await assert.rejects(() => peer.addIceCandidate({}), /closed/);
});

test("viewer processes a two-media-section desktop offer and preserves canonical screen/camera MIDs", async () => {
  const connection = new MockConnection();
  const messages: unknown[] = [];
  const peer = new WebRtcPeer("viewer", "session", () => connection, (message) => messages.push(message));
  const sdp = [
    "v=0",
    "o=- 123 1 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    "a=group:BUNDLE 0 1",
    "m=video 9 UDP/TLS/RTP/SAVPF 96",
    "c=IN IP4 0.0.0.0",
    "a=mid:0",
    "a=sendonly",
    "a=rtpmap:96 VP8/90000",
    "m=video 9 UDP/TLS/RTP/SAVPF 96",
    "c=IN IP4 0.0.0.0",
    "a=mid:1",
    "a=sendonly",
    "a=rtpmap:96 VP8/90000",
    "",
  ].join("\r\n");
  await peer.acceptOffer(sdp, [
    { mid: "0", kind: "screen" },
    { mid: "1", kind: "camera" },
  ]);

  assert.equal(connection.transceivers.length, 2);
  assert.deepEqual(connection.transceivers.map((tx) => tx.mid), ["0", "1"]);
  assert.deepEqual(connection.transceivers.map((tx) => tx.direction), ["recvonly", "recvonly"]);
  assert.deepEqual(connection.transceivers.map((tx) => tx.currentDirection), ["recvonly", "recvonly"]);
  assert.deepEqual(messages, [{
    type: "answer",
    session_id: "session",
    sdp: "answer",
    track_map: [
      { mid: "0", kind: "screen" },
      { mid: "1", kind: "camera" },
    ],
  }]);
  peer.close();
});

test("viewer sends exactly one answer for a valid offer, including concurrent duplicate delivery", async () => {
  const connection = new MockConnection();
  const messages: unknown[] = [];
  const diagnostics: WebRtcDiagnostic[] = [];
  const peer = new WebRtcPeer("viewer", "session", () => connection, (message) => messages.push(message));
  peer.setDiagnosticListener((diagnostic) => diagnostics.push(diagnostic));
  const trackMap: TrackMap = [
    { mid: "0", kind: "screen" },
    { mid: "1", kind: "camera" },
  ];

  const first = peer.acceptOffer("valid-offer", trackMap);
  const duplicate = peer.acceptOffer("valid-offer", trackMap);
  await Promise.all([first, duplicate]);
  await peer.acceptOffer("valid-offer", trackMap);

  const answers = messages.filter((message) => (message as { type: string }).type === "answer");
  assert.equal(answers.length, 1);
  assert.deepEqual(answers[0], {
    type: "answer",
    session_id: "session",
    sdp: "answer",
    track_map: trackMap,
  });
  assert.equal(connection.answerCalls, 1);
  assert.deepEqual(
    diagnostics.filter((item) => item.operationStatus === "failed"),
    [],
  );
  assert.ok(diagnostics.some((item) => item.operation === "sendAnswer" && item.operationStatus === "succeeded"));
  peer.close();
});

test("viewer answer pipeline reports the exact failed SDP or signaling operation", async (t) => {
  const cases = [
    {
      operation: "setRemoteDescription" as const,
      message: /setRemoteDescription\(offer\) failed: rejected remote offer/,
      configure: (connection: MockConnection) => { connection.remoteDescriptionError = new Error("rejected remote offer"); },
    },
    {
      operation: "createAnswer" as const,
      message: /createAnswer\(\) failed: answer creation rejected/,
      configure: (connection: MockConnection) => { connection.answerError = new Error("answer creation rejected"); },
    },
    {
      operation: "setLocalDescription" as const,
      message: /setLocalDescription\(answer\) failed: local answer rejected/,
      configure: (connection: MockConnection) => { connection.localDescriptionError = new Error("local answer rejected"); },
    },
    {
      operation: "sendAnswer" as const,
      message: /Sending WebRTC answer through signaling failed: socket send rejected/,
      configure: (_connection: MockConnection) => {},
      failSend: true,
    },
  ];

  for (const item of cases) {
    await t.test(item.operation, async () => {
      const connection = new MockConnection();
      item.configure(connection);
      const diagnostics: WebRtcDiagnostic[] = [];
      const peer = new WebRtcPeer("viewer", "session", () => connection, (message) => {
        if (item.failSend && (message as { type: string }).type === "answer") {
          throw new Error("socket send rejected");
        }
      });
      peer.setDiagnosticListener((diagnostic) => diagnostics.push(diagnostic));
      await assert.rejects(
        () => peer.acceptOffer("valid-offer", [
          { mid: "0", kind: "screen" },
          { mid: "1", kind: "camera" },
        ]),
        item.message,
      );
      assert.ok(diagnostics.some((diagnostic) =>
        diagnostic.operation === item.operation && diagnostic.operationStatus === "failed"));
      peer.close();
    });
  }
});

test("viewer maps early remote tracks by negotiated mid after validating the offer map", async () => {
  const connection = new MockConnection();
  const peer = new WebRtcPeer("viewer", "session", () => connection, () => undefined);
  const received: Array<{ mid: string | null; kind?: string }> = [];
  peer.setRemoteTrackListener((_track, mid, kind) => received.push({ mid, kind }));

  await peer.acceptOffer("offer", [
    { mid: "0", kind: "screen" },
    { mid: "1", kind: "camera" },
  ]);

  assert.deepEqual(received, [{ mid: "1", kind: "camera" }]);
  peer.close();
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

test("owner and viewer complete a bounded ICE restart after initial negotiation", async () => {
  const ownerMessages: unknown[] = [];
  const viewerMessages: unknown[] = [];
  const ownerConnection = new MockConnection();
  const viewerConnection = new MockConnection();
  const owner = new WebRtcPeer("owner", "session", () => ownerConnection, (message) => ownerMessages.push(message));
  const viewer = new WebRtcPeer("viewer", "session", () => viewerConnection, (message) => viewerMessages.push(message));

  await owner.createOffer();
  await viewer.acceptOffer("offer", [{ mid: "0", kind: "screen" }, { mid: "1", kind: "camera" }]);
  await owner.acceptAnswer("answer");
  ownerConnection.connectionState = "disconnected";
  ownerConnection.onconnectionstatechange?.();
  viewerConnection.connectionState = "disconnected";
  viewerConnection.onconnectionstatechange?.();

  await owner.createOffer({ iceRestart: true });
  const restartOffer = ownerMessages.at(-1) as { sdp: string; track_map: [{ mid: string; kind: "screen" }, { mid: string; kind: "camera" }] };
  await viewer.acceptOffer(restartOffer.sdp, restartOffer.track_map);
  const restartAnswer = viewerMessages.at(-1) as { sdp: string };
  await owner.acceptAnswer(restartAnswer.sdp);
  assert.equal(owner.state, "disconnected");
  await assert.rejects(() => viewer.acceptOffer("duplicate", restartOffer.track_map), /current state/);
});

test("owner can make a second restart after the first offer is abandoned", async () => {
  const connection = new MockConnection();
  const owner = new WebRtcPeer("owner", "session", () => connection, () => undefined);
  await owner.createOffer();
  await owner.acceptAnswer("answer");
  connection.connectionState = "failed";
  connection.onconnectionstatechange?.();
  await owner.createOffer({ iceRestart: true });
  assert.equal(connection.offerCalls, 2);
  await assert.rejects(() => owner.createOffer({ iceRestart: true }), /current state/);
  owner.markRestartOfferFailed();
  await owner.createOffer({ iceRestart: true });
  assert.equal(connection.offerCalls, 3);
});

test("viewer accepts restart only after recovery and rejects it while answering", async () => {
  const connection = new MockConnection();
  const viewer = new WebRtcPeer("viewer", "session", () => connection, () => undefined);
  const trackMap: TrackMap = [{ mid: "0", kind: "screen" }, { mid: "1", kind: "camera" }];
  await viewer.acceptOffer("offer", trackMap);
  await assert.rejects(() => viewer.acceptOffer("restart", trackMap), /current state/);
  connection.connectionState = "failed";
  connection.onconnectionstatechange?.();
  await viewer.acceptOffer("restart", trackMap);
  await assert.rejects(() => viewer.acceptOffer("duplicate", trackMap), /current state/);
});
