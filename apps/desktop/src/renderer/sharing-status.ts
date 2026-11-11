import type { ClientLifecycleState } from "../../../../shared/src/client.js";

export function sharingStatus(
  capture: "idle" | "preparing" | "live",
  lifecycle: ClientLifecycleState,
  failed: boolean,
): string {
  if (failed) return "Failed";
  if (capture === "preparing") return "Preparing";
  if (capture === "idle") return "Not sharing";
  if (lifecycle === "CONNECTED") return "Connected";
  if (lifecycle === "RECONNECTING") return "Reconnecting";
  return "Sharing / connecting";
}

export function stopCapturedTracks(
  screen?: Pick<MediaStreamTrack, "stop">,
  camera?: Pick<MediaStreamTrack, "stop">,
): void {
  screen?.stop();
  camera?.stop();
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

export async function confirmLiveScreenCapture(
  screen: Pick<MediaStreamTrack, "readyState">,
  confirm: () => Promise<void>,
): Promise<void> {
  if (screen.readyState !== "live") throw new Error("Screen track ended before capture confirmation");
  await confirm();
}
