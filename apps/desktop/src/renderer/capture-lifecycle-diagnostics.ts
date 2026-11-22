import type {
  CaptureCleanupReason,
  CaptureDiagnosticDetails,
  CaptureDiagnosticEvent,
} from "../ipc-contract.js";

type TrackEvent = "ended" | "mute" | "unmute";
type TrackKind = "screen" | "camera";
type RecoveryState = NonNullable<CaptureDiagnosticDetails["sleepRecoveryState"]>;

export function trackLifecycleDiagnostic(
  track: MediaStreamTrack,
  trackKind: TrackKind,
  trackEvent: TrackEvent,
  captureGeneration: number,
  cycleId: number | undefined,
  sleepRecoveryState: RecoveryState,
): { event: CaptureDiagnosticEvent; details: CaptureDiagnosticDetails } {
  const event: CaptureDiagnosticEvent = trackKind === "screen"
    ? trackEvent === "ended" ? "screen_track_ended"
      : trackEvent === "mute" ? "screen_track_muted" : "screen_track_unmuted"
    : trackEvent === "ended" ? "camera_track_ended"
      : trackEvent === "mute" ? "camera_track_muted" : "camera_track_unmuted";

  return {
    event,
    details: {
      stage: "track_lifecycle",
      trackId: track.id,
      trackKind,
      trackEvent,
      readyState: track.readyState,
      enabled: track.enabled,
      muted: track.muted,
      captureGeneration,
      cycleId,
      sleepRecoveryState,
      ...(trackEvent === "ended"
        ? { reason: "ended_event" as const }
        : trackEvent === "mute" ? { reason: "track_muted" as const } : {}),
    },
  };
}

export function captureCleanupDiagnostic(
  screen: MediaStreamTrack | undefined,
  camera: MediaStreamTrack | undefined,
  captureGeneration: number,
  cycleId: number | undefined,
  sleepRecoveryState: RecoveryState,
  cleanupReason: CaptureCleanupReason,
): CaptureDiagnosticDetails {
  return {
    cleanupReason,
    captureGeneration,
    cycleId,
    sleepRecoveryState,
    screenTrackId: screen?.id,
    cameraTrackId: camera?.id,
    screenReadyState: screen?.readyState ?? "unavailable",
    cameraReadyState: camera?.readyState ?? "unavailable",
    screenEnabled: screen?.enabled,
    cameraEnabled: camera?.enabled,
    screenMuted: screen?.muted,
    cameraMuted: camera?.muted,
  };
}
