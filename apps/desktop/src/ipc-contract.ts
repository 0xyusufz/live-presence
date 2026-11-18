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
  | "sharing_state_activation_requested"
  | "screen_sharing_activation_failed"
  | "screen_capture_activation_confirmed_by_main"
  | "sharing_state_update_sent"
  | "sharing_state_update_not_sent"
  | "sharing_state_update_confirmed"
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
  | "superseded_attempt";

export type CaptureDiagnosticDetails = {
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
  | { type: "stop-sharing"; reason: string }
  | { type: "suspend" }
  | { type: "resume" }
  | { type: "indicator-ready"; ready: boolean }
  | { type: "indicator-state"; screen: boolean; camera: boolean };

export type LivePresenceBridge = {
  hasCredential(): Promise<boolean>;
  indicatorReady(): Promise<boolean>;
  saveCredential(value: string): Promise<void>;
  getServerUrl(): Promise<string>;
  connectSignaling(correlationId?: string): Promise<number>;
  sendSignaling(value: string, connectionGeneration: number): Promise<void>;
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
  reportSleepMarker(accepted: boolean): void;
  notifySharingResumed(): void;
  reportCaptureDiagnostic(event: CaptureDiagnosticEvent, details?: CaptureDiagnosticDetails): void;
  stopFromIndicator(): void;
  onAppEvent(callback: (event: AppEvent) => void): () => void;
};
