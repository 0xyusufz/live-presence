import { WebSocket } from "ws";
import { parseClientMessage, parseServerMessage, type ClientMessage } from "../../../../shared/src/protocol.js";
import type { WebRtcConfiguration } from "../../../../shared/src/webrtc.js";
import type { SocketEvent } from "../ipc-contract.js";

type EventSink = (event: SocketEvent) => void;
type HeartbeatScheduler = (callback: () => void, delayMs: number) => () => void;
type WebSocketOptions = {
  origin: string;
  handshakeTimeout: number;
  maxPayload: number;
};
type WebSocketFactory = (url: URL, options: WebSocketOptions) => WebSocket;
export type DiagnosticLogger = (
  level: "debug" | "info" | "warn" | "error",
  entry: Record<string, unknown>,
) => void;

interface ConnectionAttempt {
  connectionGeneration: number;
  transportGeneration: number;
  attemptNumber: number;
  stage: string;
  ended: boolean;
}

function closeReasonCategory(code: number): string {
  if (code === 1008) return "policy_or_authentication";
  if (code === 1013) return "retryable_service_unavailable";
  if (code === 1000) return "normal";
  if (code === 1001) return "server_shutdown";
  if (code === 1006) return "abnormal_transport_loss";
  return "other";
}

function safeReasonCategory(reason: string): string {
  const normalized = reason.toLowerCase();
  if (normalized.includes("connection setup timeout")) return "connection_setup_timeout";
  if (normalized.includes("stale signaling socket replaced")) return "stale_socket_replaced";
  if (normalized.includes("explicit close")) return "explicit_close";
  if (normalized.includes("device revoked")) return "device_revoked";
  if (normalized.includes("invalid server message")) return "invalid_server_message";
  if (normalized.includes("wrong account role")) return "wrong_account_role";
  return "unclassified";
}

function safeErrorDetails(error: unknown): Record<string, string> {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const knownNames = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "AbortError"]);
  const name = typeof value.name === "string" && knownNames.has(value.name)
    ? value.name
    : "UnknownError";
  const safeMessages = new Map([
    ["socket hang up", "socket hang up"],
    ["websocket was closed before the connection was established", "WebSocket closed before connection"],
    ["invalid url", "invalid URL"],
  ]);
  const safeMessageByCode: Record<string, string> = {
    ECONNREFUSED: "connection refused",
    ECONNRESET: "connection reset",
    ETIMEDOUT: "connection timed out",
    ENOTFOUND: "host resolution failed",
    EHOSTUNREACH: "host unreachable",
    ENETUNREACH: "network unreachable",
    EPIPE: "connection write failed",
    EAI_AGAIN: "host resolution temporarily failed",
  };
  const code = typeof value.code === "string" && Object.hasOwn(safeMessageByCode, value.code)
    ? value.code
    : "";
  const rawMessage = typeof value.message === "string" ? value.message.toLowerCase() : "";
  const message = code ? safeMessageByCode[code] : safeMessages.get(rawMessage);
  return {
    errorName: name,
    ...(message ? { errorMessage: message } : {}),
    ...(code ? { errorCode: code } : {}),
  };
}

export interface DeviceCredentialLoader {
  load(): Promise<string | null>;
}

export class MainSignalingTransport {
  private socket: WebSocket | undefined;
  private stopHeartbeat: (() => void) | undefined;
  private connectionSetupTimer: ReturnType<typeof setTimeout> | undefined;
  private authenticated = false;
  private connectInFlight: Promise<number> | undefined;
  private cancelConnectAttempt: ((generation: number) => void) | undefined;
  private generation = 0;
  private socketConnectionGeneration = 0;
  private authenticatedDeviceId: string | undefined;
  private lastHeartbeatAckAt = 0;
  private heartbeatSentCount = 0;
  private heartbeatAckCount = 0;
  private activeSessionIdValue: string | undefined;
  private activeRecoveryAttemptId: string | undefined;
  private hasStartedConnection = false;
  private reconnectAttemptCount = 0;
  private activeReconnectAttempt: number | undefined;
  private connectionAttemptCount = 0;
  private activeAttempt: ConnectionAttempt | undefined;
  private diagnosticLogger: DiagnosticLogger;

  get deviceId(): string | undefined { return this.authenticatedDeviceId; }
  get connectionGeneration(): number { return this.socketConnectionGeneration; }
  get activeSessionId(): string | undefined { return this.activeSessionIdValue; }
  get hasAuthenticatedOpenSocket(): boolean {
    return Boolean(
      this.socket?.readyState === WebSocket.OPEN &&
      this.authenticated &&
      this.authenticatedDeviceId,
    );
  }

  constructor(
    private readonly apiUrl: string,
    private readonly webOrigin: string,
    private readonly credentials: DeviceCredentialLoader,
    private readonly emit: EventSink,
    private readonly heartbeatIntervalMs = 15_000,
    private readonly scheduleHeartbeat: HeartbeatScheduler = (callback, delayMs) => {
      const timer = setInterval(callback, delayMs);
      timer.unref();
      return () => clearInterval(timer);
    },
    private readonly now: () => number = Date.now,
    private readonly connectionSetupTimeoutMs = 15_000,
    private readonly terminationHandlerTimeoutMs = 1_000,
    private readonly createWebSocket: WebSocketFactory = (url, options) => new WebSocket(url, options),
    diagnosticLogger: DiagnosticLogger = (level, entry) => {
      console[level](JSON.stringify(entry));
    },
  ) {
    this.diagnosticLogger = diagnosticLogger;
  }

  setDiagnosticLogger(logger: DiagnosticLogger): void {
    this.diagnosticLogger = logger;
  }

  async connect(): Promise<number> {
    const socket = this.socket;
    if (socket) {
      if (
        this.hasAuthenticatedOpenSocket
      ) {
        this.emit({
          type: "open",
          connectionGeneration: this.socketConnectionGeneration,
          authenticatedTransportReuse: true,
          deviceId: this.authenticatedDeviceId,
        });
        return this.socketConnectionGeneration;
      }
      if (
        socket.readyState === WebSocket.CONNECTING ||
        (socket.readyState === WebSocket.OPEN &&
          !this.authenticated &&
          this.connectionSetupTimer !== undefined)
      ) {
        return this.connectInFlight ?? Promise.resolve(this.socketConnectionGeneration);
      }
      this.retireSocket(socket, 1006, "stale signaling socket replaced", true, "connect_reuse");
    }
    if (this.connectInFlight) return this.connectInFlight;
    const connectionGeneration = ++this.socketConnectionGeneration;
    const attemptNumber = ++this.connectionAttemptCount;
    const reconnectAttempt = this.hasStartedConnection
      ? ++this.reconnectAttemptCount
      : undefined;
    if (reconnectAttempt !== undefined) {
      this.activeReconnectAttempt = reconnectAttempt;
      this.logDiagnostic("info", "reconnect_attempt_started", {
        reconnectAttempt,
        socketConnectionGeneration: connectionGeneration,
      });
    }
    this.hasStartedConnection = true;
    const generation = this.generation;
    const attempt: ConnectionAttempt = {
      connectionGeneration,
      transportGeneration: generation,
      attemptNumber,
      stage: "credential_loading",
      ended: false,
    };
    this.activeAttempt = attempt;
    this.logDiagnostic("info", "connection_attempt_started", {
      attemptId: connectionGeneration,
      attemptNumber,
      reconnectAttempt: reconnectAttempt ?? null,
    });
    let cancel!: (generation: number) => void;
    const cancellation = new Promise<number>((resolve) => {
      cancel = resolve;
    });
    this.cancelConnectAttempt = cancel;
    let setupTimer: ReturnType<typeof setTimeout> | undefined;
    const setupTimeout = new Promise<number>((_resolve, reject) => {
      setupTimer = setTimeout(() => {
        if (this.generation !== generation) return;
        const socket = this.socket;
        this.logDiagnostic("warn", "connection_setup_timeout", {
          attemptId: connectionGeneration,
          attemptNumber,
          stage: attempt.stage,
          closeCode: 1013,
        });
        this.endAttempt(attempt, "setup_timeout");
        if (socket) {
          const timedOutDuringOpen = socket.readyState === WebSocket.CONNECTING;
          this.retireSocket(
            socket,
            1013,
            "connection setup timeout",
            false,
            timedOutDuringOpen ? "websocket_open_timeout" : "authentication_timeout",
          );
        } else {
          this.generation += 1;
          this.clearConnectionSetupTimer(setupTimer);
        }
        reject(new Error("signaling connection setup timed out"));
      }, this.connectionSetupTimeoutMs);
      setupTimer.unref();
      this.connectionSetupTimer = setupTimer;
    });
    const pending = Promise.race([this.openSocket(attempt), cancellation, setupTimeout]);
    this.connectInFlight = pending;
    try {
      return await pending;
    } catch (error) {
      if (reconnectAttempt !== undefined && this.activeReconnectAttempt === reconnectAttempt) {
        this.logDiagnostic("warn", "reconnect_attempt_failed", {
          reconnectAttempt,
          socketConnectionGeneration: connectionGeneration,
          closeReasonCategory: "connection_attempt_failed",
        });
        this.activeReconnectAttempt = undefined;
      }
      throw error;
    } finally {
      if (
        setupTimer !== undefined &&
        (this.generation !== generation || !this.socket || this.authenticated)
      ) {
        this.clearConnectionSetupTimer(setupTimer);
      }
      if (this.connectInFlight === pending) this.connectInFlight = undefined;
      if (this.cancelConnectAttempt === cancel) this.cancelConnectAttempt = undefined;
    }
  }

  private async openSocket(attempt: ConnectionAttempt): Promise<number> {
    const { connectionGeneration: socketConnectionGeneration } = attempt;
    this.logDiagnostic("info", "credential_loading_started", { attemptId: socketConnectionGeneration });
    let token: string | null;
    try {
      token = await this.credentials.load();
    } catch (error) {
      this.logDiagnostic("error", "credential_loading_failed", {
        attemptId: socketConnectionGeneration,
        ...safeErrorDetails(error),
      });
      this.endAttempt(attempt, "credential_loading_failed");
      throw error;
    }
    if (!token) {
      this.logDiagnostic("warn", "credential_loading_failed", {
        attemptId: socketConnectionGeneration,
        reason: "credential_unavailable",
      });
      this.endAttempt(attempt, "credential_unavailable");
      throw new Error("device is not enrolled");
    }
    this.logDiagnostic("info", "credential_loading_completed", { attemptId: socketConnectionGeneration });
    if (attempt.transportGeneration !== this.generation) {
      this.endAttempt(attempt, "superseded_before_socket_creation");
      return 0;
    }

    attempt.stage = "websocket_construction";
    this.logDiagnostic("info", "websocket_construction_started", { attemptId: socketConnectionGeneration });
    let socket: WebSocket;
    try {
      const wsUrl = new URL("/ws", this.apiUrl);
      wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
      socket = this.createWebSocket(wsUrl, {
        origin: this.webOrigin,
        handshakeTimeout: 10_000,
        maxPayload: 128 * 1024,
      });
    } catch (error) {
      this.logDiagnostic("error", "websocket_construction_failed", {
        attemptId: socketConnectionGeneration,
        ...safeErrorDetails(error),
      });
      this.endAttempt(attempt, "websocket_construction_failed");
      throw error;
    }
    this.logDiagnostic("info", "websocket_construction_completed", { attemptId: socketConnectionGeneration });
    attempt.stage = "websocket_open";
    this.socket = socket;
    socket.once("open", () => {
      if (this.socket !== socket) return;
      attempt.stage = "authentication";
      this.logDiagnostic("info", "websocket_open", { attemptId: socketConnectionGeneration });
      this.emit({
        type: "authentication-started",
        connectionGeneration: socketConnectionGeneration,
      });
      this.logDiagnostic("info", "owner_authentication_started", {
        socketConnectionGeneration,
      });
      try {
        socket.send(JSON.stringify({ type: "auth", token }));
        this.logDiagnostic("info", "authentication_message_sent", {
          attemptId: socketConnectionGeneration,
        });
      } catch (error) {
        this.logDiagnostic("error", "authentication_message_send_failed", {
          attemptId: socketConnectionGeneration,
          ...safeErrorDetails(error),
        });
        socket.terminate();
      }
    });
    socket.on("message", (raw) => {
      if (this.socket !== socket) return;
      let value: unknown;
      try {
        value = JSON.parse(raw.toString());
      } catch {
        socket.close(1008, "invalid server message");
        return;
      }
      const message = parseServerMessage(value);
      if (!message) {
        socket.close(1008, "invalid server message");
        return;
      }
      if (message.type === "authenticated") {
        if (message.role !== "owner" || !message.device_id) {
          this.logDiagnostic("warn", "authentication_rejected", {
            attemptId: socketConnectionGeneration,
            reason: "unexpected_role_or_missing_device_id",
          });
          this.endAttempt(attempt, "authentication_rejected");
          this.stopHeartbeatFor(socket);
          socket.close(1008, "wrong account role");
          return;
        }
        this.logDiagnostic("info", "authentication_accepted", {
          attemptId: socketConnectionGeneration,
          authenticated: true,
        });
        this.endAttempt(attempt, "authenticated");
        this.authenticated = true;
        this.clearConnectionSetupTimer();
        this.authenticatedDeviceId = message.device_id;
        this.lastHeartbeatAckAt = this.now();
        this.heartbeatSentCount = 0;
        this.heartbeatAckCount = 0;
        this.logDiagnostic("info", "owner_authentication_completed", {
          socketConnectionGeneration,
        });
        if (this.activeReconnectAttempt !== undefined) {
          this.logDiagnostic("info", "reconnect_attempt_succeeded", {
            reconnectAttempt: this.activeReconnectAttempt,
            socketConnectionGeneration,
          });
          this.activeReconnectAttempt = undefined;
        }
        this.hasStartedConnection = true;
        this.emit({ type: "open", connectionGeneration: socketConnectionGeneration });
        if (!this.stopHeartbeat) {
          this.stopHeartbeat = this.scheduleHeartbeat(() => {
            if (this.socket === socket && this.authenticated && socket.readyState === WebSocket.OPEN) {
              if (this.now() - this.lastHeartbeatAckAt >= this.heartbeatIntervalMs * 2) {
                this.logDiagnostic("warn", "heartbeat_timeout", {
                  socketConnectionGeneration,
                  heartbeatSentCount: this.heartbeatSentCount,
                  heartbeatAckCount: this.heartbeatAckCount,
                  lastHeartbeatAckAgeMs: this.now() - this.lastHeartbeatAckAt,
                });
                socket.terminate();
                return;
              }
              try {
                socket.send(JSON.stringify({ type: "heartbeat" }));
                this.heartbeatSentCount += 1;
                if (this.heartbeatSentCount === 1 || this.heartbeatSentCount % 10 === 0) {
                  this.logDiagnostic("debug", "heartbeat_sent", {
                    socketConnectionGeneration,
                    heartbeatSentCount: this.heartbeatSentCount,
                  });
                }
              } catch {
                this.logDiagnostic("warn", "heartbeat_send_failed", {
                  socketConnectionGeneration,
                  heartbeatSentCount: this.heartbeatSentCount,
                  heartbeatAckCount: this.heartbeatAckCount,
                });
                socket.terminate();
              }
            }
          }, this.heartbeatIntervalMs);
        }
      }
      if (message.type === "heartbeat_ack") {
        const previousAckAt = this.lastHeartbeatAckAt;
        this.lastHeartbeatAckAt = this.now();
        this.heartbeatAckCount += 1;
        if (this.heartbeatAckCount === 1 || this.heartbeatAckCount % 10 === 0) {
          this.logDiagnostic("info", "heartbeat_ack_received", {
            socketConnectionGeneration,
            heartbeatAckCount: this.heartbeatAckCount,
            heartbeatAckIntervalMs: previousAckAt ? this.lastHeartbeatAckAt - previousAckAt : undefined,
          });
        }
      }
      if (
        message.type === "viewer_joined" ||
        message.type === "viewer_rejoined" ||
        message.type === "session_recovery" ||
        message.type === "session_resumed"
      ) {
        this.activeSessionIdValue = message.session_id;
        if (message.type === "session_recovery") {
          this.activeRecoveryAttemptId = message.recovery_attempt_id;
        } else {
          this.activeRecoveryAttemptId = undefined;
        }
      }
      if (
        message.type === "viewer_left" &&
        message.session_id === this.activeSessionIdValue &&
        message.reason !== "temporary_disconnect"
      ) {
        this.activeSessionIdValue = undefined;
        this.activeRecoveryAttemptId = undefined;
      }
      this.emit({
        type: "message",
        data: JSON.stringify(message),
        connectionGeneration: socketConnectionGeneration,
      });
    });
    socket.on("error", (error) => {
      if (this.socket !== socket) return;
      this.logDiagnostic("error", "websocket_error", {
        attemptId: socketConnectionGeneration,
        stage: attempt.stage,
        ...safeErrorDetails(error),
      });
      if (this.socket === socket) {
        this.emit({
          type: "error",
          message: "signaling connection failed",
          connectionGeneration: socketConnectionGeneration,
        });
      }
    });
    socket.on("unexpected-response", (_request, response) => {
      if (this.socket !== socket) {
        response.resume();
        return;
      }
      this.logDiagnostic("warn", "websocket_unexpected_response", {
        attemptId: socketConnectionGeneration,
        stage: attempt.stage,
        statusCode: response.statusCode ?? null,
        statusClass: response.statusCode
          ? `${Math.floor(response.statusCode / 100)}xx`
          : "unknown",
        responseMetadata: "headers_and_body_omitted",
      });
      response.resume();
      socket.terminate();
    });
    socket.once("close", (code, rawReason) => {
      if (this.socket !== socket) return;
      const reason = rawReason.toString();
      this.logDiagnostic("warn", "websocket_close", {
        attemptId: socketConnectionGeneration,
        closeCode: code,
        closeReasonCategory: safeReasonCategory(reason),
        expected: false,
      });
      if (!attempt.ended) {
        if (attempt.stage === "authentication") {
          this.logDiagnostic("warn", "authentication_rejected", {
            attemptId: socketConnectionGeneration,
            reason: "socket_closed_before_acceptance",
          });
        }
        this.endAttempt(attempt, "websocket_closed");
      }
      this.logDiagnostic("warn", "websocket_closed", {
        socketConnectionGeneration,
        closeCode: code,
        closeReasonCategory: closeReasonCategory(code),
        heartbeatSentCount: this.heartbeatSentCount,
        heartbeatAckCount: this.heartbeatAckCount,
        lastHeartbeatAckAgeMs: this.lastHeartbeatAckAt
          ? this.now() - this.lastHeartbeatAckAt
          : undefined,
      });
      if (this.activeReconnectAttempt !== undefined) {
        this.logDiagnostic("warn", "reconnect_attempt_failed", {
          reconnectAttempt: this.activeReconnectAttempt,
          socketConnectionGeneration,
          closeCode: code,
          closeReasonCategory: closeReasonCategory(code),
        });
        this.activeReconnectAttempt = undefined;
      }
      this.cleanup(socket);
      this.emit({ type: "close", code, connectionGeneration: socketConnectionGeneration });
    });
    return socketConnectionGeneration;
  }

  private retireSocket(
    socket: WebSocket,
    closeCode = 1006,
    reason = "stale signaling socket replaced",
    cancelAttempt = true,
    initiatingPath = "connect_reuse",
  ): void {
    if (this.socket !== socket) return;
    const connectionGeneration = this.socketConnectionGeneration;
    const reasonCategory = safeReasonCategory(reason);
    this.logDiagnostic("warn", "socket_retirement", {
      attemptId: connectionGeneration,
      closeCode,
      closeReasonCategory: reasonCategory,
      initiatingPath,
    });
    this.logDiagnostic("warn", "websocket_close", {
      attemptId: connectionGeneration,
      closeCode,
      closeReasonCategory: reasonCategory,
      expected: true,
    });
    this.generation += 1;
    const cancel = this.cancelConnectAttempt;
    this.cancelConnectAttempt = undefined;
    this.connectInFlight = undefined;
    if (cancelAttempt) cancel?.(0);
    if (this.activeAttempt && this.activeAttempt.connectionGeneration === connectionGeneration) {
      this.endAttempt(this.activeAttempt, reasonCategory);
    }
    this.cleanup(socket, true);
    if (socket.readyState === WebSocket.CONNECTING || closeCode === 1006) {
      socket.terminate();
    } else {
      socket.close(closeCode, reason);
    }
    this.emit({ type: "close", code: closeCode, connectionGeneration });
    if (closeCode === 1006) {
      this.logDiagnostic("warn", "stale_socket_retired", {
        socketConnectionGeneration: connectionGeneration,
        closeReasonCategory: "stale_socket_replaced",
      });
    }
  }

  private logDiagnostic(
    level: "debug" | "info" | "warn" | "error",
    event: string,
    details: Record<string, unknown> = {},
  ): void {
    try {
      this.diagnosticLogger(level, {
        source: "desktop-main",
        event,
        timestamp: new Date(this.now()).toISOString(),
        webSocketReadyState: this.getWebSocketReadyState(),
        authenticated: this.authenticated,
        activeConnectionGeneration: this.socketConnectionGeneration,
        ...details,
      });
    } catch {
      // Diagnostics must not interrupt signaling lifecycle operations.
    }
  }

  private getWebSocketReadyState(): "not-connected" | "connecting" | "open" | "closing" | "closed" | "unknown" {
    const socket = this.socket;
    if (!socket) return "not-connected";
    switch (socket.readyState) {
      case WebSocket.CONNECTING: return "connecting";
      case WebSocket.OPEN: return "open";
      case WebSocket.CLOSING: return "closing";
      case WebSocket.CLOSED: return "closed";
      default: return "unknown";
    }
  }

  private endAttempt(attempt: ConnectionAttempt, outcome: string): void {
    if (attempt.ended) return;
    attempt.ended = true;
    if (this.activeAttempt === attempt) this.activeAttempt = undefined;
    this.logDiagnostic("info", "connection_attempt_ended", {
      attemptId: attempt.connectionGeneration,
      attemptNumber: attempt.attemptNumber,
      outcome,
    });
  }

  send(raw: string, expectedGeneration?: number): void {
    const socket = this.socket;
    const reject = (
      transportReason: "stale_generation" | "socket_not_open" | "invalid_message" | "message_not_allowed" | "socket_send_failed",
      message: string,
    ): never => {
      this.logDiagnostic("warn", "signaling_send_rejected", {
        requestedConnectionGeneration: expectedGeneration,
        publicationOutcome: "send_rejected",
        transportReason,
      });
      throw new Error(message);
    };
    if (expectedGeneration !== undefined && expectedGeneration !== this.socketConnectionGeneration) {
      return reject("stale_generation", "signaling socket generation is stale");
    }
    if (!socket || !this.authenticated || socket.readyState !== WebSocket.OPEN) {
      return reject("socket_not_open", "signaling socket is not open");
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return reject("invalid_message", "invalid signaling message");
    }
    const message = parseClientMessage(value);
    if (!message || !this.allowedOwnerMessage(message)) {
      return reject("message_not_allowed", "signaling message is not allowed");
    }
    try {
      socket.send(JSON.stringify(message));
    } catch (error) {
      this.logDiagnostic("warn", "signaling_send_rejected", {
        requestedConnectionGeneration: expectedGeneration,
        publicationOutcome: "send_rejected",
        transportReason: "socket_send_failed",
      });
      throw error;
    }
    if (message.type === "sharing_state") {
      this.logDiagnostic("info", "sharing_state_transport_sent", {
        requestedConnectionGeneration: expectedGeneration ?? this.socketConnectionGeneration,
        publicationOutcome: "sent",
        sharingState: { screen: message.screen, camera: message.camera },
      });
      if (!message.screen) {
        this.activeSessionIdValue = undefined;
        this.activeRecoveryAttemptId = undefined;
      }
    }
    if (message.type === "offer" || message.type === "ice_candidate") {
      this.activeSessionIdValue = message.session_id;
    }
  }

  async loadIceServers(): Promise<WebRtcConfiguration> {
    const token = await this.credentials.load();
    if (!token) throw new Error("device is not enrolled");
    const response = await fetch(new URL("/webrtc/ice-servers", this.apiUrl), {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`ICE server request failed (${response.status})`);
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || !("iceServers" in payload) ||
      !Array.isArray(payload.iceServers) || payload.iceServers.length === 0) {
      throw new Error("ICE server response is invalid");
    }
    const iceServers = payload.iceServers.map((entry: unknown) => {
      if (!entry || typeof entry !== "object" || !("urls" in entry)) throw new Error("ICE server entry is invalid");
      const urls = entry.urls;
      if (!(typeof urls === "string" || (Array.isArray(urls) && urls.every((url) => typeof url === "string")))) {
        throw new Error("ICE server URL is invalid");
      }
      const username = "username" in entry ? entry.username : undefined;
      const credential = "credential" in entry ? entry.credential : undefined;
      if ((username !== undefined && typeof username !== "string") ||
        (credential !== undefined && typeof credential !== "string")) {
        throw new Error("ICE server credentials are invalid");
      }
      return { urls, ...(username ? { username } : {}), ...(credential ? { credential } : {}) };
    });
    return { iceServers };
  }

  close(expectedGeneration?: number, initiatingPath = "transport_shutdown"): boolean {
    if (expectedGeneration !== undefined && expectedGeneration !== this.socketConnectionGeneration) return false;
    const socket = this.socket;
    const connectionGeneration = this.socketConnectionGeneration;
    this.logDiagnostic("info", "explicit_signaling_close", {
      attemptId: connectionGeneration,
      initiatingPath,
      socketPresent: Boolean(socket),
    });
    if (this.activeAttempt?.connectionGeneration === connectionGeneration) {
      this.endAttempt(this.activeAttempt, "explicit_close");
    }
    this.generation += 1;
    this.clearConnectionSetupTimer();
    const cancel = this.cancelConnectAttempt;
    this.cancelConnectAttempt = undefined;
    this.connectInFlight = undefined;
    cancel?.(0);
    if (socket) {
      this.logDiagnostic("warn", "socket_retirement", {
        attemptId: connectionGeneration,
        closeCode: 1000,
        reason: "explicit_close",
        initiatingPath,
      });
      this.logDiagnostic("info", "websocket_close", {
        attemptId: connectionGeneration,
        closeCode: 1000,
        closeReason: "normal",
        expected: true,
      });
      this.cleanup(socket, true);
      socket.close();
      this.emit({
        type: "close",
        code: 1000,
        connectionGeneration: this.socketConnectionGeneration,
      });
    }
    return true;
  }

  private cleanup(socket: WebSocket, retainTerminationHandlers = false): void {
    if (this.socket !== socket) return;
    this.stopHeartbeatFor(socket);
    this.clearConnectionSetupTimer();
    this.authenticated = false;
    this.authenticatedDeviceId = undefined;
    this.lastHeartbeatAckAt = 0;
    this.activeSessionIdValue = undefined;
    this.activeRecoveryAttemptId = undefined;
    this.socket = undefined;
    socket.removeAllListeners("open");
    socket.removeAllListeners("message");
    socket.removeAllListeners("error");
    socket.removeAllListeners("close");
    if (retainTerminationHandlers) {
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      let handlersActive = true;
      const removeTerminationHandlers = (): void => {
        if (!handlersActive) return;
        handlersActive = false;
        if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
        socket.off("error", onError);
        socket.off("close", onClose);
      };
      const terminateAfterGracePeriod = (): void => {
        if (!handlersActive) return;
        if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
        if (handlersActive) {
          cleanupTimer = setTimeout(removeTerminationHandlers, this.terminationHandlerTimeoutMs);
          cleanupTimer.unref();
        }
      };
      const onError = (): void => {};
      const onClose = (): void => {
        removeTerminationHandlers();
      };
      socket.on("error", onError);
      socket.once("close", onClose);
      cleanupTimer = setTimeout(terminateAfterGracePeriod, this.terminationHandlerTimeoutMs);
      cleanupTimer.unref();
    }
  }

  private clearConnectionSetupTimer(expectedTimer?: ReturnType<typeof setTimeout>): void {
    if (
      expectedTimer !== undefined &&
      this.connectionSetupTimer !== expectedTimer
    ) return;
    if (this.connectionSetupTimer !== undefined) clearTimeout(this.connectionSetupTimer);
    this.connectionSetupTimer = undefined;
  }

  private stopHeartbeatFor(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.stopHeartbeat?.();
    this.stopHeartbeat = undefined;
    this.authenticated = false;
  }

  private allowedOwnerMessage(message: ClientMessage): boolean {
    return message.type === "heartbeat" ||
      message.type === "sharing_state" ||
      message.type === "prepare_sleep" ||
      message.type === "resume_session" ||
      message.type === "leave_session" ||
      message.type === "offer" ||
      message.type === "ice_candidate";
  }
}
