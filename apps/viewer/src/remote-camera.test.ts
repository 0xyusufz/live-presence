import assert from "node:assert/strict";
import { test } from "node:test";
import { RemoteCameraMedia } from "./remote-camera.js";

class MockCameraTrack extends EventTarget {
  readyState = "live";
  muted = false;

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.dispatchEvent(new Event(muted ? "mute" : "unmute"));
  }

  stop(): void {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
}

test("camera off detaches the old frame and camera on reattaches the resumed track", () => {
  const video: { srcObject: MediaStream | null } = { srcObject: null };
  const streams: Array<MediaStream | undefined> = [];
  const track = new MockCameraTrack();
  const media = new RemoteCameraMedia({
    onStream: (stream) => {
      streams.push(stream);
      if (stream) video.srcObject = stream;
    },
    detachVideo: () => { video.srcObject = null; },
    createStream: (value) => ({ track: value } as unknown as MediaStream),
  });

  media.setTrack(track as unknown as MediaStreamTrack);
  media.setEnabled(true);
  assert.ok(video.srcObject);

  media.setEnabled(false);
  assert.equal(video.srcObject, null);
  assert.equal(streams.at(-1), undefined);

  track.setMuted(true);
  media.setEnabled(true);
  assert.equal(video.srcObject, null);

  track.setMuted(false);
  assert.ok(video.srcObject);
  assert.equal(streams.filter(Boolean).length, 2);
  media.clear();
  assert.equal(video.srcObject, null);
});

test("camera media ignores stale events from a replaced receiver track", () => {
  const streams: Array<MediaStream | undefined> = [];
  const media = new RemoteCameraMedia({
    onStream: (stream) => streams.push(stream),
    detachVideo: () => {},
    createStream: (track) => ({ track } as unknown as MediaStream),
  });
  const previous = new MockCameraTrack();
  const current = new MockCameraTrack();
  media.setEnabled(true);
  media.setTrack(previous as unknown as MediaStreamTrack);
  media.setTrack(current as unknown as MediaStreamTrack);
  const beforeStaleEvent = streams.length;

  previous.setMuted(true);
  previous.setMuted(false);
  assert.equal(streams.length, beforeStaleEvent);
  assert.ok(streams.at(-1));
  media.clear();
});
