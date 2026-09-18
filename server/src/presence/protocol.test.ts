import assert from "node:assert/strict";
import { test } from "node:test";
import { parseClientMessage } from "../../../shared/src/protocol.js";

const sessionId = "123e4567-e89b-12d3-a456-426614174000";
const deviceId = "123e4567-e89b-12d3-a456-426614174001";

test("protocol parser accepts documented snake_case messages", () => {
  assert.deepEqual(parseClientMessage({ type: "create_session", device_id: deviceId }), {
    type: "create_session",
    device_id: deviceId,
  });
  assert.deepEqual(parseClientMessage({
    type: "offer",
    session_id: sessionId,
    sdp: "v=0",
    track_map: [{ mid: "0", kind: "screen" }, { mid: "1", kind: "camera" }],
  }), {
    type: "offer",
    session_id: sessionId,
    sdp: "v=0",
    track_map: [{ mid: "0", kind: "screen" }, { mid: "1", kind: "camera" }],
  });
});

test("protocol parser rejects unknown, camelCase, malformed and oversized messages", () => {
  assert.equal(parseClientMessage({ type: "unknown" }), null);
  assert.equal(parseClientMessage({ type: "create_session", deviceId }), null);
  assert.equal(parseClientMessage({ type: "offer", session_id: sessionId, sdp: "x".repeat(65 * 1024) }), null);
  assert.equal(parseClientMessage({
    type: "offer",
    session_id: sessionId,
    sdp: "v=0",
    track_map: [{ mid: "0", kind: "screen" }, { mid: "1", kind: "camera" }, { mid: "2", kind: "screen" }],
  }), null);
  assert.equal(parseClientMessage({
    type: "ice_candidate",
    session_id: sessionId,
    candidate: { value: "x".repeat(33 * 1024) },
  }), null);
  assert.equal(parseClientMessage({ type: "leave_session", session_id: "not-a-session" }), null);
});
