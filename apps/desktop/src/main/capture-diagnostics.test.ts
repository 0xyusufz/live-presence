import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DesktopCapturerSource } from "electron";
import { acquireLiveScreenTrack } from "../renderer/sharing-status.js";
import { sharingStateSendEvent } from "../renderer/capture-diagnostic-events.js";
import {
  CaptureDiagnostics,
  type CaptureDiagnosticFileOperations,
} from "./capture-diagnostics.js";
import { DisplayCapturePicker } from "./display-capture.js";

class FakeWindow {
  webContents = {} as Electron.WebContents;
  listeners: Array<() => void> = [];

  isDestroyed(): boolean { return false; }
  close(): void { for (const listener of this.listeners) listener(); }
  on(_event: "closed", listener: () => void): void { this.listeners.push(listener); }
  once(_event: "ready-to-show", _listener: () => void): void {}
  loadURL(): Promise<void> { return Promise.resolve(); }
  show(): void {}
}

function missingFileError(): NodeJS.ErrnoException {
  const error = new Error("missing");
  Object.assign(error, { code: "ENOENT" });
  return error as NodeJS.ErrnoException;
}

test("capture diagnostics append curated events to the configured path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "live-presence-capture-"));
  const path = join(directory, "screen-capture.log");
  try {
    const diagnostics = new CaptureDiagnostics(() => path);
    diagnostics.log("screen_stream_acquisition_succeeded", {
      attemptId: "123e4567-e89b-42d3-a456-426614174000",
      requestId: 5,
      trackCount: 1,
      readyState: "live",
      enabled: true,
      muted: false,
    });
    await diagnostics.flush();

    const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    assert.equal(record.event, "screen_stream_acquisition_succeeded");
    assert.equal(record.attemptId, "123e4567-e89b-42d3-a456-426614174000");
    assert.equal(record.requestId, 5);
    assert.equal(record.trackCount, 1);
    assert.equal(record.readyState, "live");
    assert.equal(typeof record.timestamp, "string");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sleep, track, and cleanup lifecycle metadata is persisted through the allow-list", async () => {
  const directory = await mkdtemp(join(tmpdir(), "live-presence-capture-"));
  const path = join(directory, "screen-capture.log");
  try {
    const diagnostics = new CaptureDiagnostics(() => path);
    diagnostics.log("screen_track_ended", {
      timestampWallMs: 1_700_000_000_000,
      timestampMonotonicMs: 42.5,
      trackId: "screen-track-1",
      trackKind: "screen",
      trackEvent: "ended",
      readyState: "ended",
      enabled: true,
      muted: false,
      captureGeneration: 3,
      cycleId: 2,
      sleepRecoveryState: "started",
    });
    diagnostics.log("capture_cleanup", {
      cleanupReason: "track_ended",
      captureGeneration: 4,
      screenTrackId: "screen-track-1",
      screenReadyState: "ended",
      screenEnabled: true,
      screenMuted: false,
    });
    diagnostics.log("system_resume", {
      cycleId: 2,
      elapsedSinceSuspendMs: 30_000,
      screenPermissionStatus: "granted",
    });
    await diagnostics.flush();

    const records = (await readFile(path, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(records[0]?.trackId, "screen-track-1");
    assert.equal(records[0]?.trackEvent, "ended");
    assert.equal(records[0]?.timestampMonotonicMs, 42.5);
    assert.equal(records[0]?.cycleId, 2);
    assert.equal(records[1]?.cleanupReason, "track_ended");
    assert.equal(records[1]?.screenReadyState, "ended");
    assert.equal(records[2]?.elapsedSinceSuspendMs, 30_000);
    assert.equal(records[2]?.screenPermissionStatus, "granted");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unknown fields and malicious auth, SDP, ICE, URL, and path input are discarded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "live-presence-capture-"));
  const path = join(directory, "screen-capture.log");
  try {
    const diagnostics = new CaptureDiagnostics(() => path);
    diagnostics.log("screen_stream_acquisition_failed", {
      requestId: 9,
      errorMessage: "Authorization: Basic dG9rZW46c2VjcmV0",
      errorCategory: "Bearer bearer-secret",
      errorCode: "unlabeled-secret-value",
      reason: "v=0\r\na=ice-pwd:private-ice-password",
      stage: "wss://private.example/path?token=private-token",
      attemptId: "/Users/private-user/Documents/private-file",
      readyState: "file:///Users/private-user/.ssh/id_rsa",
      transportEvent: "authentication_accepted",
      authenticated: true,
      activeConnectionGeneration: 7,
      requestedConnectionGeneration: 6,
      webSocketReadyState: "open",
      publicationOutcome: "send_rejected",
      transportReason: "stale_generation",
      rawMessage: "token=private-token",
      nested: {
        cookie: "session-secret",
        candidate: "candidate:1 1 UDP 127.0.0.1",
        sdp: "v=0",
      },
      stack: "at /Users/private-user/private.js",
    });
    diagnostics.log("unexpected-secret-event", { errorMessage: "must-not-be-written" });
    await diagnostics.flush();

    const content = await readFile(path, "utf8");
    assert.match(content, /"requestId":9/);
    assert.doesNotMatch(
      content,
      /dG9rZW46c2VjcmV0|bearer-secret|unlabeled-secret-value|ice-password|private\.example|private-token|file:\/\/|id_rsa|private-user|session-secret|candidate:1|must-not-be-written/,
    );
    assert.doesNotMatch(content, /"errorMessage"|"stack"|"nested"|unexpected-secret-event/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("owner signaling diagnostics persist correlated state without unapproved fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "live-presence-capture-"));
  const path = join(directory, "screen-capture.log");
  try {
    const diagnostics = new CaptureDiagnostics(() => path);
    diagnostics.log("owner_signaling_transport", {
      transportEvent: "signaling_send_rejected",
      level: "warn",
      activeConnectionGeneration: 8,
      requestedConnectionGeneration: 7,
      webSocketReadyState: "open",
      authenticated: true,
      publicationOutcome: "send_rejected",
      transportReason: "stale_generation",
      token: "secret-token",
      rawMessage: "sdp or credentials",
      sessionId: "private-session",
    });

    test("signaling connect failure diagnostics persist safe correlation and error fields", async () => {
      const directory = await mkdtemp(join(tmpdir(), "live-presence-capture-"));
      const path = join(directory, "screen-capture.log");
      try {
        const diagnostics = new CaptureDiagnostics(() => path);
        diagnostics.log("owner_signaling_transport", {
          transportEvent: "signaling_connect_transport_rejected",
          correlationId: "123e4567-e89b-42d3-a456-426614174000",
          connectErrorName: "Error",
          connectErrorCategory: "transport_connect_rejected",
          connectErrorMessage: "Signaling transport connection rejected",
          errorMessage: "Bearer private-token",
          rawMessage: "cookie=session-secret",
        });
        await diagnostics.flush();

        const content = await readFile(path, "utf8");
        const record = JSON.parse(content) as Record<string, unknown>;
        assert.equal(record.correlationId, "123e4567-e89b-42d3-a456-426614174000");
        assert.equal(record.connectErrorName, "Error");
        assert.equal(record.connectErrorCategory, "transport_connect_rejected");
        assert.equal(record.connectErrorMessage, "Signaling transport connection rejected");
        assert.doesNotMatch(content, /private-token|session-secret/);
        assert.doesNotMatch(content, /errorMessage|rawMessage/);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
    await diagnostics.flush();

    const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    assert.equal(record.event, "owner_signaling_transport");
    assert.equal(record.transportEvent, "signaling_send_rejected");
    assert.equal(record.activeConnectionGeneration, 8);
    assert.equal(record.requestedConnectionGeneration, 7);
    assert.equal(record.webSocketReadyState, "open");
    assert.equal(record.authenticated, true);
    assert.equal(record.publicationOutcome, "send_rejected");
    assert.equal(record.transportReason, "stale_generation");
    assert.doesNotMatch(await readFile(path, "utf8"), /secret-token|sdp or credentials|private-session/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("capture attempt and picker request IDs stay associated across out-of-order events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "live-presence-capture-"));
  const path = join(directory, "screen-capture.log");
  try {
    const diagnostics = new CaptureDiagnostics(() => path);
    const attempts = [
      "123e4567-e89b-42d3-a456-426614174001",
      "123e4567-e89b-42d3-a456-426614174002",
    ];
    let activeAttemptId: string | undefined = attempts[0];
    const picker = new DisplayCapturePicker({
      getSources: async () => [{ id: "screen:1", name: "Private Display" } as DesktopCapturerSource],
      createWindow: () => new FakeWindow(),
    }, (_level, event, details) => diagnostics.log(event, details), () => activeAttemptId);
    const choose = (picker as unknown as {
      choose(id: number): Promise<DesktopCapturerSource | null>;
    }).choose.bind(picker);

    const first = choose(1);
    await Promise.resolve();
    await picker.chooseSource("screen:1");
    assert.equal((await first)?.id, "screen:1");
    diagnostics.log("screen_stream_acquisition_succeeded", { attemptId: attempts[0], trackCount: 1 });

    activeAttemptId = attempts[1];
    const second = choose(2);
    await Promise.resolve();
    await picker.chooseSource("screen:1");
    assert.equal((await second)?.id, "screen:1");
    diagnostics.log("screen_stream_acquisition_succeeded", { attemptId: attempts[1], trackCount: 1 });

    activeAttemptId = attempts[1];
    diagnostics.log("screen_stream_acquisition_failed", {
      attemptId: attempts[0],
      errorCategory: "capture_failed",
      errorCode: "Error",
    });
    await diagnostics.flush();

    const records = (await readFile(path, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const pickerRecords = records.filter((record) =>
      record.event === "display_capture_request_started" ||
      record.event === "display_capture_source_enumeration_started" ||
      record.event === "display_capture_selection_received");
    assert.ok(pickerRecords.some((record) => record.requestId === 1 && record.attemptId === attempts[0]));
    assert.ok(pickerRecords.some((record) => record.requestId === 2 && record.attemptId === attempts[1]));
    assert.ok(records.some((record) =>
      record.event === "screen_stream_acquisition_failed" && record.attemptId === attempts[0]));
    assert.doesNotMatch(await readFile(path, "utf8"), /Private Display/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("logging failures do not interrupt successful screen-track acquisition", async () => {
  const operations: CaptureDiagnosticFileOperations = {
    appendFile: async () => { throw new Error("disk unavailable"); },
    mkdir: async () => undefined,
    rename: async () => { throw new Error("rotation unavailable"); },
    stat: async () => { throw missingFileError(); },
    unlink: async () => { throw missingFileError(); },
    writeFile: async () => { throw new Error("disk unavailable"); },
  };
  const diagnostics = new CaptureDiagnostics(() => "/unavailable/screen-capture.log", 1_048_576, operations);
  diagnostics.log("screen_stream_acquisition_succeeded", { requestId: 1, trackCount: 1 });

  const track = {
    readyState: "live",
    stop() {},
    addEventListener() {},
  } as unknown as MediaStreamTrack;
  const stream = {
    getVideoTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  const acquired = await acquireLiveScreenTrack(() => Promise.resolve(stream));
  assert.equal(acquired, track);
  await diagnostics.flush();
});

test("rotation failure falls back to a bounded current log without rejecting", async () => {
  let activeContent: string | undefined;
  const operations: CaptureDiagnosticFileOperations = {
    appendFile: async (_path, content) => { activeContent = `${activeContent ?? ""}${content}`; },
    mkdir: async () => undefined,
    rename: async () => {
      const error = new Error("rotation failed");
      Object.assign(error, { code: "EACCES" });
      throw error;
    },
    stat: async () => {
      if (activeContent === undefined) throw missingFileError();
      return { size: Buffer.byteLength(activeContent) };
    },
    unlink: async () => { throw missingFileError(); },
    writeFile: async (_path, content) => { activeContent = content; },
  };
  const diagnostics = new CaptureDiagnostics(() => "/logs/screen-capture.log", 300, operations);
  const details = {
    attemptId: "123e4567-e89b-42d3-a456-426614174003",
    requestId: 7,
    trackCount: 1,
    screen: true,
    camera: false,
  };
  diagnostics.log("screen_capture_requested", details);
  diagnostics.log("screen_capture_requested", { ...details, requestId: 8 });
  await diagnostics.flush();

  assert.ok(activeContent);
  assert.match(activeContent, /"requestId":8/);
  assert.ok(Buffer.byteLength(activeContent) <= 300);
});

test("sharing-state diagnostics distinguish send results from backend acknowledgements", async () => {
  assert.equal(sharingStateSendEvent("sharing-state", "sent"), "sharing_state_update_sent");
  assert.equal(sharingStateSendEvent("sharing-state", "socket_not_open"), "sharing_state_update_not_sent");
  assert.equal(sharingStateSendEvent("sharing-state", "send_rejected"), "sharing_state_update_not_sent");
  assert.equal(sharingStateSendEvent("sharing-state", undefined), undefined);
  assert.equal(sharingStateSendEvent("signaling", "sent"), undefined);

  const directory = await mkdtemp(join(tmpdir(), "live-presence-capture-"));
  const path = join(directory, "screen-capture.log");
  try {
    const diagnostics = new CaptureDiagnostics(() => path);
    diagnostics.log("sharing_state_update_not_sent", {
      attemptId: "123e4567-e89b-42d3-a456-426614174004",
      screen: true,
      camera: false,
      sent: false,
      publicationOutcome: "socket_not_open",
      signalingState: "connecting",
      socketConnectionGeneration: 3,
      rendererConnectionGeneration: null,
    });
    diagnostics.log("sharing_state_update_sent", {
      screen: true,
      camera: false,
      sent: true,
      publicationOutcome: "sent",
      signalingState: "open",
      socketConnectionGeneration: 3,
    });
    diagnostics.log("sharing_state_update_confirmed", {
      screen: true,
      camera: false,
      sent: true,
      socketConnectionGeneration: 3,
      stage: "backend_acknowledgement",
    });
    await diagnostics.flush();
    const records = (await readFile(path, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(records.map((record) => record.event), [
      "sharing_state_update_not_sent",
      "sharing_state_update_sent",
      "sharing_state_update_confirmed",
    ]);
    assert.equal(records[0]?.publicationOutcome, "socket_not_open");
    assert.equal(records[0]?.signalingState, "connecting");
    assert.equal(records[0]?.socketConnectionGeneration, 3);
    assert.equal(records[0]?.rendererConnectionGeneration, null);
    assert.equal(records[1]?.publicationOutcome, "sent");
    assert.equal(records[2]?.stage, "backend_acknowledgement");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
