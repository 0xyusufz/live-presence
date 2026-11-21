import { appendFile, mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  CaptureDiagnosticCategory,
  CaptureDiagnosticErrorCode,
  CaptureDiagnosticDetails,
  CaptureDiagnosticEvent,
  CaptureDiagnosticReason,
  CaptureDiagnosticStage,
  OwnerSignalingTransportEvent,
  SharingPublicationOutcome,
  SignalingSocketState,
  SignalingTransportReason,
} from "../ipc-contract.js";

export type CaptureDiagnosticFileOperations = {
  appendFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
  rename(oldPath: string, newPath: string): Promise<void>;
  stat(path: string): Promise<{ size: number }>;
  unlink(path: string): Promise<void>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
};

const EVENTS = new Set<CaptureDiagnosticEvent>([
  "display_capture_request_started",
  "display_capture_source_selection_failed",
  "display_capture_callback_completed",
  "display_capture_source_selected",
  "display_capture_request_without_source",
  "display_capture_selection_ignored",
  "display_capture_selection_received",
  "display_capture_selection_unavailable",
  "display_capture_selection_cancelled_without_pending",
  "display_capture_selection_cancelled",
  "display_capture_source_enumeration_started",
  "display_capture_source_enumeration_failed",
  "display_capture_source_enumeration_completed",
  "display_capture_sources_empty",
  "display_capture_picker_opened",
  "display_capture_picker_closed",
  "display_capture_picker_load_failed_ignored",
  "display_capture_picker_load_failed",
  "display_capture_picker_creation_failed",
  "display_capture_selection_skipped",
  "display_capture_selection_resolved",
  "screen_capture_requested",
  "screen_display_media_request_started",
  "screen_display_media_request_failed",
  "screen_stream_acquisition_failed",
  "screen_stream_acquisition_succeeded",
  "screen_live_track_validation_succeeded",
  "screen_live_track_validation_failed",
  "screen_track_unavailable",
  "screen_track_ended",
  "screen_track_became_unavailable",
  "sharing_state_activation_requested",
  "screen_sharing_activation_failed",
  "screen_capture_activation_confirmed_by_main",
  "sharing_state_update_sent",
  "sharing_state_update_not_sent",
  "sharing_state_update_confirmed",
  "owner_signaling_transport",
]);

const REASONS = new Set([
  "request_already_pending",
  "source_selection_or_picker_failed",
  "cancelled_or_unavailable",
  "source_selected",
  "no_pending_request",
  "source_id_in_snapshot",
  "source_id_not_in_snapshot",
  "user_cancelled",
  "enumeration_failed",
  "request_no_longer_active",
  "request_active",
  "sources_empty",
  "window_closed",
  "picker_closed",
  "stale_request",
  "picker_load_failed",
  "picker_creation_failed",
  "source_enumeration_failed",
  "selection_accepted",
  "selection_rejected",
  "local_user_action",
  "capture_generation_changed",
  "ended_event",
  "track_muted",
  "track_not_live",
  "superseded_attempt",
]);

const STAGES = new Set([
  "local_user_action",
  "display_media_request",
  "get_display_media",
  "live_track_validation",
  "post_acquisition",
  "track_lifecycle",
  "before_main_capture_confirmation",
  "post_main_confirmation",
  "before_signaling_update",
  "sharing_state_activation",
  "signaling_send",
  "backend_acknowledgement",
  "capture_operation",
]);

const ERROR_CATEGORIES = new Set([
  "source_enumeration_failed",
  "picker_creation_failed",
  "picker_load_failed",
  "source_selection_failed",
  "request_already_pending",
  "display_media_failed",
  "live_track_validation_failed",
  "sharing_activation_failed",
  "capture_unexpected_failure",
  "video_stream_not_provided",
  "permission_or_consent_denied",
  "no_capture_source",
  "capture_cancelled",
  "capture_failed",
  "unknown",
]);

const ERROR_CODES = new Set([
  "AbortError",
  "NotAllowedError",
  "NotFoundError",
  "TypeError",
  "SecurityError",
  "InvalidStateError",
  "Error",
  "DOMException",
  "unknown",
]);

const READY_STATES = new Set(["live", "ended", "unavailable"]);
const PUBLICATION_OUTCOMES = new Set<SharingPublicationOutcome>([
  "socket_not_open",
  "send_rejected",
  "sent",
]);
const SOCKET_STATES = new Set<SignalingSocketState>([
  "not-connected",
  "connecting",
  "open",
  "closing",
  "closed",
  "unknown",
]);
const TRANSPORT_EVENTS = new Set<OwnerSignalingTransportEvent>([
  "signaling_connect_sender_rejected",
  "signaling_connect_transport_initialization_failed",
  "signaling_connect_transport_rejected",
  "signaling_connect_authenticated_reuse_succeeded",
  "connection_attempt_started",
  "connection_attempt_ended",
  "connection_setup_timeout",
  "websocket_open",
  "authentication_message_sent",
  "authentication_message_send_failed",
  "authentication_accepted",
  "authentication_rejected",
  "owner_authentication_started",
  "owner_authentication_completed",
  "reconnect_attempt_started",
  "reconnect_attempt_failed",
  "reconnect_attempt_succeeded",
  "heartbeat_sent",
  "heartbeat_ack_received",
  "heartbeat_timeout",
  "heartbeat_send_failed",
  "websocket_error",
  "websocket_unexpected_response",
  "websocket_close",
  "websocket_closed",
  "socket_retirement",
  "stale_socket_retired",
  "explicit_signaling_close",
  "signaling_send_rejected",
  "sharing_state_transport_sent",
]);
const TRANSPORT_REASONS = new Set<SignalingTransportReason>([
  "stale_generation",
  "socket_not_open",
  "invalid_message",
  "message_not_allowed",
  "socket_send_failed",
]);
const CLOSE_REASON_CATEGORIES = new Set([
  "policy_or_authentication",
  "retryable_service_unavailable",
  "normal",
  "server_shutdown",
  "abnormal_transport_loss",
  "other",
  "connection_setup_timeout",
  "stale_socket_replaced",
  "explicit_close",
  "connection_attempt_failed",
  "device_revoked",
  "invalid_server_message",
  "wrong_account_role",
  "unclassified",
]);
const FILE_OPERATIONS: CaptureDiagnosticFileOperations = { appendFile, mkdir, rename, stat, unlink, writeFile };

export function isCaptureAttemptId(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function safeCaptureErrorCode(error: unknown): CaptureDiagnosticErrorCode {
  if (!(error instanceof Error)) return "unknown";
  return ERROR_CODES.has(error.name) ? error.name as CaptureDiagnosticErrorCode : "unknown";
}

export class CaptureDiagnostics {
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(
    private readonly logPath: () => string,
    private readonly maxBytes = 1_048_576,
    private readonly fileOperations: CaptureDiagnosticFileOperations = FILE_OPERATIONS,
  ) {}

  log(event: unknown, details: unknown = {}): void {
    try {
      if (typeof event !== "string" || !EVENTS.has(event as CaptureDiagnosticEvent)) return;
      const record = {
        timestamp: new Date().toISOString(),
        event,
        ...this.sanitizeDetails(details),
      };
      const line = `${JSON.stringify(record)}\n`;
      this.pendingWrite = this.pendingWrite
        .then(() => this.append(line))
        .catch(() => undefined);
    } catch {
      // Diagnostics must never interrupt capture or startup.
    }
  }

  flush(): Promise<void> {
    return this.pendingWrite;
  }

  private async append(line: string): Promise<void> {
    const path = this.logPath();
    await this.fileOperations.mkdir(dirname(path), { recursive: true });
    try {
      const current = await this.fileOperations.stat(path);
      if (current.size + Buffer.byteLength(line, "utf8") > this.maxBytes) {
        try {
          await this.fileOperations.unlink(`${path}.1`);
        } catch (error) {
          if (!isMissingFile(error)) throw error;
        }
        await this.fileOperations.rename(path, `${path}.1`);
      }
    } catch (error) {
      if (!isMissingFile(error)) {
        await this.fileOperations.writeFile(path, line, "utf8");
        return;
      }
    }
    await this.fileOperations.appendFile(path, line, "utf8");
  }

  private sanitizeDetails(input: unknown): CaptureDiagnosticDetails {
    if (!isPlainRecord(input)) return {};
    const safe: CaptureDiagnosticDetails = {};
    for (const [key, value] of Object.entries(input)) {
      switch (key) {
        case "cycleId":
          if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) safe.cycleId = value;
          break;
        case "recoveryAttemptId":
        case "sessionId":
          if (isCaptureAttemptId(value)) safe[key] = value;
          break;
        case "recoveryPhase":
          if (typeof value === "string" && value.length <= 100) safe.recoveryPhase = value;
          break;
        case "attemptId":
          if (isCaptureAttemptId(value)) safe.attemptId = value;
          break;
        case "correlationId":
          if (isCaptureAttemptId(value)) safe.correlationId = value;
          break;
        case "requestId":
          if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) safe.requestId = value;
          break;
        case "sourceCount":
        case "trackCount":
          if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 100) {
            safe[key] = value;
          }
          break;
        case "matchedSource":
        case "sourceSelected":
        case "enabled":
        case "muted":
        case "screen":
        case "camera":
        case "sent":
        case "authenticated":
          if (typeof value === "boolean") safe[key] = value;
          break;
        case "level":
          if (value === "debug" || value === "info" || value === "warn" || value === "error") {
            safe.level = value;
          }
          break;
        case "publicationOutcome":
          if (typeof value === "string" && PUBLICATION_OUTCOMES.has(value as SharingPublicationOutcome)) {
            safe.publicationOutcome = value as SharingPublicationOutcome;
          }
          break;
        case "signalingState":
          if (value === "connecting" || value === "open" || value === "closed" || value === "not-connected") {
            safe.signalingState = value;
          }
          break;
        case "socketConnectionGeneration":
        case "activeConnectionGeneration":
        case "requestedConnectionGeneration":
          if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
            safe[key] = value;
          }
          break;
        case "rendererConnectionGeneration":
          if (value === null) safe.rendererConnectionGeneration = null;
          else if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
            safe.rendererConnectionGeneration = value;
          }
          break;
        case "webSocketReadyState":
          if (typeof value === "string" && SOCKET_STATES.has(value as SignalingSocketState)) {
            safe.webSocketReadyState = value as SignalingSocketState;
          }
          break;
        case "transportEvent":
          if (typeof value === "string" && TRANSPORT_EVENTS.has(value as OwnerSignalingTransportEvent)) {
            safe.transportEvent = value as OwnerSignalingTransportEvent;
          }
          break;
        case "transportReason":
          if (typeof value === "string" && TRANSPORT_REASONS.has(value as SignalingTransportReason)) {
            safe.transportReason = value as SignalingTransportReason;
          }
          break;
        case "connectErrorName":
          if (value === "Error" || value === "TypeError" || value === "RangeError" ||
            value === "SyntaxError" || value === "AbortError" || value === "UnknownError") {
            safe.connectErrorName = value;
          }
          break;
        case "connectErrorCategory":
          if (value === "sender_validation_rejected" || value === "transport_initialization_failed" ||
            value === "transport_connect_rejected" || value === "authenticated_reuse_failed" ||
            value === "connection_setup_timeout" || value === "device_credential_unavailable" ||
            value === "invalid_configuration" || value === "socket_hang_up" ||
            value === "websocket_closed_before_connection" || value === "connection_refused" ||
            value === "connection_reset" || value === "connection_timed_out" ||
            value === "host_resolution_failed" || value === "host_unreachable" ||
            value === "network_unreachable" || value === "connection_write_failed") {
            safe.connectErrorCategory = value;
          }
          break;
        case "connectErrorMessage":
          if (value === "Signaling IPC sender validation rejected" ||
            value === "Signaling transport initialization failed" ||
            value === "Authenticated transport reuse failed" ||
            value === "Signaling transport connection rejected" ||
            value === "Signaling connection setup timed out" ||
            value === "Device credential is unavailable" ||
            value === "Signaling URL configuration is invalid" ||
            value === "WebSocket connection closed unexpectedly" ||
            value === "WebSocket closed before connection" ||
            value === "Connection was refused" || value === "Connection was reset" ||
            value === "Connection timed out" || value === "Host resolution failed" ||
            value === "Host is unreachable" || value === "Network is unreachable" ||
            value === "Connection write failed") {
            safe.connectErrorMessage = value;
          }
          break;
        case "closeCode":
          if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 4999) {
            safe.closeCode = value;
          }
          break;
        case "closeReasonCategory":
          if (typeof value === "string" && CLOSE_REASON_CATEGORIES.has(value)) {
            safe.closeReasonCategory = value;
          }
          break;
        case "heartbeatSentCount":
        case "heartbeatAckCount":
        case "lastHeartbeatAckAgeMs":
        case "attemptNumber":
        case "reconnectAttempt":
          if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
            safe[key] = value;
          }
          break;
        case "reason":
          if (typeof value === "string" && REASONS.has(value)) safe.reason = value as CaptureDiagnosticReason;
          break;
        case "stage":
          if (typeof value === "string" && STAGES.has(value)) safe.stage = value as CaptureDiagnosticStage;
          break;
        case "errorCategory":
          if (typeof value === "string" && ERROR_CATEGORIES.has(value)) safe.errorCategory = value as CaptureDiagnosticCategory;
          break;
        case "errorCode":
          if (typeof value === "string" && ERROR_CODES.has(value)) safe.errorCode = value as CaptureDiagnosticErrorCode;
          break;
        case "readyState":
          if (typeof value === "string" && READY_STATES.has(value)) {
            safe.readyState = value as NonNullable<CaptureDiagnosticDetails["readyState"]>;
          }
          break;
        default:
          break;
      }
    }
    return safe;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
