import assert from "node:assert/strict";
import test from "node:test";
import type { CaptureCleanupReason } from "../ipc-contract.js";
import {
  attachApprovedTracks,
  acquireLiveScreenTrack,
  confirmLiveScreenCapture,
  detachOwnerClientAfterCaptureStop,
  inspectScreenVideoTracks,
  removeApprovedCameraTrack,
  replaceApprovedCameraTrack,
  reuseOrCreateOwnerClient,
  sharingStatus,
  setApprovedCameraTrack,
  stopCapturedTracks,
} from "./sharing-status.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

test("desktop sharing status never reports idle while capture is live", () => {
  assert.equal(sharingStatus("live", "IDLE", false), "Sharing locally — Viewer disconnected");
  assert.equal(sharingStatus("live", "CONNECTING", false), "Sharing locally — Connecting");
  assert.equal(sharingStatus("live", "NEGOTIATING", false), "Sharing locally — Negotiating");
  assert.equal(sharingStatus("live", "CONNECTED", false), "Sharing — Connected");
  assert.equal(sharingStatus("live", "RECONNECTING", false), "Sharing locally — Reconnecting");
  assert.equal(sharingStatus("live", "FAILED", true), "Failed");
});

test("desktop sharing status distinguishes preparation and stopped capture", () => {
  assert.equal(sharingStatus("preparing", "IDLE", false), "Preparing");
  assert.equal(sharingStatus("idle", "CONNECTED", false), "Not sharing");
});

test("capture stop detaches the owner client and an explicit share creates a fresh usable client", () => {
  let stopCalls = 0;
  let closeCalls = 0;
  const staleClient = {
    lifecycle: "FAILED",
    async stopSharingSession() { stopCalls += 1; },
    close() { closeCalls += 1; },
  };
  const current: { client?: typeof staleClient } = { client: staleClient };

  detachOwnerClientAfterCaptureStop(current, true, "explicit_user_stop");
  assert.equal(current.client, undefined);
  assert.equal(stopCalls, 1);
  assert.equal(closeCalls, 1);

  let createCalls = 0;
  let startCalls = 0;
  const freshClient = {
    lifecycle: "IDLE",
    close() {},
  };
  const reused = reuseOrCreateOwnerClient(current, () => {
    createCalls += 1;
    return freshClient;
  }, () => { startCalls += 1; });
  assert.equal(reused, freshClient);
  assert.equal(current.client, freshClient);
  assert.equal(createCalls, 1);
  assert.equal(startCalls, 1);

  const reusedAgain = reuseOrCreateOwnerClient(current, () => {
    throw new Error("must not create a duplicate client");
  }, () => { throw new Error("must not start an existing client"); });
  assert.equal(reusedAgain, freshClient);
});

test("capture cleanup forwards each explicit typed reason to the owner client", () => {
  const reasons: CaptureCleanupReason[] = [
    "explicit_user_stop",
    "track_ended",
    "resume_ineligible",
    "safety_stop",
    "terminal_failure",
    "setup_failure",
  ];

  for (const reason of reasons) {
    let receivedReason: CaptureCleanupReason | undefined;
    const current = {
      client: {
        async stopSharingSession(stopReason?: CaptureCleanupReason) { receivedReason = stopReason; },
        close() {},
      },
    };

    detachOwnerClientAfterCaptureStop(current, true, reason);
    assert.equal(receivedReason, reason);
  }
});

test("terminal owner clients are closed and never reused", () => {
  for (const lifecycle of ["FAILED", "CLOSING", "CLOSED"] as const) {
    let closeCalls = 0;
    let createCalls = 0;
    const stale = {
      lifecycle,
      close() { closeCalls += 1; },
    };
    const current: { client?: typeof stale } = { client: stale };
    const fresh = {
      lifecycle: "IDLE",
      close() {},
    };
    const result = reuseOrCreateOwnerClient(current, () => {
      createCalls += 1;
      return fresh;
    });
    assert.equal(result, fresh);
    assert.equal(closeCalls, 1);
    assert.equal(createCalls, 1);
  }
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

test("successful display capture confirms only a live video track and stops unused tracks", async () => {
  const stopped: string[] = [];
  const screen = {
    readyState: "live",
    stop: () => stopped.push("screen"),
  } as unknown as MediaStreamTrack;
  const audio = { stop: () => stopped.push("audio") } as unknown as MediaStreamTrack;
  const stream = {
    getVideoTracks: () => [screen],
    getTracks: () => [screen, audio],
  } as unknown as MediaStream;
  const acquired = await acquireLiveScreenTrack(async () => stream);
  assert.equal(acquired, screen);
  assert.deepEqual(stopped, ["audio"]);

  let activeConfirmationCalls = 0;
  await confirmLiveScreenCapture(acquired, async () => {
    activeConfirmationCalls += 1;
  });
  assert.equal(activeConfirmationCalls, 1);
});

test("screen video-track inspection exceptions remain available to the validation failure path", () => {
  const enumerationError = new Error("track enumeration failed");
  assert.throws(() => inspectScreenVideoTracks({
    getVideoTracks: () => { throw enumerationError; },
  } as unknown as MediaStream), enumerationError);

  const stateError = new Error("track state unavailable");
  const track = Object.defineProperty({}, "readyState", {
    get: () => { throw stateError; },
  }) as MediaStreamTrack;
  assert.throws(() => inspectScreenVideoTracks({
    getVideoTracks: () => [track],
  } as unknown as MediaStream), stateError);
});

test("camera removal during peer attachment reconciles the final camera track without stopping screen", async () => {
  const cameraA = { readyState: "live" as const };
  const screen = { readyState: "live" as const };
  const current = { generation: 1, screen, camera: cameraA };
  const cameraAttachment = deferred<void>();
  const cameraStarted = deferred<void>();
  const attached: Array<typeof cameraA | null> = [];
  const peer = {
    replaceTrack: async (kind: "screen" | "camera", track: typeof cameraA | null) => {
      if (kind === "screen") return;
      attached.push(track);
      if (track === cameraA && attached.length === 1) {
        cameraStarted.resolve();
        await cameraAttachment.promise;
      }
    },
  };

  const attaching = attachApprovedTracks(peer, current, 1);
  await cameraStarted.promise;
  setApprovedCameraTrack(current, undefined);
  const removing = replaceApprovedCameraTrack(current, 1, (track) => peer.replaceTrack("camera", track));
  cameraAttachment.resolve();
  await Promise.all([attaching, removing]);

  assert.deepEqual(attached, [cameraA, null, null]);
  assert.equal(current.screen, screen);
  assert.equal(current.generation, 1);
});

test("late camera attachment cannot detach a newer approved camera", async () => {
  const cameraA = { readyState: "live" as const };
  const cameraB = { readyState: "live" as const };
  const current = { generation: 2, screen: { readyState: "live" as const }, camera: cameraA };
  const cameraAAttachment = deferred<void>();
  const attached: Array<typeof cameraA | typeof cameraB | null> = [];
  const replaceTrack = async (track: typeof cameraA | typeof cameraB | null) => {
    attached.push(track);
    if (track === cameraA && attached.length === 1) await cameraAAttachment.promise;
  };

  const attaching = replaceApprovedCameraTrack(current, 2, replaceTrack);
  await Promise.resolve();
  setApprovedCameraTrack(current, cameraB);
  const replacing = replaceApprovedCameraTrack(current, 2, replaceTrack);
  cameraAAttachment.resolve();
  await Promise.all([attaching, replacing]);

  assert.deepEqual(attached, [cameraA, cameraB]);
  assert.equal(current.camera, cameraB);
  assert.equal(current.screen?.readyState, "live");
});

test("toggle-camera removal stops the old camera without stale side effects after capture invalidation", async () => {
  const oldCamera = {
    readyState: "live" as const,
    stopped: false,
    stop() { this.stopped = true; },
  };
  const screen = { readyState: "live" as const };
  const current: {
    generation: number;
    screen?: typeof screen;
    camera?: typeof oldCamera;
  } = { generation: 1, screen, camera: oldCamera };
  const replacement = deferred<void>();
  const sideEffects: string[] = [];

  setApprovedCameraTrack(current, undefined);
  const removal = removeApprovedCameraTrack(
    current,
    1,
    oldCamera,
    async () => replacement.promise,
    async () => { sideEffects.push("camera-intent-false"); },
    async (_screen, _camera) => { sideEffects.push("sharing-state"); },
    () => { sideEffects.push("removed"); },
  );
  current.generation += 1;
  current.screen = undefined;
  replacement.resolve();
  await removal;

  assert.equal(oldCamera.stopped, true);
  assert.deepEqual(sideEffects, []);
});

test("camera-failure removal stops the old camera without stale side effects after capture invalidation", async () => {
  const oldCamera = {
    readyState: "live" as const,
    stopped: false,
    stop() { this.stopped = true; },
  };
  const screen = { readyState: "live" as const };
  const current: {
    generation: number;
    screen?: typeof screen;
    camera?: typeof oldCamera;
  } = { generation: 3, screen, camera: oldCamera };
  const replacement = deferred<void>();
  const sideEffects: string[] = [];

  setApprovedCameraTrack(current, undefined);
  const removal = removeApprovedCameraTrack(
    current,
    3,
    oldCamera,
    async () => replacement.promise,
    async () => { sideEffects.push("camera-intent-false"); },
    async (_screen, _camera) => { sideEffects.push("sharing-state"); },
    () => { sideEffects.push("removed"); },
    () => { sideEffects.push("replacement-failed-message"); },
  );
  current.generation += 1;
  current.screen = undefined;
  replacement.resolve();
  await removal;

  assert.equal(oldCamera.stopped, true);
  assert.deepEqual(sideEffects, []);
});

test("normal camera removal publishes camera off while screen sharing remains active", async () => {
  const camera = {
    readyState: "live" as const,
    stopped: false,
    stop() { this.stopped = true; },
  };
  const screen = { readyState: "live" as const };
  const current = { generation: 5, screen, camera: camera as typeof camera | undefined };
  const replacement = deferred<void>();
  const sideEffects: string[] = [];

  setApprovedCameraTrack(current, undefined);
  const removal = removeApprovedCameraTrack(
    current,
    5,
    camera,
    async () => replacement.promise,
    async (enabled) => { sideEffects.push(`camera-intent-${enabled}`); },
    async (screenEnabled, cameraEnabled) => {
      sideEffects.push(`sharing-${screenEnabled}-${cameraEnabled}`);
    },
    () => { sideEffects.push("removed"); },
  );
  replacement.resolve();
  await removal;

  assert.equal(camera.stopped, true);
  assert.deepEqual(sideEffects, [
    "camera-intent-false",
    "sharing-true-false",
    "removed",
  ]);
  assert.equal(current.screen, screen);
});
