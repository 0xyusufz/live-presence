import type { ClientLifecycleState } from "../../../../shared/src/client.js";
import type { WebRtcPeer, WebRtcTrack } from "../../../../shared/src/webrtc.js";

type CaptureTrackState<T extends WebRtcTrack = WebRtcTrack> = {
  generation: number;
  screen?: T;
  camera?: T;
  cameraRevision?: number;
  cameraMutation?: Promise<void>;
};

export function handleTerminalCaptureFailure(
  current: {
    failureHandled?: boolean;
    failed?: boolean;
    screen?: unknown;
    preparingScreen?: boolean;
  },
  error: Error,
  stop: (reason: string) => void,
  setMessage: (message: string) => void,
): boolean {
  if (current.failureHandled) return false;
  current.failureHandled = true;
  current.failed = true;
  const reason = `${error.message} Sharing was stopped.`;
  if (current.screen || current.preparingScreen) stop(reason);
  else setMessage(reason);
  return true;
}

export function invalidateCapture<T extends WebRtcTrack>(
  current: CaptureTrackState<T>,
): { screen: T | undefined; camera: T | undefined } {
  const tracks = { screen: current.screen, camera: current.camera };
  current.generation += 1;
  current.screen = undefined;
  current.camera = undefined;
  return tracks;
}

export async function attachApprovedTracks(
  peer: Pick<WebRtcPeer, "replaceTrack">,
  current: CaptureTrackState,
  generation: number,
): Promise<void> {
  if (current.generation !== generation || !current.screen || current.screen.readyState !== "live") {
    throw new Error("screen track is unavailable");
  }
  await peer.replaceTrack("screen", current.screen);
  if (current.generation !== generation || current.screen?.readyState !== "live") {
    throw new Error("screen sharing ended during peer preparation");
  }
  await replaceApprovedCameraTrack(
    current,
    generation,
    (camera) => peer.replaceTrack("camera", camera),
  );
  if (current.generation !== generation) throw new Error("sharing session stopped during peer preparation");
}

export function setApprovedCameraTrack<T extends WebRtcTrack>(
  current: CaptureTrackState<T>,
  camera: T | undefined,
): void {
  if (current.camera === camera) return;
  current.camera = camera;
  current.cameraRevision = (current.cameraRevision ?? 0) + 1;
}

export function isCurrentCameraTrack<T extends WebRtcTrack>(
  current: CaptureTrackState<T>,
  camera: T,
): boolean {
  return current.camera === camera;
}

export function isLiveCameraTrack<T extends WebRtcTrack>(
  current: CaptureTrackState<T>,
  camera: T,
): boolean {
  return current.camera === camera && camera.readyState === "live";
}

export async function removeApprovedCameraTrack<T extends WebRtcTrack>(
  current: CaptureTrackState<T>,
  generation: number,
  camera: T & { stop(): void },
  replaceTrack: (camera: T | null) => Promise<void>,
  setCameraIntent: (enabled: boolean) => Promise<void>,
  setSharingState: (screen: boolean, camera: boolean) => Promise<void>,
  onRemoved: () => void,
  onReplacementFailure?: () => void,
): Promise<void> {
  let replacementFailed = false;
  try {
    await replaceApprovedCameraTrack(current, generation, replaceTrack);
  } catch {
    replacementFailed = true;
  } finally {
    camera.stop();
  }

  if (replacementFailed && onReplacementFailure &&
    current.generation === generation &&
    current.screen?.readyState === "live") {
    onReplacementFailure();
  }
  if (
    current.generation !== generation ||
    current.screen?.readyState !== "live" ||
    current.camera !== undefined
  ) return;

  await setCameraIntent(false).catch(() => undefined);
  if (
    current.generation !== generation ||
    current.screen?.readyState !== "live" ||
    current.camera !== undefined
  ) return;

  await setSharingState(true, false).catch(() => undefined);
  if (
    current.generation === generation &&
    current.screen?.readyState === "live" &&
    current.camera === undefined
  ) {
    onRemoved();
  }
}

export async function replaceApprovedCameraTrack<T extends WebRtcTrack>(
  current: CaptureTrackState<T>,
  generation: number,
  replaceTrack: (camera: T | null) => Promise<void>,
): Promise<void> {
  const previous = current.cameraMutation ?? Promise.resolve();
  const mutation = previous.catch(() => undefined).then(async () => {
    if (current.generation !== generation) return;
    let appliedRevision = -1;
    do {
      const revision = current.cameraRevision ?? 0;
      const camera = current.camera?.readyState === "live" ? current.camera : undefined;
      await replaceTrack(camera ?? null);
      if (current.generation !== generation) return;
      if (camera && camera.readyState !== "live" && current.camera === camera) {
        setApprovedCameraTrack(current, undefined);
      }
      appliedRevision = revision;
    } while ((current.cameraRevision ?? 0) !== appliedRevision);
  });
  current.cameraMutation = mutation;
  try {
    await mutation;
  } finally {
    if (current.cameraMutation === mutation) current.cameraMutation = undefined;
  }
}

export function sharingStatus(
  capture: "idle" | "preparing" | "live",
  lifecycle: ClientLifecycleState,
  failed: boolean,
): string {
  if (failed) return "Failed";
  if (capture === "preparing") return "Preparing";
  if (capture === "idle") return "Not sharing";
  if (lifecycle === "CONNECTED") return "Sharing — Connected";
  if (lifecycle === "CONNECTING") return "Sharing locally — Connecting";
  if (lifecycle === "NEGOTIATING") return "Sharing locally — Negotiating";
  if (lifecycle === "RECONNECTING") return "Sharing locally — Reconnecting";
  return "Sharing locally — Viewer disconnected";
}

export function stopCapturedTracks(
  screen?: Pick<MediaStreamTrack, "stop">,
  camera?: Pick<MediaStreamTrack, "stop">,
): void {
  screen?.stop();
  camera?.stop();
}

export async function stopOwnerCapture(
  screen: Pick<MediaStreamTrack, "stop"> | undefined,
  camera: Pick<MediaStreamTrack, "stop"> | undefined,
  clearCameraIntent: () => Promise<void>,
  clearScreenIntent: () => Promise<void>,
  acknowledgeCleanup: () => void,
): Promise<boolean> {
  stopCapturedTracks(screen, camera);
  const results = await Promise.allSettled([
    clearCameraIntent(),
    clearScreenIntent(),
  ]);
  acknowledgeCleanup();
  return results.some((result) => result.status === "rejected");
}

export async function acquireLiveScreenTrack(
  request: () => Promise<MediaStream>,
): Promise<MediaStreamTrack> {
  const stream = await request();
  const screen = stream.getVideoTracks()[0];
  if (!screen || screen.readyState !== "live") {
    for (const track of stream.getTracks()) track.stop();
    throw new Error("No live screen track was selected");
  }
  for (const track of stream.getTracks()) {
    if (track !== screen) track.stop();
  }
  return screen;
}

export function inspectScreenVideoTracks(stream: MediaStream): {
  videoTracks: MediaStreamTrack[];
  firstTrack: MediaStreamTrack | undefined;
  readyState: MediaStreamTrack["readyState"] | "unavailable";
  enabled: boolean;
  muted: boolean;
} {
  const videoTracks = stream.getVideoTracks();
  const firstTrack = videoTracks[0];
  return {
    videoTracks,
    firstTrack,
    readyState: firstTrack?.readyState ?? "unavailable",
    enabled: firstTrack?.enabled ?? false,
    muted: firstTrack?.muted ?? false,
  };
}

export async function confirmLiveScreenCapture(
  screen: Pick<MediaStreamTrack, "readyState">,
  confirm: () => Promise<void>,
): Promise<void> {
  if (screen.readyState !== "live") throw new Error("Screen track ended before capture confirmation");
  await confirm();
}
