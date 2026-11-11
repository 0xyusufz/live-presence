import assert from "node:assert/strict";
import { test } from "node:test";
import { VideoPlayback, stopViewerMediaTracks } from "./viewer-media.js";

class MockVideo extends EventTarget {
  private attachedSource: MediaProvider | null = null;
  srcObjectAssignments: Array<{ source: MediaProvider | null; muted: boolean }> = [];
  muted = false;
  paused = true;
  playCalls = 0;
  playResult: () => Promise<void> = () => {
    return Promise.resolve().then(() => {
      this.paused = false;
    });
  };

  get srcObject(): MediaProvider | null {
    return this.attachedSource;
  }

  set srcObject(source: MediaProvider | null) {
    this.attachedSource = source;
    this.srcObjectAssignments.push({ source, muted: this.muted });
  }

  play(): Promise<void> {
    this.playCalls += 1;
    assert.equal(this.muted, true, "playback must be attempted only after muting");
    return this.playResult();
  }
}

class MockStream extends EventTarget {
  tracks: MediaStreamTrack[] = [];

  getTracks(): MediaStreamTrack[] {
    return this.tracks;
  }

  addTrack(track: MediaStreamTrack): void {
    this.tracks.push(track);
    this.dispatchEvent(Object.assign(new Event("addtrack"), { track }));
  }
}

const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test("a fresh screen stream starts playback after being attached", async () => {
  const screenVideo = new MockVideo();
  const screenStream = new MockStream();
  const screenPlayback = new VideoPlayback();
  screenPlayback.setVideo(screenVideo as unknown as HTMLVideoElement);
  screenPlayback.setStream(screenStream as unknown as MediaStream);

  assert.equal(screenVideo.srcObject, screenStream);
  assert.deepEqual(screenVideo.srcObjectAssignments[0], { source: screenStream, muted: true });
  assert.equal(screenVideo.paused, true);
  await tick();

  assert.equal(screenVideo.paused, false);
  assert.equal(screenVideo.playCalls, 1);
  screenPlayback.clear();
});

test("restored screen and camera streams start playback independently", async () => {
  const screenVideo = new MockVideo();
  const cameraVideo = new MockVideo();
  const screenStream = new MockStream();
  const cameraStream = new MockStream();
  const screenPlayback = new VideoPlayback();
  const cameraPlayback = new VideoPlayback();
  screenPlayback.setStream(screenStream as unknown as MediaStream);
  cameraPlayback.setStream(cameraStream as unknown as MediaStream);
  screenPlayback.setVideo(screenVideo as unknown as HTMLVideoElement);
  cameraPlayback.setVideo(cameraVideo as unknown as HTMLVideoElement);

  await tick();

  assert.equal(screenVideo.srcObject, screenStream);
  assert.equal(cameraVideo.srcObject, cameraStream);
  assert.deepEqual(screenVideo.srcObjectAssignments[0], { source: screenStream, muted: true });
  assert.deepEqual(cameraVideo.srcObjectAssignments[0], { source: cameraStream, muted: true });
  assert.equal(screenVideo.playCalls, 1);
  assert.equal(cameraVideo.playCalls, 1);
  assert.equal(screenVideo.paused, false);
  assert.equal(cameraVideo.paused, false);
  screenPlayback.clear();
  cameraPlayback.clear();
});

test("replacement streams restart playback and stop sharing detaches the old stream", async () => {
  const video = new MockVideo();
  const originalStream = new MockStream();
  const playback = new VideoPlayback();
  playback.setVideo(video as unknown as HTMLVideoElement);
  playback.setStream(originalStream as unknown as MediaStream);
  await tick();
  assert.equal(video.playCalls, 1);

  const replacementStream = new MockStream();
  playback.setStream(replacementStream as unknown as MediaStream);
  await tick();

  assert.equal(video.srcObject, replacementStream);
  assert.equal(video.playCalls, 2);

  playback.setStream(undefined);
  assert.equal(video.srcObject, null);
  playback.clear();
});

test("playback retries are bounded, rejected promises are handled, and cleanup removes retry events", async () => {
  const video = new MockVideo();
  video.playResult = () => Promise.reject(new Error("autoplay blocked"));
  const stream = new MockStream();
  const playback = new VideoPlayback();
  playback.setVideo(video as unknown as HTMLVideoElement);
  playback.setStream(stream as unknown as MediaStream);
  await tick();
  video.dispatchEvent(new Event("canplay"));
  await tick();
  video.dispatchEvent(new Event("loadedmetadata"));
  await tick();
  video.dispatchEvent(new Event("canplay"));
  await tick();

  assert.equal(video.playCalls, 3);
  playback.clear();
  video.dispatchEvent(new Event("canplay"));
  await tick();
  assert.equal(video.playCalls, 3);
});

test("a newly available track retries playback without render-driven calls", async () => {
  const video = new MockVideo();
  let attempts = 0;
  video.playResult = () => {
    attempts += 1;
    if (attempts === 1) return Promise.reject(new Error("stream not ready"));
    video.paused = false;
    return Promise.resolve();
  };
  const stream = new MockStream();
  const playback = new VideoPlayback();
  playback.setVideo(video as unknown as HTMLVideoElement);
  playback.setStream(stream as unknown as MediaStream);
  await tick();
  assert.equal(video.playCalls, 1);

  const track = new EventTarget();
  stream.addTrack(track as unknown as MediaStreamTrack);
  await tick();

  assert.equal(video.playCalls, 2);
  assert.equal(video.paused, false);
  playback.clear();
});

test("replacement video element plays an already attached stream", async () => {
  const playback = new VideoPlayback();
  const stream = new MockStream();
  const firstVideo = new MockVideo();
  playback.setStream(stream as unknown as MediaStream);
  playback.setVideo(firstVideo as unknown as HTMLVideoElement);
  await tick();
  assert.equal(firstVideo.playCalls, 1);

  const replacementVideo = new MockVideo();
  playback.setVideo(replacementVideo as unknown as HTMLVideoElement);
  await tick();

  assert.equal(firstVideo.srcObject, null);
  assert.equal(replacementVideo.srcObject, stream);
  assert.deepEqual(replacementVideo.srcObjectAssignments[0], { source: stream, muted: true });
  assert.equal(replacementVideo.playCalls, 1);
  assert.equal(replacementVideo.paused, false);
  playback.clear();
});

test("explicit disconnect stops screen and camera media tracks", () => {
  let screenStops = 0;
  let cameraStops = 0;
  const screen = { getTracks: () => [{ stop: () => { screenStops += 1; } }] };
  const camera = { getTracks: () => [{ stop: () => { cameraStops += 1; } }] };

  stopViewerMediaTracks(
    screen as unknown as MediaStream,
    camera as unknown as MediaStream,
  );

  assert.equal(screenStops, 1);
  assert.equal(cameraStops, 1);
});
