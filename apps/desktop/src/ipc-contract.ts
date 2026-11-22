import type { WebRtcConfiguration } from "../../../shared/src/webrtc.js";

export type CaptureDiagnosticEvent =
  | "display_capture_request_started"
  | "display_capture_source_selection_failed"
  | "display_capture_callback_completed"
  | "display_capture_source_selected"
  | "display_capture_request_without_source"
  | "display_capture_selection_ignored"
  | "display_capture_selection_received"
  | "display_capture_selection_unavailable"
  | "display_capture_selection_cancelled_without_pending"
  | "display_capture_selection_cancelled"
  | "display_capture_source_enumeration_started"
  | "display_capture_source_enumeration_failed"
  | "display_capture_source_enumeration_completed"
  | "display_capture_sources_empty"
  | "display_capture_picker_opened"
  | "display_capture_picker_closed"
  | "display_capture_picker_load_failed_ignored"
  | "display_capture_picker_load_failed"
  | "display_capture_picker_creation_failed"
  | "display_capture_selection_skipped"
  | "display_capture_selection_resolved"
  | "screen_capture_requested"
  | "screen_display_media_request_started"
  | "screen_display_media_request_failed"
  | "screen_stream_acquisition_failed"
  | "screen_stream_acquisition_succeeded"
  | "screen_live_track_validation_succeeded"
  | "screen_live_track_validation_failed"
  | "screen_track_unavailable"
  | "screen_track_ended"
  | "screen_track_became_unavailable"
  | "screen_track_muted"
  | "screen_track_unmuted"
  | "camera_track_ended"
  | "camera_track_muted"
  | "camera_track_unmuted"
  | "sharing_state_activation_requested"
  | "screen_sharing_activation_failed"
  | "screen_capture_activation_confirmed_by_main"
  | "sharing_state_update_sent"
  | "sharing_state_update_not_sent"
  | "sharing_state_update_confirmed"
  | "sleep_marker_prepare_started"
  | "sleep_marker_prepare_acknowledged"
  | "sleep_marker_prepare_failed"
  | "sleep_marker_sent"
  | "sleep_marker_timed_out"
  | "sleep_marker_error_received"
  | "sleep_recovery_eligibility"
  | "capture_cleanup"
  | "system_suspend"
  | "system_resume"
  | "lock_screen"
  | "unlock_screen"
  | "display_removed"
  | "display_metrics_changed"
  | "screen_track_state_before_false_publish"
  | "peer_closed"
  | "sleep_recovery_started"
  | "sleep_recovery_track_unavailable"
  | "sleep_recovery_result"
  | "owner_signaling_transport";

export type SharingPublicationOutcome = "socket_not_open" | "send_rejected" | "sent";

export type SignalingSocketState =
  | "not-connected"
  | "connecting"
  | "open"
  | "closing"
  | "closed"
  | "unknown";

export type OwnerSignalingTransportEvent =
  | "signaling_connect_sender_rejected"
  | "signaling_connect_transport_initialization_failed"
  | "signaling_connect_transport_rejected"
  | "signaling_connect_authenticated_reuse_succeeded"
  | "connection_attempt_started"
  | "connection_attempt_ended"
  | "connection_setup_timeout"
  | "websocket_open"
  | "authentication_message_sent"
  | "authentication_message_send_failed"
  | "authentication_accepted"
  | "authentication_rejected"
  | "owner_authentication_started"
  | "owner_authentication_completed"
  | "reconnect_attempt_started"
  | "reconnect_attempt_failed"
  | "reconnect_attempt_succeeded"
  | "heartbeat_sent"
  | "heartbeat_ack_received"
  | "heartbeat_timeout"
  | "heartbeat_send_failed"
  | "websocket_error"
  | "websocket_unexpected_response"
  | "websocket_close"
  | "websocket_closed"
  | "socket_retirement"
  | "stale_socket_retired"
  | "explicit_signaling_close"
  | "signaling_send_rejected"
  | "sharing_state_transport_sent";

export type SignalingTransportReason =
  | "stale_generation"
  | "socket_not_open"
  | "invalid_message"
  | "message_not_allowed"
  | "socket_send_failed";

export type CaptureDiagnosticCategory =
  | "source_enumeration_failed"
  | "picker_creation_failed"
  | "picker_load_failed"
  | "source_selection_failed"
  | "request_already_pending"
  | "display_media_failed"
  | "live_track_validation_failed"
  | "sharing_activation_failed"
  | "capture_unexpected_failure"
  | "video_stream_not_provided"
  | "permission_or_consent_denied"
  | "no_capture_source"
  | "capture_cancelled"
  | "capture_failed"
  | "unknown";

export type CaptureDiagnosticErrorCode =
  | "AbortError"
  | "NotAllowedError"
  | "NotFoundError"
  | "TypeError"
  | "SecurityError"
  | "InvalidStateError"
  | "Error"
  | "DOMException"
  | "unknown";

export type CaptureCleanupReason =
  | "explicit_user_stop"
  | "track_ended"
  | "resume_ineligible"
  | "safety_stop"
  | "terminal_failure"
  | "setup_failure";

export type CaptureDiagnosticStage =
  | "local_user_action"
  | "display_media_request"
  | "get_display_media"
  | "live_track_validation"
  | "post_acquisition"
  | "track_lifecycle"
  | "before_main_capture_confirmation"
  | "post_main_confirmation"
  | "before_signaling_update"
  | "sharing_state_activation"
  | "signaling_send"
  | "backend_acknowledgement"
  | "capture_operation";

export type CaptureDiagnosticReason =
  | "request_already_pending"
  | "source_selection_or_picker_failed"
  | "cancelled_or_unavailable"
  | "source_selected"
  | "no_pending_request"
  | "source_id_in_snapshot"
  | "source_id_not_in_snapshot"
  | "user_cancelled"
  | "enumeration_failed"
  | "request_no_longer_active"
  | "request_active"
  | "sources_empty"
  | "window_closed"
  | "stale_request"
  | "picker_load_failed"
  | "picker_creation_failed"
  | "picker_closed"
  | "source_enumeration_failed"
  | "selection_accepted"
  | "selection_rejected"
  | "local_user_action"
  | "capture_generation_changed"
  | "ended_event"
  | "track_muted"
  | "track_not_live"
  | "explicit_stop"
  | "capture_stop"
  | "superseded_attempt";

export type CaptureDiagnosticDetails = {
  cycleId?: number;
  timestampWallMs?: number;
  timestampMonotonicMs?: number;
  elapsedSinceSuspendMs?: number;
  captureGeneration?: number;
  trackId?: string;
  trackKind?: "screen" | "camera";
  trackEvent?: "ended" | "mute" | "unmute";
  sleepRecoveryState?: "idle" | "eligible" | "started" | "completed" | "failed" | "timed_out";
  cleanupReason?: CaptureCleanupReason;
  screenTrackId?: string;
  cameraTrackId?: string;
  screenReadyState?: "live" | "ended" | "unavailable";
  cameraReadyState?: "live" | "ended" | "unavailable";
  screenEnabled?: boolean;
  cameraEnabled?: boolean;
  screenMuted?: boolean;
  cameraMuted?: boolean;
  displayId?: number;
  screenPermissionStatus?: "not-determined" | "granted" | "denied" | "restricted" | "unknown";
  recoveryAttemptId?: string;
  sessionId?: string;
  recoveryPhase?: string;
  attemptId?: string;
  correlationId?: string;
  requestId?: number;
  sourceCount?: number;
  trackCount?: number;
  matchedSource?: boolean;
  sourceSelected?: boolean;
  enabled?: boolean;
  muted?: boolean;
  screen?: boolean;
  camera?: boolean;
  sent?: boolean;
  authenticated?: boolean;
  publicationOutcome?: SharingPublicationOutcome;
  signalingState?: "connecting" | "open" | "closed" | "not-connected";
  socketConnectionGeneration?: number;
  rendererConnectionGeneration?: number | null;
  activeConnectionGeneration?: number;
  requestedConnectionGeneration?: number;
  webSocketReadyState?: SignalingSocketState;
  transportEvent?: OwnerSignalingTransportEvent;
  transportReason?: SignalingTransportReason;
  connectErrorName?: "Error" | "TypeError" | "RangeError" | "SyntaxError" | "AbortError" | "UnknownError";
  connectErrorCategory?:
    | "sender_validation_rejected"
    | "transport_initialization_failed"
    | "transport_connect_rejected"
    | "authenticated_reuse_failed"
    | "connection_setup_timeout"
    | "device_credential_unavailable"
    | "invalid_configuration"
    | "socket_hang_up"
    | "websocket_closed_before_connection"
    | "connection_refused"
    | "connection_reset"
    | "connection_timed_out"
    | "host_resolution_failed"
    | "host_unreachable"
    | "network_unreachable"
    | "connection_write_failed";
  connectErrorMessage?: string;
  closeCode?: number;
  closeReasonCategory?: string;
  heartbeatSentCount?: number;
  heartbeatAckCount?: number;
  lastHeartbeatAckAgeMs?: number;
  attemptNumber?: number;
  reconnectAttempt?: number;
  readyState?: "live" | "ended" | "unavailable";
  level?: "debug" | "info" | "warn" | "error";
  reason?: CaptureDiagnosticReason;
  stage?: CaptureDiagnosticStage;
  errorCategory?: CaptureDiagnosticCategory;
  errorCode?: CaptureDiagnosticErrorCode;
};

export type SocketEvent =
  | { type: "authentication-started"; connectionGeneration: number }
  | {
      type: "open";
      connectionGeneration?: number;
      authenticatedTransportReuse?: boolean;
      deviceId?: string;
    }
  | { type: "message"; data: string; connectionGeneration: number }
  | { type: "close"; code?: number; connectionGeneration?: number }
  | { type: "error"; message: string; connectionGeneration: number };

export type AppEvent =
  | { type: "stop-sharing"; reason: string; wakeChoiceCycleId?: number }
  | { type: "suspend"; cycleId: number; sharingActive: boolean }
  | { type: "resume"; cycleId: number }
  | { type: "wake-sharing-choice"; cycleId: number }
  | { type: "wake-sharing-choice-dismissed"; cycleId: number }
  | { type: "sleep-recovery-timeout"; cycleId: number }
  | { type: "sleep-recovery-attempt-accepted"; cycleId: number; recoveryAttemptId: string }
  | {
      type: "sleep-recovery-result";
      cycleId: number;
      recoveryAttemptId: string;
      phase: "completed" | "failed" | "timed_out";
      accepted: boolean;
    }
  | { type: "indicator-ready"; ready: boolean }
  | { type: "indicator-state"; screen: boolean; camera: boolean };

export type WakeSharingChoiceOption = "screen" | "screen-camera";

export type WakeSharingOverlayChoice = {
  cycleId: number;
  canChoose: boolean;
};

export type WakeSharingChoiceHandler = (
  cycleId: number,
  option: WakeSharingChoiceOption,
) => boolean;

export type LivePresenceBridge = {
  platform: NodeJS.Platform;
  hasCredential(): Promise<boolean>;
  indicatorReady(): Promise<boolean>;
  saveCredential(value: string): Promise<void>;
  getServerUrl(): Promise<string>;
  connectSignaling(correlationId?: string): Promise<number>;
  sendSignaling(value: string, connectionGeneration: number, peerRegistrationId?: string): Promise<void>;
  registerSignalingPeerGeneration(sessionId: string, connectionGeneration: number): Promise<string>;
  clearSignalingPeerGeneration(peerRegistrationId: string): Promise<void>;
  closeSignaling(connectionGeneration: number): void;
  onSocketEvent(callback: (event: SocketEvent) => void): () => void;
  loadIceServers(): Promise<WebRtcConfiguration>;
  beginScreenCapture(attemptId: string): void;
  getPickerSources(): Promise<Array<{ id: string; name: string }>>;
  selectPickerSource(id: string): void;
  cancelPicker(): void;
  setScreenActive(active: boolean): Promise<void>;
  setCameraIntent(active: boolean): Promise<void>;
  reportHeartbeat(): void;
  acknowledgeCleanup(): void;
  reportSleepMarker(cycleId: number, accepted: boolean): void;
  reportSleepRecovery(
    cycleId: number,
    recoveryAttemptId: string,
    phase: "eligible" | "started" | "completed" | "failed" | "timed_out",
  ): void;
  restoreApplicationWindow(): void;
  registerDisplayedWakeSharingChoice(cycleId: number): void;
  completeWakeSharingChoice(cycleId: number): void;
  reportWakeSharingChoiceHandlerReady(): void;
  reportAppEventsReady(): void;
  notifySharingResumed(): void;
  reportCaptureDiagnostic(event: CaptureDiagnosticEvent, details?: CaptureDiagnosticDetails): void;
  stopFromIndicator(): void;
  onAppEvent(callback: (event: AppEvent) => void): () => void;
};

export type WakeSharingOverlayBridge = {
  reportReady(): void;
  select(cycleId: number, option: WakeSharingChoiceOption): void;
  dismiss(cycleId: number): void;
  onChoice(callback: (choice: WakeSharingOverlayChoice) => void): () => void;
};

declare global {
  interface Window {
    livePresence: LivePresenceBridge;
    wakeSharingOverlay: WakeSharingOverlayBridge;
    __livePresenceWakeSharingChoice?: WakeSharingChoiceHandler;
  }
}
