import assert from "node:assert/strict";
import test from "node:test";
import {
  acquireLiveScreenTrack,
  confirmLiveScreenCapture,
  sharingStatus,
  stopCapturedTracks,
} from "./sharing-status.js";

test("desktop sharing status never reports idle while capture is live", () => {
  assert.equal(sharingStatus("live", "IDLE", false), "Sharing / connecting");
  assert.equal(sharingStatus("live", "NEGOTIATING", false), "Sharing / connecting");
  assert.equal(sharingStatus("live", "CONNECTED", false), "Connected");
  assert.equal(sharingStatus("live", "FAILED", true), "Failed");
});

test("desktop sharing status distinguishes preparation and stopped capture", () => {
  assert.equal(sharingStatus("preparing", "IDLE", false), "Preparing");
  assert.equal(sharingStatus("idle", "CONNECTED", false), "Not sharing");
});

test("stopping sharing ends both independently captured media tracks", () => {
  const stopped: string[] = [];
  stopCapturedTracks(
    { stop: () => stopped.push("screen") },
    { stop: () => stopped.push("camera") },
  );
  assert.deepEqual(stopped, ["screen", "camera"]);
});

test("failed display capture cannot proceed to the active-confirmation boundary", async () => {
  let activeConfirmationCalls = 0;
  await assert.rejects(() => acquireLiveScreenTrack(async () => {
    throw new Error("permission denied");
  }), /permission denied/);
  assert.equal(activeConfirmationCalls, 0);

  const stopped: string[] = [];
  const endedTrack = {
    readyState: "ended",
    stop: () => stopped.push("ended"),
  } as unknown as MediaStreamTrack;
  await assert.rejects(() => acquireLiveScreenTrack(async () => ({
    getVideoTracks: () => [endedTrack],
    getTracks: () => [endedTrack],
  } as unknown as MediaStream)), /No live screen track/);
  assert.deepEqual(stopped, ["ended"]);
  await assert.rejects(() => confirmLiveScreenCapture(endedTrack, async () => {
    activeConfirmationCalls += 1;
  }), /ended before capture confirmation/);
  assert.equal(activeConfirmationCalls, 0);

  await confirmLiveScreenCapture({ readyState: "live" }, async () => {
    activeConfirmationCalls += 1;
  });
  assert.equal(activeConfirmationCalls, 1);
});
