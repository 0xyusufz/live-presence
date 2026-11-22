import assert from "node:assert/strict";
import test from "node:test";
import {
  captureCleanupDiagnostic,
  trackLifecycleDiagnostic,
} from "./capture-lifecycle-diagnostics.js";

function track(id: string, readyState: "live" | "ended", muted: boolean): MediaStreamTrack {
  return {
    id,
    readyState,
    muted,
    enabled: true,
  } as MediaStreamTrack;
}

test("track lifecycle diagnostics identify the media track and sleep/capture generation", () => {
  const diagnostic = trackLifecycleDiagnostic(
    track("screen-track-1", "ended", false),
    "screen",
    "ended",
    7,
    3,
    "started",
  );

  assert.equal(diagnostic.event, "screen_track_ended");
  assert.deepEqual(diagnostic.details, {
    stage: "track_lifecycle",
    trackId: "screen-track-1",
    trackKind: "screen",
    trackEvent: "ended",
    readyState: "ended",
    enabled: true,
    muted: false,
    captureGeneration: 7,
    cycleId: 3,
    sleepRecoveryState: "started",
    reason: "ended_event",
  });
});

test("capture cleanup diagnostics preserve the actual reason and pre-cleanup track state", () => {
  const details = captureCleanupDiagnostic(
    track("screen-track-2", "live", true),
    track("camera-track-2", "ended", false),
    9,
    4,
    "eligible",
    "resume_ineligible",
  );

  assert.equal(details.cleanupReason, "resume_ineligible");
  assert.equal(details.captureGeneration, 9);
  assert.equal(details.cycleId, 4);
  assert.equal(details.sleepRecoveryState, "eligible");
  assert.equal(details.screenTrackId, "screen-track-2");
  assert.equal(details.screenReadyState, "live");
  assert.equal(details.screenMuted, true);
  assert.equal(details.cameraTrackId, "camera-track-2");
  assert.equal(details.cameraReadyState, "ended");
});
