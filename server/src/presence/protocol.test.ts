import assert from "node:assert/strict";
import { test } from "node:test";
import { parseClientMessage, parseServerMessage } from "../../../shared/src/protocol.js";

const sessionId = "123e4567-e89b-12d3-a456-426614174000";
const deviceId = "123e4567-e89b-12d3-a456-426614174001";
const negotiationId = "negotiation-1";

test("protocol parser accepts documented snake_case messages", () => {
  assert.deepEqual(parseServerMessage({ type: "heartbeat_ack" }), { type: "heartbeat_ack" });
  assert.deepEqual(parseServerMessage({
    type: "session_recovery",
    session_id: sessionId,
    recovery_attempt_id: "recovery-attempt-1",
  }), {
    type: "session_recovery",
    session_id: sessionId,
    recovery_attempt_id: "recovery-attempt-1",
  });
  assert.deepEqual(parseClientMessage({ type: "create_session", device_id: deviceId }), {
    type: "create_session",
    device_id: deviceId,
  });
  assert.deepEqual(parseClientMessage({
    type: "offer",
    session_id: sessionId,
    negotiation_id: negotiationId,
    sdp: "v=0",
    track_map: [{ mid: "0", kind: "screen" }, { mid: "1", kind: "camera" }],
  }), {
    type: "offer",
    session_id: sessionId,
    negotiation_id: negotiationId,
    sdp: "v=0",
    track_map: [{ mid: "0", kind: "screen" }, { mid: "1", kind: "camera" }],
  });
  assert.deepEqual(parseServerMessage({
    type: "sharing_state_updated",
    device_id: deviceId,
    screen: true,
    camera: false,
  }), {
    type: "sharing_state_updated",
    device_id: deviceId,
    screen: true,
    camera: false,
  });
});

test("protocol parser accepts a valid owner recovery grace on session attachment", () => {
  assert.deepEqual(parseServerMessage({
    type: "session_attached",
    session_id: sessionId,
    device_id: deviceId,
    screen: true,
    camera: false,
    owner_recovery_remaining_ms: 45_000,
  }), {
    type: "session_attached",
    session_id: sessionId,
    device_id: deviceId,
    screen: true,
    camera: false,
    owner_recovery_remaining_ms: 45_000,
  });
  assert.equal(parseServerMessage({
    type: "session_attached",
    session_id: sessionId,
    device_id: deviceId,
    screen: true,
    camera: false,
    owner_recovery_remaining_ms: 0,
  }), null);
});

test("protocol parser rejects unknown, camelCase, malformed and oversized messages", () => {
  assert.equal(parseServerMessage({ type: "heartbeat_ack", extra: true }), null);
  assert.equal(parseServerMessage({
    type: "session_recovery",
    session_id: sessionId,
    recovery_attempt_id: "invalid recovery id",
  }), null);
  assert.equal(parseClientMessage({ type: "unknown" }), null);
  assert.equal(parseClientMessage({ type: "create_session", deviceId }), null);
  assert.equal(parseClientMessage({ type: "offer", session_id: sessionId, sdp: "v=0" }), null);
  assert.equal(parseClientMessage({
    type: "offer",
    session_id: sessionId,
    negotiation_id: negotiationId,
    sdp: "x".repeat(65 * 1024),
  }), null);
  assert.equal(parseClientMessage({
    type: "offer",
    session_id: sessionId,
    negotiation_id: negotiationId,
    sdp: "v=0",
    track_map: [{ mid: "0", kind: "screen" }, { mid: "1", kind: "camera" }, { mid: "2", kind: "screen" }],
  }), null);
  assert.equal(parseClientMessage({
    type: "ice_candidate",
    session_id: sessionId,
    negotiation_id: negotiationId,
    candidate: { value: "x".repeat(33 * 1024) },
  }), null);
  assert.equal(parseClientMessage({ type: "leave_session", session_id: "not-a-session" }), null);
});
