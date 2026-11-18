import assert from "node:assert/strict";
import { test } from "node:test";
import {
  displayCaptureFailureCategory,
  displayCaptureFailureMessage,
  displayMediaSelection,
  selectedDisplaySource,
} from "./capture-utils.js";

test("display capture uses the explicitly selected source from the picker snapshot", () => {
  const source = { id: "screen:1:0", name: "Display 1" };
  const available = new Map([[source.id, source]]);

  assert.equal(selectedDisplaySource(available, source.id), source);
  assert.deepEqual(displayMediaSelection(source), { video: source });
});

test("missing and empty picker sources cannot be reported as a successful video selection", () => {
  const source = { id: "window:7:0", name: "Window" };
  assert.equal(selectedDisplaySource(new Map([[source.id, source]]), "stale-source"), null);
  assert.deepEqual(displayMediaSelection(null), {});
});

test("Electron missing-video rejection gets a clear safe capture failure", () => {
  const error = new TypeError("Video was requested, but no video stream was provided");
  assert.equal(displayCaptureFailureCategory(error), "video_stream_not_provided");
  assert.match(displayCaptureFailureMessage(error), /returned no video stream/);
  assert.match(displayCaptureFailureMessage(error), /macOS Screen & System Audio Recording permission/);

  assert.equal(
    displayCaptureFailureCategory(new DOMException("denied", "NotAllowedError")),
    "permission_or_consent_denied",
  );
  assert.match(
    displayCaptureFailureMessage(new DOMException("denied", "NotAllowedError")),
    /macOS denied screen-capture access/,
  );
});
