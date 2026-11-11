import {
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
  type TrackMap,
} from "./protocol.js";
import {
  candidateTypeFromCandidate,
  WebRtcPeer,
  WebRtcPeerError,
  type PeerState,
  type WebRtcDiagnostic,
  type WebRtcFailureCategory,
  type WebRtcTrack,
  type WebRtcConfiguration,
  type WebRtcFactory,
} from "./webrtc.js";

export type ClientLifecycleState =
  | "IDLE"
  | "CONNECTING"
  | "RECONNECTING"
  | "NEGOTIATING"
  | "CONNECTED"
  | "CLOSING"
  | "CLOSED"
  | "FAILED";

export type ClientSignalingDiagnostic = {
  event:
    | "websocket_closed"
    | "reconnect_attempt_started"
    | "websocket_reconnected"
    | "owner_authentication_completed"
    | "session_recovery_received"
    | "recovery_attempt_queued"
    | "recovery_attempt_started"
    | "ice_restart_answer_received"
    | "ice_restart_answer_applied"
    | "ice_candidate_received"
    | "ice_candidate_rejected"
    | "offer_received"
    | "answer_received"
    | "answer_applied"
    | "signaling_message_rejected"
    | "lifecycle_changed";
  timestamp: string;
  deviceId?: string;
  sessionId?: string;
  recoveryAttemptId?: string;
  peerGeneration?: number;
  negotiationId?: string;
  socketConnectionGeneration?: number;
  reason?: string;
  peerState?: PeerState;
  iceState?: string;
  messageType?: string;
  candidateType?: WebRtcDiagnostic["candidateType"];
  attempt?: number;
  lifecycle?: ClientLifecycleState;
};

export type DesktopDiagnostic = {
  event:
    | "lifecycle"
    | "peer"
    | "failure"
    | "sharing-state"
    | "signaling"
    | "recovery"
    | "recovery_started"
    | "signaling_reconnected"
    | "session_recovery_received"
    | "ice_restart_started"
    | "ice_restart_failed"
    | "ice_restart_retry_scheduled"
    | "recovery_completed"
    | "recovery_timed_out"
    | ClientSignalingDiagnostic["event"]
    | NonNullable<WebRtcDiagnostic["event"]>
    | "ice_configuration_refresh_started"
    | "ice_configuration_refresh_completed"
    | "ice_configuration_refresh_failed";
  timestamp?: string;
  lifecycle: ClientLifecycleState;
  deviceId?: string;
  sessionId?: string;
  recoveryAttemptId?: string;
  recoveryPhase?: string;
  peerGeneration?: number;
  negotiationId?: string;
  socketConnectionGeneration?: number;
  peerState?: PeerState;
  iceState?: string;
  candidateType?: WebRtcDiagnostic["candidateType"];
  messageType?: string;
  attempt?: number;
  reason?: string;
  signalingState?: "connecting" | "open" | "closed" | "not-connected";
  sharingState?: { screen: boolean; camera: boolean };
  sent?: boolean;
  category?: WebRtcFailureCategory | "signaling" | "timeout";
  message?: string;
  peer?: WebRtcDiagnostic;
};

export type RecoveryDiagnostic = {
  event: "recovery";
  phase: string;
  timestamp?: string;
  recoveryAttemptId: string;
  sessionId?: string;
  peerGeneration?: number;
  negotiationId?: string;
  socketConnectionGeneration?: number;
  signalingState?: "connecting" | "open" | "closed" | "not-connected";
  peer?: WebRtcDiagnostic;
};

export interface SignalingSocket {
  readyState: number;
  connectionGeneration?: number;
  authenticationManaged?: boolean;
  connect?: () => void;
  send(data: string): void | Promise<void>;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event?: { code?: number }) => void) | null;
  onerror: (() => void) | null;
}

export type SignalingSocketFactory = () => SignalingSocket;
export type ClientScheduler = {
  now: () => number;
  random: () => number;
  setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
};

export const INITIAL_NEGOTIATION_TIMEOUT_MS = 30_000;
export const NETWORK_RECOVERY_TIMEOUT_MS = 180_000;

const defaultScheduler: ClientScheduler = {
  now: () => Date.now(),
  random: () => Math.random(),
  setTimeout: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs) as ReturnType<typeof setTimeout> & {
      unref?: () => void;
    };
    timer.unref?.();
    return timer;
  },
  clearTimeout: (timer) => clearTimeout(timer),
};

export type ReconnectOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  stableResetMs?: number;
  recoveryTimeoutMs?: number;
  scheduler?: Partial<ClientScheduler>;
};

function scheduler(options?: ReconnectOptions): ClientScheduler {
  return {
    ...defaultScheduler,
    ...options?.scheduler,
  };
}

function socketMessage(event: { data: unknown }): ServerMessage | null {
  if (typeof event.data !== "string") return null;
  try {
    return parseServerMessage(JSON.parse(event.data));
  } catch {
    return null;
  }

}

export abstract class WebRtcClient {
  protected readonly socketFactory: SignalingSocketFactory;
  protected readonly peerFactory: WebRtcFactory;
  protected socket: SignalingSocket | undefined;
  protected peer: WebRtcPeer | undefined;
  protected sessionId: string | undefined;
  private lifecycleValue: ClientLifecycleState = "IDLE";
  protected ownerDeviceId: string | undefined;
  protected terminalFailure: Error | undefined;
  protected failureSessionId: string | undefined;
  protected closing = false;
  protected terminal = false;
  protected signalingAuthenticated = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private stableTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempts = 0;
  private initialNegotiationTimer: ReturnType<typeof setTimeout> | undefined;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  protected peerGeneration = 0;
  protected socketConnectionGeneration = 0;
  protected recoveryAttemptId: string | undefined;
  protected readonly pendingIceCandidatesByNegotiation = new Map<string, unknown[]>();
  private readonly reconnectOptions: Required<Omit<ReconnectOptions, "scheduler">>;
  protected readonly clientScheduler: ClientScheduler;
  onRemoteTrack: ((track: WebRtcTrack, mid: string | null, kind?: "screen" | "camera") => void) | undefined;
  onShareRequest: ((request: Extract<ServerMessage, { type: "share_request" }>) => void) | undefined;

  protected constructor(
    socketFactory: SignalingSocketFactory,
    peerFactory: WebRtcFactory,
    reconnectOptions?: ReconnectOptions,
  ) {
    this.socketFactory = socketFactory;
    this.peerFactory = peerFactory;
    this.clientScheduler = scheduler(reconnectOptions);
    this.reconnectOptions = {
      maxAttempts: reconnectOptions?.maxAttempts ?? Number.POSITIVE_INFINITY,
      baseDelayMs: reconnectOptions?.baseDelayMs ?? 1_000,
      maxDelayMs: reconnectOptions?.maxDelayMs ?? 30_000,
      stableResetMs: reconnectOptions?.stableResetMs ?? 60_000,
      recoveryTimeoutMs: reconnectOptions?.recoveryTimeoutMs ?? NETWORK_RECOVERY_TIMEOUT_MS,
    };
  }

  get lifecycle(): ClientLifecycleState { return this.lifecycleValue; }
  get failure(): Error | undefined { return this.terminalFailure; }

  protected setLifecycle(value: ClientLifecycleState): void {
    if (this.terminal && !["FAILED", "CLOSING", "CLOSED"].includes(value)) return;
    if (this.closing && !["CLOSING", "CLOSED"].includes(value)) return;
    if (this.lifecycleValue === value) return;
    const previous = this.lifecycleValue;
    this.lifecycleValue = value;
    this.reportClientDiagnostic("lifecycle_changed", {
      reason: `${previous} -> ${value}`,
      lifecycle: value,
    });
    this.onLifecycleChange(value);
  }

  protected connect(
    token: string | undefined,
    messageHandler: (message: ServerMessage, socket: SignalingSocket) => void | Promise<void> =
      (message, socket) => this.handleMessage(message, socket),
  ): void {
    if (this.closing || this.terminal || this.socket) return;
    this.setLifecycle(this.peer && this.sessionId ? "RECONNECTING" : "CONNECTING");
    const socket = this.socketFactory();
    this.socketConnectionGeneration = socket.connectionGeneration ?? this.socketConnectionGeneration + 1;
    this.socket = socket;
    this.signalingAuthenticated = false;
    socket.onopen = () => {
      if (this.socket !== socket || this.terminal || this.closing) return;
      if (!socket.authenticationManaged) {
        if (!token) {
          this.fail(new Error("Signaling credential is unavailable"), "signaling");
          socket.close();
          return;
        }
        this.send({ type: "auth", token });
      }
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket || this.terminal || this.closing) return;
      const message = socketMessage(event);
      if (message) {
        const handleFailure = (error: unknown) => {
          if (this.socket === socket && !this.terminal && !this.closing) {
            this.fail(error);
          }
        };
        try {
          void Promise.resolve(messageHandler(message, socket)).catch(handleFailure);
        } catch (error) {
          handleFailure(error);
        }
      } else this.fail(new Error("Received malformed signaling message"), "signaling");
    };
    socket.onerror = () => {
      if (this.socket !== socket) return;
      socket.close();
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.signalingAuthenticated = false;
      const preservePeer = this.shouldPreservePeerOnSocketClose();
      if (!preservePeer) this.closePeer();
      this.clearStableTimer();
      if (!this.closing) {
        if (preservePeer && !this.terminal) this.beginRecovery();
        this.reportClientDiagnostic("websocket_closed", {
          reason: `socket close code ${event?.code ?? "unknown"}`,
        });
        this.onSocketClosed(event?.code);
        if (event?.code === 1008) {
          this.markTerminal();
          this.fail(new Error("Signaling authentication was rejected"), "signaling");
        } else if (!this.terminal) {
          if (!preservePeer) this.setLifecycle("CLOSED");
          this.onControlPlaneClosed();
        }
      }
    };
    socket.connect?.();
  }

  protected send(message: ClientMessage): void {
    if (!this.socket || this.socket.readyState !== 1) throw new Error("signaling socket is not open");
    const result = this.socket.send(JSON.stringify(message));
    if (result && typeof result.then === "function") void result.catch(() => undefined);
  }

  protected async sendAndWait(message: ClientMessage): Promise<void> {
    if (!this.socket || this.socket.readyState !== 1) throw new Error("signaling socket is not open");
    await this.socket.send(JSON.stringify(message));
  }

  protected createPeer(
    role: "owner" | "viewer",
    sessionId: string,
    configuration?: WebRtcConfiguration,
    initialNegotiationTimeoutMs: number | null = INITIAL_NEGOTIATION_TIMEOUT_MS,
    negotiationId?: string,
  ): WebRtcPeer {
    this.closePeer();
    const peer = new WebRtcPeer(
      role,
      sessionId,
      () => this.peerFactory(configuration),
      (message) => this.send(message),
      negotiationId,
    );
    peer.setStateListener((state) => this.onPeerState(state));
    peer.setDiagnosticListener((diagnostic) => this.onPeerDiagnostic({
      ...diagnostic,
      peerGeneration: this.peerGeneration,
      ...(this.recoveryAttemptId ? { recoveryAttemptId: this.recoveryAttemptId } : {}),
      socketConnectionGeneration: this.socketConnectionGeneration,
    }));
    peer.setFailureListener((error) => this.fail(error));
    peer.setRemoteTrackListener((track, mid, kind) => this.onRemoteTrack?.(track, mid, kind));
    this.peer = peer;
    this.sessionId = sessionId;
    if (initialNegotiationTimeoutMs !== null) {
      this.startInitialNegotiationTimeout(peer, initialNegotiationTimeoutMs);
    }
    return peer;
  }

  protected startInitialNegotiationTimeout(
    peer: WebRtcPeer,
    timeoutMs = INITIAL_NEGOTIATION_TIMEOUT_MS,
  ): void {
    this.clearInitialNegotiationTimer();
    this.initialNegotiationTimer = this.clientScheduler.setTimeout(() => {
      this.initialNegotiationTimer = undefined;
      if (this.peer !== peer || this.lifecycleValue !== "NEGOTIATING") return;
      this.markTerminal();
      this.fail(
        new Error(`initial ICE negotiation timed out after ${timeoutMs / 1000} seconds`),
        "timeout",
      );
      this.socket?.close();
    }, timeoutMs);
  }

  protected onPeerState(state: PeerState): void {
    if (this.terminal || this.closing) return;
    if (state === "connected") {
      this.clearInitialNegotiationTimer();
      this.completeRecovery();
      this.setLifecycle("CONNECTED");
    }
    else if (state === "failed") {
      const peer = this.peer?.diagnostic;
      const category = peer?.iceConnectionState === "failed" ? "ice" : "peer";
      this.fail(
        new Error(
          `Peer entered failed state (connection=${peer?.connectionState ?? "unknown"}, ` +
          `ice=${peer?.iceConnectionState ?? "unknown"}, signaling=${peer?.signalingState ?? "unknown"})`,
        ),
        category,
      );
    }
    else if (state === "connecting") this.setLifecycle("NEGOTIATING");
  }

  protected async handleMessage(message: ServerMessage, sourceSocket?: SignalingSocket): Promise<void> {
    if (this.terminal || this.closing) return;
    if (message.type === "authenticated") {
      if (message.role === "owner") this.ownerDeviceId = message.device_id;
      await this.onAuthenticated(sourceSocket);
      if (
        this.terminal ||
        this.closing ||
        (sourceSocket && this.socket !== sourceSocket)
      ) return;
      this.signalingAuthenticated = true;
      this.startStableTimer();
      this.onSignalingAuthenticated();
      if (message.role === "owner") {
        this.reportClientDiagnostic("owner_authentication_completed", {
          reason: "authenticated message processed by shared signaling client",
          messageType: "authenticated",
        });
        if (this.socketConnectionGeneration > 1) {
          this.reportClientDiagnostic("websocket_reconnected", {
            reason: "replacement signaling socket authenticated",
            messageType: "authenticated",
          });
        }
      }
      if (this.peer?.state === "connected") {
        this.completeRecovery();
        this.setLifecycle("CONNECTED");
      }
      return;
    }

    if (this.onServerMessage(message)) return;
    if (message.type === "sleep_marked") {
      this.onSleepMarked(message);
    } else if (message.type === "resume_pending") {
      this.onResumePending(message);
    } else if (message.type === "session_resumed") {
      this.onSessionResumed(message);
    } else if (message.type === "session_recovery") {
      this.reportClientDiagnostic("session_recovery_received", {
        sessionId: message.session_id,
        recoveryAttemptId: message.recovery_attempt_id,
        messageType: message.type,
      });
      this.onSessionRecovery(message);
    } else if (message.type === "offer" || message.type === "answer" || message.type === "ice_candidate") {
      if (message.session_id !== this.sessionId || !this.peer) {
        this.reportClientDiagnostic("signaling_message_rejected", {
          sessionId: message.session_id,
          negotiationId: message.negotiation_id,
          messageType: message.type,
          reason: !this.peer ? "no active peer" : "session ID did not match active session",
        });
        this.fail(new Error("Signaling message did not match the active session"), "signaling");
        return;
      }
      let peer = this.peer;
      if (
        message.type === "offer" &&
        peer.negotiationId !== undefined &&
        message.negotiation_id !== peer.negotiationId
      ) {
        if (!this.replacePeerForNegotiation(message)) return;
        peer = this.peer!;
      }
      if (message.type === "ice_candidate" && peer.negotiationId === undefined) {
        this.queueIceCandidate(message.negotiation_id, message.candidate);
        return;
      }
      if (message.type !== "offer" && message.negotiation_id !== peer.negotiationId) {
        if (
          message.type === "ice_candidate" &&
          this.shouldBufferCandidateForNegotiation(message.negotiation_id)
        ) {
          this.reportClientDiagnostic("ice_candidate_received", {
            messageType: message.type,
            negotiationId: message.negotiation_id,
            candidateType: candidateTypeFromCandidate(message.candidate),
            reason: "candidate buffered until matching offer",
          });
          this.queueIceCandidate(message.negotiation_id, message.candidate);
          return;
        }
        if (message.type === "ice_candidate") {
          this.reportClientDiagnostic("ice_candidate_rejected", {
            messageType: message.type,
            negotiationId: message.negotiation_id,
            candidateType: candidateTypeFromCandidate(message.candidate),
            reason: "negotiation ID did not match active peer",
          });
        } else {
          this.reportClientDiagnostic("signaling_message_rejected", {
            messageType: message.type,
            negotiationId: message.negotiation_id,
            reason: "negotiation ID did not match active peer",
          });
        }
        this.onRecoveryDiagnostic(
          "stale_negotiation_signaling_ignored",
          message.negotiation_id,
          message.session_id,
        );
        return;
      }
      const peerGeneration = this.peerGeneration;
      const restartAnswer = message.type === "answer" && peer.restartOfferPending;
      try {
        if (message.type === "offer") {
          this.reportClientDiagnostic("offer_received", {
            messageType: message.type,
            negotiationId: message.negotiation_id,
          });
          if (!message.track_map) {
            return this.fail(new Error("Signaling offer is missing its track map"), "signaling");
          }
          await peer.acceptOffer(message.sdp, message.track_map, message.negotiation_id);
          await this.flushIceCandidates(message.negotiation_id, peer);
        } else if (message.type === "answer") {
          this.reportClientDiagnostic(
            restartAnswer ? "ice_restart_answer_received" : "answer_received",
            { messageType: message.type, negotiationId: message.negotiation_id },
          );
          await peer.acceptAnswer(message.sdp);
        } else if (message.type === "ice_candidate") {
          this.reportClientDiagnostic("ice_candidate_received", {
            messageType: message.type,
            negotiationId: message.negotiation_id,
            candidateType: candidateTypeFromCandidate(message.candidate),
          });
          await peer.addIceCandidate(message.candidate);
        }
      } catch (error) {
        if (this.peer !== peer || this.peerGeneration !== peerGeneration) return;
        if (message.type === "ice_candidate") {
          this.reportClientDiagnostic("ice_candidate_rejected", {
            messageType: message.type,
            negotiationId: message.negotiation_id,
            candidateType: candidateTypeFromCandidate(message.candidate),
            reason: "candidate could not be applied",
          });
        }
        throw error;
      }
      if (this.peer !== peer || this.peerGeneration !== peerGeneration) return;
      if (message.type === "answer") {
        this.reportClientDiagnostic(
          restartAnswer ? "ice_restart_answer_applied" : "answer_applied",
          { messageType: message.type, negotiationId: message.negotiation_id },
        );
        this.onAnswerApplied();
      }
    } else if (message.type === "viewer_left" && message.session_id === this.sessionId) {
      if (message.reason === "temporary_disconnect") {
        this.beginRecovery();
        this.onSessionEnded(message.reason);
        return;
      }
      this.closePeer();
      this.setLifecycle("CLOSED");
      this.onSessionEnded(message.reason);
    } else if (message.type === "share_request" && message.session_id === this.sessionId) {
      this.onShareRequest?.(message);
    } else if (message.type === "error") {
      if (this.onServerError(message.code)) return;
      this.markTerminal();
      this.fail(new Error(`Signaling server rejected the session (${message.code})`), "signaling");
      this.socket?.close();
    }
  }

  private queueIceCandidate(negotiationId: string, candidate: unknown): void {
    let queued = this.pendingIceCandidatesByNegotiation.get(negotiationId);
    if (!queued) {
      if (this.pendingIceCandidatesByNegotiation.size >= 16) {
        this.fail(new Error("ICE negotiation queue is full"), "signaling");
        return;
      }
      queued = [];
    }
    if (queued.length >= 64) {
      this.fail(new Error("ICE candidate queue is full"), "signaling");
      return;
    }
    queued.push(candidate);
    this.pendingIceCandidatesByNegotiation.set(negotiationId, queued);
  }

  private async flushIceCandidates(negotiationId: string, peer: WebRtcPeer): Promise<void> {
    const candidates = this.pendingIceCandidatesByNegotiation.get(negotiationId) ?? [];
    this.pendingIceCandidatesByNegotiation.delete(negotiationId);
    for (const candidate of candidates) {
      if (this.peer !== peer || peer.negotiationId !== negotiationId) return;
      await peer.addIceCandidate(candidate);
    }
  }

  protected onAuthenticated(_sourceSocket?: SignalingSocket): void {}

  protected onSocketClosed(_code?: number): void {}

  protected onServerMessage(_message: ServerMessage): boolean { return false; }

  protected onAnswerApplied(): void {}

  protected onControlPlaneClosed(): void {}

  protected onSessionEnded(_reason: string): void {}

  protected shouldPreservePeerOnSocketClose(): boolean { return false; }

  protected onSessionRecovery(_message: Extract<ServerMessage, { type: "session_recovery" }>): void {}

  protected onInitialNegotiationTimeout(): void {}

  protected onLifecycleChange(_state: ClientLifecycleState): void {}

  protected onPeerDiagnostic(_diagnostic: WebRtcDiagnostic): void {}

  protected onRecoveryCompleted(): void {}

  protected onRecoveryTimeout(error: Error): void {
    this.fail(error, "timeout");
  }

  protected onSignalingAuthenticated(): void {}

  protected replacePeerForNegotiation(
    _message: Extract<ServerMessage, { type: "offer" }>,
  ): boolean {
    return false;
  }

  protected shouldBufferCandidateForNegotiation(_negotiationId: string): boolean {
    return false;
  }

  protected onServerError(_code: string): boolean {
    return false;
  }

  protected onSleepMarked(_message: Extract<ServerMessage, { type: "sleep_marked" }>): void {}

  protected onResumePending(_message: Extract<ServerMessage, { type: "resume_pending" }>): void {}

  protected onSessionResumed(_message: Extract<ServerMessage, { type: "session_resumed" }>): void {}

  protected scheduleReconnect(callback: () => void): void {
    if (this.closing || this.terminal || this.reconnectTimer || this.reconnectAttempts >= this.reconnectOptions.maxAttempts) return;
    const exponential = Math.min(
      this.reconnectOptions.maxDelayMs,
      this.reconnectOptions.baseDelayMs * 2 ** this.reconnectAttempts,
    );
    const jittered = exponential * (0.5 + this.clientScheduler.random());
    this.reconnectAttempts += 1;
    this.reconnectTimer = this.clientScheduler.setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.closing && !this.terminal) {
        this.onReconnectAttemptStarted(this.reconnectAttempts, jittered);
        this.reportClientDiagnostic("reconnect_attempt_started", {
          attempt: this.reconnectAttempts,
          reason: "signaling reconnect timer elapsed",
        });
        callback();
      }
    }, jittered);
  }

  protected cancelReconnect(): void {
    if (this.reconnectTimer !== undefined) this.clientScheduler.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  protected markTerminal(): void {
    if (this.terminal) return;
    this.cancelReconnect();
    this.clearStableTimer();
    this.clearRecoveryTimer();
    this.terminal = true;
  }

  private startStableTimer(): void {
    if (this.terminal || this.closing) return;
    this.clearStableTimer();
    this.stableTimer = this.clientScheduler.setTimeout(() => {
      this.stableTimer = undefined;
      this.reconnectAttempts = 0;
    }, this.reconnectOptions.stableResetMs);
  }

  private clearStableTimer(): void {
    if (this.stableTimer !== undefined) this.clientScheduler.clearTimeout(this.stableTimer);
    this.stableTimer = undefined;
  }

  private clearInitialNegotiationTimer(): void {
    if (this.initialNegotiationTimer !== undefined) {
      this.clientScheduler.clearTimeout(this.initialNegotiationTimer);
    }
    this.initialNegotiationTimer = undefined;
  }

  protected beginRecovery(): void {
    if (!this.peer || !this.sessionId || this.terminal || this.closing) return;
    this.setLifecycle("RECONNECTING");
    if (this.recoveryTimer !== undefined) return;
    this.clearStableTimer();
    this.recoveryTimer = this.clientScheduler.setTimeout(() => {
      this.recoveryTimer = undefined;
      if (!this.peer || this.terminal || this.closing) return;
      this.onRecoveryDiagnostic("timed_out");
      this.onRecoveryTimeout(
        new Error(`network recovery timed out after ${this.reconnectOptions.recoveryTimeoutMs / 1000} seconds`),
      );
    }, this.reconnectOptions.recoveryTimeoutMs);
    this.recoveryAttemptId = crypto.randomUUID();
    this.onRecoveryDiagnostic("started");
  }

  protected completeRecovery(): void {
    if (!this.signalingAuthenticated || this.peer?.state !== "connected") return;
    if (this.recoveryAttemptId) this.onRecoveryDiagnostic("completed");
    this.recoveryAttemptId = undefined;
    this.clearRecoveryTimer();
    this.onRecoveryCompleted();
  }

  protected onRecoveryDiagnostic(
    _phase: string,
    _recoveryAttemptId?: string,
    _sessionId?: string,
    _reason?: string,
  ): void {}

  protected onClientDiagnostic(_diagnostic: ClientSignalingDiagnostic): void {}

  protected onReconnectAttemptStarted(_attempt: number, _delayMs: number): void {}

  protected reportClientDiagnostic(
    event: ClientSignalingDiagnostic["event"],
    fields: Partial<Omit<ClientSignalingDiagnostic, "event" | "timestamp">> = {},
  ): void {
    this.onClientDiagnostic({
      event,
      timestamp: new Date().toISOString(),
      ...(this.ownerDeviceId ? { deviceId: this.ownerDeviceId } : {}),
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(this.recoveryAttemptId ? { recoveryAttemptId: this.recoveryAttemptId } : {}),
      peerGeneration: this.peerGeneration,
      negotiationId: this.peer?.negotiationId,
      socketConnectionGeneration: this.socketConnectionGeneration,
      peerState: this.peer?.state,
      iceState: this.peer?.diagnostic.iceConnectionState,
      lifecycle: this.lifecycleValue,
      ...fields,
    });
  }

  private clearRecoveryTimer(): void {
    if (this.recoveryTimer !== undefined) this.clientScheduler.clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
  }

  protected closePeer(): void {
    this.peerGeneration += 1;
    this.clearInitialNegotiationTimer();
    this.clearRecoveryTimer();
    this.pendingIceCandidatesByNegotiation.clear();
    this.peer?.close();
    this.peer = undefined;
    this.sessionId = undefined;
  }

  protected fail(
    reason: unknown = new Error("WebRTC client failed"),
    category: WebRtcFailureCategory | "signaling" | "timeout" =
      reason instanceof WebRtcPeerError ? reason.category : "signaling",
  ): void {
    if (this.terminal && this.lifecycleValue === "FAILED") {
      this.closePeer();
      return;
    }
    if (this.terminalFailure) {
      this.closePeer();
      return;
    }
    this.failureSessionId = this.sessionId;
    const original = reason instanceof Error ? reason : new Error(String(reason));
    const context = [
      this.ownerDeviceId ? `device ${this.ownerDeviceId}` : undefined,
      this.sessionId ? `session ${this.sessionId}` : undefined,
    ].filter(Boolean).join(", ");
    const contextSuffix = context ? ` (${context})` : "";
    const peerDiagnostic = reason instanceof WebRtcPeerError
      ? ` [connection=${reason.diagnostic.connectionState ?? "unknown"}, ` +
        `ice=${reason.diagnostic.iceConnectionState ?? "unknown"}, ` +
        `signaling=${reason.diagnostic.signalingState ?? "unknown"}]`
      : "";
    this.terminalFailure = new Error(
      `${category}: ${original.message}${contextSuffix}${peerDiagnostic}`,
      { cause: original },
    );
    this.markTerminal();
    this.setLifecycle("FAILED");
    this.closePeer();
    this.onFailure(this.terminalFailure, category);
  }

  protected onFailure(_error: Error, _category: WebRtcFailureCategory | "signaling" | "timeout"): void {}

  close(): void {
    if (this.closing && this.lifecycleValue === "CLOSED") return;
    this.closing = true;
    this.cancelReconnect();
    this.clearStableTimer();
    this.clearRecoveryTimer();
    this.setLifecycle("CLOSING");
    if (this.sessionId) {
      try { this.send({ type: "leave_session", session_id: this.sessionId }); } catch { /* socket already closed */ }
    }
    this.closePeer();
    this.socket?.close();
    this.socket = undefined;
    this.setLifecycle("CLOSED");
  }

  protected sendSessionMessage(message: ClientMessage): void {
    if (!this.sessionId) throw new Error("WebRTC session is not active");
    this.send(message);
  }
}

export type DesktopClientOptions = {
  socketFactory: SignalingSocketFactory;
  peerFactory: WebRtcFactory;
  loadRefreshCredential?: () => Promise<string | null>;
  loadIceServers?: (credential: string) => Promise<WebRtcConfiguration>;
  loadManagedIceServers?: () => Promise<WebRtcConfiguration>;
  managedAuthentication?: boolean;
  isSharingActive?: () => boolean;
  prepareOwnerPeer?: (peer: WebRtcPeer) => Promise<void>;
  onSharingResumed?: () => void;
  onOwnerSessionEnded?: (reason: string) => void;
  reconnect?: ReconnectOptions;
  refreshPresence?: () => Promise<void>;
  onTerminalError?: (error: Error) => void;
  onDiagnostic?: (diagnostic: DesktopDiagnostic) => void;
  onSharingStateConfirmed?: (state: { deviceId: string; screen: boolean; camera: boolean }) => void;
};

export class DesktopWebRtcClient extends WebRtcClient {
  public constructor(options: DesktopClientOptions) {
    super(options.socketFactory, options.peerFactory, options.reconnect);
    this.loadRefreshCredential = options.loadRefreshCredential;
    this.loadIceServers = options.loadIceServers;
    this.loadManagedIceServers = options.loadManagedIceServers;
    this.managedAuthentication = options.managedAuthentication ?? false;
    this.isSharingActive = options.isSharingActive ?? (() => true);
    this.prepareOwnerPeer = options.prepareOwnerPeer;
    this.onSharingResumed = options.onSharingResumed;
    this.onOwnerSessionEnded = options.onOwnerSessionEnded;
    this.refreshPresence = options.refreshPresence;
    this.onTerminalError = options.onTerminalError;
    this.onDiagnostic = options.onDiagnostic;
    this.onSharingStateConfirmed = options.onSharingStateConfirmed;
  }

  private readonly loadRefreshCredential?: () => Promise<string | null>;
  private readonly loadIceServers?: (credential: string) => Promise<WebRtcConfiguration>;
  private readonly loadManagedIceServers?: () => Promise<WebRtcConfiguration>;
  private readonly managedAuthentication: boolean;
  private readonly isSharingActive: () => boolean;
  private readonly prepareOwnerPeer?: (peer: WebRtcPeer) => Promise<void>;
  private readonly onSharingResumed?: () => void;
  private readonly onOwnerSessionEnded?: (reason: string) => void;
  private iceConfiguration: WebRtcConfiguration | undefined;
  private readonly refreshPresence?: () => Promise<void>;
  private readonly onTerminalError?: (error: Error) => void;
  private readonly onDiagnostic?: (diagnostic: DesktopDiagnostic) => void;
  private readonly onSharingStateConfirmed?: (state: { deviceId: string; screen: boolean; camera: boolean }) => void;
  private sharingState = { screen: false, camera: false };
  private confirmedSharingState: { screen: boolean; camera: boolean } | undefined;
  private pendingSharingResumed = false;
  private resume: { sessionId: string; epoch: number; capability: string; expiresAt: number } | undefined;
  private resumeRequestId: string | undefined;
  private sleepMarkerRequest: { requestId: string; resolve: () => void; reject: (error: Error) => void } | undefined;
  private restartResponseTimer: ReturnType<typeof setTimeout> | undefined;
  private startInFlight: Promise<void> | undefined;
  private awaitingControlPlaneRecovery = false;
  private lastSessionRecoveryId: string | undefined;
  private queuedRecoveryEvent = false;
  private pendingIceRecovery = false;
  private restartOfferGeneration: number | undefined;

  protected override onPeerState(state: PeerState): void {
    if (this.terminal || this.closing) return;
    if (state === "connected" && this.pendingSharingResumed) {
      this.pendingSharingResumed = false;
      this.onSharingResumed?.();
    }
    if (
      this.lifecycle === "NEGOTIATING" &&
      (state === "disconnected" || state === "failed")
    ) {
      super.onPeerState(state);
      return;
    }
    if (state === "connected") {
      this.iceRestartInFlight = false;
      this.restartOperationId += 1;
      this.restartOfferGeneration = undefined;
      this.pendingIceRecovery = false;
      this.completeRecovery();
      if (this.iceRecoveryTimer !== undefined) this.clientScheduler.clearTimeout(this.iceRecoveryTimer);
      this.iceRecoveryTimer = undefined;
      this.clearRestartResponseTimer();
      super.onPeerState(state);
      if (!this.signalingAuthenticated || this.socket?.readyState !== 1) {
        this.setLifecycle("RECONNECTING");
      }
      return;
    }
    if (state === "disconnected") {
      this.scheduleIceRecovery();
      return;
    }
    if (state === "failed") {
      this.scheduleIceRecovery(true, true);
      return;
    }
    super.onPeerState(state);
  }

  protected override onControlPlaneClosed(): void {
    this.scheduleReconnect(() => void this.start(true).catch(() => this.onControlPlaneClosed()));
  }

  protected override onLifecycleChange(lifecycle: ClientLifecycleState): void {
    this.onDiagnostic?.({
      event: "lifecycle",
      timestamp: new Date().toISOString(),
      lifecycle,
      ...(this.ownerDeviceId ? { deviceId: this.ownerDeviceId } : {}),
      ...(this.failureSessionId ?? this.sessionId
        ? { sessionId: this.failureSessionId ?? this.sessionId }
        : {}),
      signalingState: this.getSignalingState(),
      peerGeneration: this.peerGeneration,
      negotiationId: this.peer?.negotiationId,
      socketConnectionGeneration: this.socketConnectionGeneration,
      sharingState: { ...this.sharingState },
    });
  }

  protected override onRecoveryDiagnostic(
    recoveryPhase: string,
    recoveryAttemptId?: string,
    sessionId?: string,
    reason?: string,
  ): void {
    const attemptValue = /ice_restart_(?:started|failed)_(\d+)/.exec(recoveryPhase)?.[1];
    const event =
      recoveryPhase === "started" ? "recovery_started" :
      recoveryPhase === "timed_out" ? "recovery_timed_out" :
      recoveryPhase === "completed" ? "recovery_completed" :
      recoveryPhase.startsWith("ice_restart_started_") ? "ice_restart_started" :
      recoveryPhase.startsWith("ice_restart_failed_") ? "ice_restart_failed" : undefined;
    if (event) {
      this.onDiagnostic?.({
        event,
        timestamp: new Date().toISOString(),
        lifecycle: this.lifecycle,
        ...(this.ownerDeviceId ? { deviceId: this.ownerDeviceId } : {}),
        ...(sessionId ?? this.failureSessionId ?? this.sessionId
          ? { sessionId: sessionId ?? this.failureSessionId ?? this.sessionId }
          : {}),
        ...(recoveryAttemptId ?? this.recoveryAttemptId
          ? { recoveryAttemptId: recoveryAttemptId ?? this.recoveryAttemptId }
          : {}),
        recoveryPhase,
        peerGeneration: this.peerGeneration,
        negotiationId: this.peer?.negotiationId,
        socketConnectionGeneration: this.socketConnectionGeneration,
        ...(attemptValue ? { attempt: Number(attemptValue) } : {}),
        ...(reason
          ? { reason }
          : event === "recovery_timed_out"
            ? { reason: "overall recovery deadline expired" }
            : event === "ice_restart_failed"
              ? { reason: "restart failed" }
              : {}),
      });
    }
    this.onDiagnostic?.({
      event: "recovery",
      recoveryPhase,
      timestamp: new Date().toISOString(),
      recoveryAttemptId: recoveryAttemptId ?? this.recoveryAttemptId,
      lifecycle: this.lifecycle,
      ...(this.ownerDeviceId ? { deviceId: this.ownerDeviceId } : {}),
      ...(sessionId ?? this.failureSessionId ?? this.sessionId
        ? { sessionId: sessionId ?? this.failureSessionId ?? this.sessionId }
        : {}),
      signalingState: this.getSignalingState(),
      sharingState: { ...this.sharingState },
      peer: this.peer?.diagnostic,
    });
  }

  protected override onPeerDiagnostic(peer: WebRtcDiagnostic): void {
    this.onDiagnostic?.({
      event: peer.event ?? "peer",
      timestamp: peer.timestamp,
      lifecycle: this.lifecycle,
      ...(this.ownerDeviceId ? { deviceId: this.ownerDeviceId } : {}),
      sessionId: peer.sessionId,
      recoveryAttemptId: peer.recoveryAttemptId,
      peerGeneration: peer.peerGeneration,
      negotiationId: peer.negotiationId,
      socketConnectionGeneration: peer.socketConnectionGeneration,
      peerState: peer.peerState,
      iceState: peer.iceConnectionState,
      candidateType: peer.candidateType,
      reason: peer.reason,
      peer,
    });
  }

  protected override onClientDiagnostic(diagnostic: ClientSignalingDiagnostic): void {
    this.onDiagnostic?.({
      ...diagnostic,
      lifecycle: this.lifecycle,
      signalingState: this.getSignalingState(),
      sharingState: { ...this.sharingState },
    });
  }

  protected override onFailure(
    error: Error,
    category: WebRtcFailureCategory | "signaling" | "timeout",
  ): void {
    this.onDiagnostic?.({
      event: "failure",
      lifecycle: this.lifecycle,
      ...(this.ownerDeviceId ? { deviceId: this.ownerDeviceId } : {}),
      ...(this.failureSessionId ?? this.sessionId
        ? { sessionId: this.failureSessionId ?? this.sessionId }
        : {}),
      ...(this.recoveryAttemptId ? { recoveryAttemptId: this.recoveryAttemptId } : {}),
      signalingState: this.getSignalingState(),
      sharingState: { ...this.sharingState },
      category,
      message: error.message,
      peer: this.peer?.diagnostic,
    });
    this.onTerminalError?.(error);
  }

  protected override onRecoveryCompleted(): void {
    if (this.iceRecoveryTimer !== undefined) this.clientScheduler.clearTimeout(this.iceRecoveryTimer);
    this.iceRecoveryTimer = undefined;
    this.clearRestartResponseTimer();
    this.restartOperationId += 1;
    this.iceRestartAttempts = 0;
    this.iceRestartInFlight = false;
    this.restartOfferGeneration = undefined;
    this.queuedRecoveryEvent = false;
    this.pendingIceRecovery = false;
    this.awaitingControlPlaneRecovery = false;
  }

  protected override onSocketClosed(code?: number): void {
    this.awaitingControlPlaneRecovery = Boolean(this.peer && this.sessionId);
    this.onRecoveryDiagnostic("signaling_disconnected");
    this.onDiagnostic?.({
      event: "signaling",
      lifecycle: this.lifecycle,
      ...(this.ownerDeviceId ? { deviceId: this.ownerDeviceId } : {}),
      signalingState: "closed",
      sharingState: { ...this.sharingState },
      category: "signaling",
      message: `Owner signaling socket closed (code ${code ?? "unknown"})`,
    });
  }

  protected override onServerMessage(message: ServerMessage): boolean {
    if (message.type !== "sharing_state_updated") return false;
    if (message.device_id !== this.ownerDeviceId) {
      this.fail(new Error("Sharing-state acknowledgement device did not match"), "signaling");
      return true;
    }

    this.confirmedSharingState = { screen: message.screen, camera: message.camera };
    this.onDiagnostic?.({
      event: "sharing-state",
      lifecycle: this.lifecycle,
      deviceId: message.device_id,
      signalingState: this.getSignalingState(),
      sharingState: this.confirmedSharingState,
      sent: true,
      message: "Backend confirmed sharing state",
    });
    this.onSharingStateConfirmed?.({
      deviceId: message.device_id,
      screen: message.screen,
      camera: message.camera,
    });
    if (
      this.peer &&
      this.sessionId &&
      message.session_id !== this.sessionId
    ) {
      this.pendingSharingResumed = false;
      this.closePeer();
      this.setLifecycle("IDLE");
    }
    return true;
  }

  protected override onSessionRecovery(
    message: Extract<ServerMessage, { type: "session_recovery" }>,
  ): void {
    if (
      message.session_id !== this.sessionId ||
      !this.peer ||
      !this.sharingState.screen ||
      !this.isSharingActive()
    ) {
      this.onRecoveryDiagnostic(
        "session_recovery_ignored",
        message.recovery_attempt_id,
        message.session_id,
      );
      return;
    }
    if (message.recovery_attempt_id) this.recoveryAttemptId = message.recovery_attempt_id;
    this.beginRecovery();
    this.onRecoveryDiagnostic(
      "session_recovery_received",
      message.recovery_attempt_id,
      message.session_id,
    );
    if (this.peer.state === "connected") {
      this.completeRecovery();
      if (this.signalingAuthenticated) this.setLifecycle("CONNECTED");
      return;
    }
    const newRecoveryEvent = message.recovery_attempt_id !== undefined
      ? message.recovery_attempt_id !== this.lastSessionRecoveryId
      : this.awaitingControlPlaneRecovery;
    if (newRecoveryEvent) {
      this.lastSessionRecoveryId = message.recovery_attempt_id;
      this.awaitingControlPlaneRecovery = false;
      if (
        this.iceRestartInFlight ||
        this.restartResponseTimer !== undefined ||
        this.restartOfferGeneration === this.peerGeneration ||
        this.peer.restartOfferPending
      ) {
        this.queuedRecoveryEvent = true;
        this.reportClientDiagnostic("recovery_attempt_queued", {
          reason: "distinct recovery event arrived while restart negotiation was active",
          messageType: "session_recovery",
        });
        return;
      }
      this.queuedRecoveryEvent = true;
      this.reportClientDiagnostic("recovery_attempt_queued", {
        reason: "distinct recovery event retained until signaling and peer are ready",
        messageType: "session_recovery",
      });
    } else {
      return;
    }
    this.drainPendingRecovery();
  }

  private getSignalingState(): DesktopDiagnostic["signalingState"] {
    if (!this.socket) return "not-connected";
    if (this.socket.readyState === 1) return "open";
    if (this.socket.readyState === 3) return "closed";
    return "connecting";
  }

  private async publishSharingState(): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) {
      this.reportSharingState(false, "Owner signaling socket is not open; state will be sent after authentication");
      return;
    }
    try {
      await this.sendAndWait({ type: "sharing_state", ...this.sharingState });
      this.reportSharingState(true, "Sharing state accepted by the main signaling transport");
    } catch (error) {
      this.reportSharingState(false, error instanceof Error ? error.message : "Sharing-state send failed");
      throw error;
    }
  }

  private reportSharingState(sent: boolean, message: string): void {
    this.onDiagnostic?.({
      event: "sharing-state",
      lifecycle: this.lifecycle,
      ...(this.ownerDeviceId ? { deviceId: this.ownerDeviceId } : {}),
      signalingState: this.getSignalingState(),
      sharingState: { ...this.sharingState },
      sent,
      message,
    });
  }

  protected override onSessionEnded(reason: string): void {
    if (
      reason === "viewer_grace_expired" ||
      reason === "authorization_revoked" ||
      reason === "recovery_timeout"
    ) {
      this.onOwnerSessionEnded?.(reason);
    }
  }

  protected override shouldPreservePeerOnSocketClose(): boolean {
    return Boolean(this.peer && this.sessionId && this.sharingState.screen && this.isSharingActive());
  }

  protected override async onAuthenticated(sourceSocket?: SignalingSocket): Promise<void> {
    const signalingReconnected = this.awaitingControlPlaneRecovery;
    await this.refreshPresence?.();
    if (this.terminal || this.closing || (sourceSocket && this.socket !== sourceSocket)) return;
    if (this.sharingState.screen && !this.isSharingActive()) {
      this.sharingState = { screen: false, camera: false };
      this.resume = undefined;
      this.resumeRequestId = undefined;
    }
    await this.publishSharingState();
    if (this.terminal || this.closing || (sourceSocket && this.socket !== sourceSocket)) return;
    if (this.resume && this.resume.expiresAt > this.clientScheduler.now()) {
      this.resumeRequestId ??= crypto.randomUUID();
      this.send({
        type: "resume_session",
        session_id: this.resume.sessionId,
        epoch: this.resume.epoch,
        capability: this.resume.capability,
        request_id: this.resumeRequestId,
      });
    } else {
      this.resume = undefined;
      this.resumeRequestId = undefined;
    }
    if (signalingReconnected) {
      this.onDiagnostic?.({
        event: "signaling_reconnected",
        lifecycle: this.lifecycle,
        ...(this.ownerDeviceId ? { deviceId: this.ownerDeviceId } : {}),
        ...(this.sessionId ? { sessionId: this.sessionId } : {}),
        ...(this.recoveryAttemptId ? { recoveryAttemptId: this.recoveryAttemptId } : {}),
        peerGeneration: this.peerGeneration,
        reason: "owner signaling socket reauthenticated",
        signalingState: this.getSignalingState(),
        sharingState: { ...this.sharingState },
      });
    }
  }

  protected override onSignalingAuthenticated(): void {
    if (this.peer?.state === "connected") {
      this.completeRecovery();
      return;
    }
    this.drainPendingRecovery();
  }

  private drainPendingRecovery(): void {
    if (
      !this.signalingAuthenticated ||
      !this.peer ||
      this.peer.state === "connected" ||
      this.iceRestartInFlight ||
      this.restartResponseTimer !== undefined ||
      this.restartOfferGeneration === this.peerGeneration ||
      this.peer.restartOfferPending
    ) return;
    if (this.queuedRecoveryEvent) {
      this.queuedRecoveryEvent = false;
      this.pendingIceRecovery = false;
      this.iceRestartAttempts = 0;
      if (this.iceRecoveryTimer !== undefined) this.clientScheduler.clearTimeout(this.iceRecoveryTimer);
      this.iceRecoveryTimer = undefined;
      this.scheduleIceRecovery(true, false, "new-recovery-event");
      return;
    }
    if (this.pendingIceRecovery) {
      this.pendingIceRecovery = false;
      this.scheduleIceRecovery(true, false, "peer-disconnected-during-signaling-loss");
    }
  }

  private iceRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private iceRestartAttempts = 0;
  private iceRestartInFlight = false;
  private restartOperationId = 0;

  private scheduleIceRecovery(
    immediate = false,
    abandonPending = false,
    reason = "peer-state-change",
  ): void {
    if (!this.peer || this.iceRecoveryTimer !== undefined || this.iceRestartInFlight) return;
    this.beginRecovery();
    if (this.socket?.readyState !== 1 || !this.signalingAuthenticated) {
      if (!this.pendingIceRecovery) {
        this.reportClientDiagnostic("recovery_attempt_queued", {
          reason: "signaling is not authenticated",
        });
      }
      this.pendingIceRecovery = true;
      return;
    }
    const peer = this.peer;
    const generation = this.peerGeneration;
    if (
      (peer.restartOfferPending || this.restartOfferGeneration === generation) &&
      !abandonPending
    ) return;
    if (this.peer.restartOfferPending) this.peer.markRestartOfferFailed();
    this.restartOfferGeneration = undefined;
    this.clearRestartResponseTimer();
    if (this.socket?.readyState !== 1 || !this.signalingAuthenticated) return;
    if (this.iceRestartAttempts >= 2) {
      return;
    }
    this.onDiagnostic?.({
      event: "ice_restart_retry_scheduled",
      lifecycle: this.lifecycle,
      ...(this.ownerDeviceId ? { deviceId: this.ownerDeviceId } : {}),
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(this.recoveryAttemptId ? { recoveryAttemptId: this.recoveryAttemptId } : {}),
      peerGeneration: generation,
      attempt: this.iceRestartAttempts + 1,
      reason,
      signalingState: this.getSignalingState(),
      sharingState: { ...this.sharingState },
    });
    const delay = immediate ? 0 : 8_000;
    this.iceRecoveryTimer = this.clientScheduler.setTimeout(() => {
      this.iceRecoveryTimer = undefined;
      if (
        this.peer !== peer ||
        this.peerGeneration !== generation ||
        this.terminal ||
        this.closing ||
        !this.signalingAuthenticated
      ) return;
      if (this.iceRestartInFlight || this.restartOfferGeneration === generation || peer.restartOfferPending) return;
      this.reportClientDiagnostic("recovery_attempt_started", {
        attempt: this.iceRestartAttempts + 1,
        reason,
      });
      this.iceRestartAttempts += 1;
      const operationId = ++this.restartOperationId;
      this.iceRestartInFlight = true;
      const refreshesIceConfiguration = Boolean(this.loadIceServers || this.loadManagedIceServers);
      this.onRecoveryDiagnostic(
        `ice_restart_started_${this.iceRestartAttempts}`,
        undefined,
        undefined,
        reason,
      );
      if (refreshesIceConfiguration) {
        this.onDiagnostic?.({
          event: "ice_configuration_refresh_started",
          timestamp: new Date().toISOString(),
          lifecycle: this.lifecycle,
          ...(this.ownerDeviceId ? { deviceId: this.ownerDeviceId } : {}),
          ...(this.sessionId ? { sessionId: this.sessionId } : {}),
          ...(this.recoveryAttemptId ? { recoveryAttemptId: this.recoveryAttemptId } : {}),
          peerGeneration: generation,
          attempt: this.iceRestartAttempts,
          reason,
        });
      }
      void this.refreshIceConfiguration(peer).then(() => {
        if (
          this.peer !== peer ||
          this.peerGeneration !== generation ||
          this.restartOperationId !== operationId ||
          this.terminal ||
          this.closing
        ) return false;
        if (refreshesIceConfiguration) {
          this.onDiagnostic?.({
            event: "ice_configuration_refresh_completed",
            timestamp: new Date().toISOString(),
            lifecycle: this.lifecycle,
            ...(this.ownerDeviceId ? { deviceId: this.ownerDeviceId } : {}),
            ...(this.sessionId ? { sessionId: this.sessionId } : {}),
            ...(this.recoveryAttemptId ? { recoveryAttemptId: this.recoveryAttemptId } : {}),
            peerGeneration: generation,
            attempt: this.iceRestartAttempts,
          });
        }
        if (this.socket?.readyState !== 1 || !this.signalingAuthenticated) {
          this.iceRestartInFlight = false;
          this.pendingIceRecovery = true;
          return false;
        }
        return peer.createOffer({ iceRestart: true }).then(() => true);
      }).then((offerCreated) => {
        if (
          !offerCreated ||
          this.peer !== peer ||
          this.peerGeneration !== generation ||
          this.restartOperationId !== operationId ||
          this.terminal ||
          this.closing
        ) return;
        this.iceRestartInFlight = false;
        this.restartOfferGeneration = generation;
        this.restartResponseTimer = this.clientScheduler.setTimeout(() => {
          this.restartResponseTimer = undefined;
          if (
            this.peer !== peer ||
            this.peerGeneration !== generation ||
            this.restartOperationId !== operationId ||
            this.terminal ||
            this.closing
          ) return;
          this.restartOperationId += 1;
          peer.markRestartOfferFailed();
          this.restartOfferGeneration = undefined;
          this.onRecoveryDiagnostic(
            `ice_restart_failed_${this.iceRestartAttempts}`,
            undefined,
            undefined,
            "restart answer timed out",
          );
          if (this.iceRestartAttempts < 2) {
            this.scheduleIceRecovery(true, true, "restart-answer-timeout");
          } else {
            this.drainPendingRecovery();
          }
        }, 8_000);
      }).catch(() => {
        if (
          this.peer !== peer ||
          this.peerGeneration !== generation ||
          this.restartOperationId !== operationId ||
          this.terminal ||
          this.closing
        ) return;
        this.iceRestartInFlight = false;
        this.onRecoveryDiagnostic(
          `ice_restart_failed_${this.iceRestartAttempts}`,
          undefined,
          undefined,
          "restart offer or ICE configuration failed",
        );
        if (this.socket?.readyState !== 1 || !this.signalingAuthenticated) return;
        if (this.iceRestartAttempts < 2) {
          this.scheduleIceRecovery(true, false, "restart-offer-failed");
        } else {
          this.drainPendingRecovery();
        }
      });
    }, delay);
  }

  private async refreshIceConfiguration(peer: WebRtcPeer): Promise<void> {
    try {
      if (!this.loadIceServers && !this.loadManagedIceServers) return;
      const credential = (await this.loadRefreshCredential?.()) ?? undefined;
      if (!this.managedAuthentication && !credential) throw new Error("device credential unavailable");
      const configuration = credential
        ? await this.loadIceServers?.(credential)
        : await this.loadManagedIceServers?.();
      if (!configuration) throw new Error("ICE configuration unavailable");
      if (this.peer !== peer || this.terminal || this.closing) return;
      peer.setConfiguration(configuration);
      this.iceConfiguration = configuration;
    } catch (error) {
      this.onDiagnostic?.({
        event: "ice_configuration_refresh_failed",
        timestamp: new Date().toISOString(),
        lifecycle: this.lifecycle,
        ...(this.ownerDeviceId ? { deviceId: this.ownerDeviceId } : {}),
        ...(this.sessionId ? { sessionId: this.sessionId } : {}),
        ...(this.recoveryAttemptId ? { recoveryAttemptId: this.recoveryAttemptId } : {}),
        peerGeneration: this.peerGeneration,
        attempt: this.iceRestartAttempts,
        reason: "ICE configuration refresh failed",
      });
      throw error;
    }
  }

  private clearRestartResponseTimer(): void {
    if (this.restartResponseTimer !== undefined) this.clientScheduler.clearTimeout(this.restartResponseTimer);
    this.restartResponseTimer = undefined;
  }

  protected override onAnswerApplied(): void {
    this.clearRestartResponseTimer();
    this.restartOfferGeneration = undefined;
    if (this.peer?.state !== "connected") this.drainPendingRecovery();
  }

  protected override closePeer(): void {
    if (this.iceRecoveryTimer !== undefined) this.clientScheduler.clearTimeout(this.iceRecoveryTimer);
    this.iceRecoveryTimer = undefined;
    this.clearRestartResponseTimer();
    this.iceRestartAttempts = 0;
    this.iceRestartInFlight = false;
    this.restartOperationId += 1;
    this.restartOfferGeneration = undefined;
    this.lastSessionRecoveryId = undefined;
    this.queuedRecoveryEvent = false;
    this.pendingIceRecovery = false;
    this.awaitingControlPlaneRecovery = false;
    super.closePeer();
  }

  override close(): void {
    super.close();
  }

  async start(reconnecting = false): Promise<void> {
    if (this.startInFlight) return this.startInFlight;
    this.startInFlight = this.startInternal(reconnecting);
    try {
      await this.startInFlight;
    } finally {
      this.startInFlight = undefined;
    }
  }

  private async startInternal(reconnecting: boolean): Promise<void> {
    if (!reconnecting) this.closing = false;
    if (this.socket) return;
    const credential = this.managedAuthentication
      ? undefined
      : (await this.loadRefreshCredential?.()) ?? undefined;
    if (this.closing || this.terminal) return;
    if (!this.managedAuthentication && !credential) {
      this.markTerminal();
      this.setLifecycle("FAILED");
      throw new Error("device credential unavailable");
    }
    if (!this.managedAuthentication) {
      this.iceConfiguration = credential
        ? await this.loadIceServers?.(credential)
        : await this.loadManagedIceServers?.();
    }
    if (this.closing || this.terminal) return;
    this.connect(credential, async (message, socket) => {
      if (message.type === "viewer_rejoined") {
        if (this.sessionId && message.session_id !== this.sessionId) {
          this.fail(new Error("Rejoined viewer session did not match the active session"), "signaling");
          return;
        }
        if (!this.isSharingActive()) return;
        this.closePeer();
        this.setLifecycle("NEGOTIATING");
        const peer = this.createPeer(
          "owner",
          message.session_id,
          this.iceConfiguration,
          INITIAL_NEGOTIATION_TIMEOUT_MS,
          crypto.randomUUID(),
        );
        const generation = this.peerGeneration;
        void Promise.resolve(this.prepareOwnerPeer?.(peer)).then(() => {
          if (this.peer !== peer || this.peerGeneration !== generation || this.terminal || this.closing) return;
          if (!this.isSharingActive()) {
            this.closePeer();
            return;
          }
          return peer.createOffer();
        }).catch(() => {
          if (this.peer === peer && this.peerGeneration === generation && !this.terminal && !this.closing) {
            this.fail();
          }
        });
        return;
      }
      if (message.type === "viewer_joined") {
        if (!this.isSharingActive()) {
          try { this.send({ type: "leave_session", session_id: message.session_id }); } catch { /* socket closing */ }
          return;
        }
        if (this.peer || this.sessionId) return this.fail();
        if (this.managedAuthentication) {
          try {
            this.iceConfiguration = await this.loadManagedIceServers?.();
          } catch {
            if (this.socket === socket && !this.terminal && !this.closing) this.fail();
            return;
          }
          if (this.socket !== socket || this.terminal || this.closing || !this.isSharingActive()) return;
        }
        this.setLifecycle("NEGOTIATING");
        const peer = this.createPeer(
          "owner",
          message.session_id,
          this.iceConfiguration,
          INITIAL_NEGOTIATION_TIMEOUT_MS,
          crypto.randomUUID(),
        );
        const generation = this.peerGeneration;
        void Promise.resolve(this.prepareOwnerPeer?.(peer)).then(() => {
          if (this.peer !== peer || this.peerGeneration !== generation || this.terminal || this.closing) return;
          if (!this.isSharingActive()) {
            this.closePeer();
            return;
          }
          return peer.createOffer();
        }).catch(() => {
          if (this.peer === peer && this.peerGeneration === generation && !this.terminal && !this.closing) this.fail();
        });
      }
      await this.handleMessage(message, socket);
    });
  }

  setSharingState(screen: boolean, camera: boolean): Promise<void> {
    if (camera && !screen) throw new Error("camera sharing requires an active screen track");
    this.sharingState = { screen, camera };
    if (!screen) {
      this.resume = undefined;
      this.resumeRequestId = undefined;
    }
    return this.publishSharingState();
  }

  stopSharingSession(): Promise<void> {
    let update = Promise.resolve();
    try {
      update = this.setSharingState(false, false);
    } finally {
      this.pendingSharingResumed = false;
      this.closePeer();
      if (!this.terminal && !this.closing) {
        this.setLifecycle(this.socket?.readyState === 1 ? "IDLE" : "CLOSED");
      }
    }
    return update;
  }

  async replaceOwnerTrack(kind: "screen" | "camera", track: WebRtcTrack | null): Promise<void> {
    if (track?.readyState === "ended") throw new Error("cannot attach an ended track");
    const peer = this.peer;
    if (!peer) return;
    const generation = this.peerGeneration;
    await peer.replaceTrack(kind, track);
    if (this.peer !== peer || this.peerGeneration !== generation || this.terminal || this.closing) return;
  }

  prepareForSleep(): Promise<void> {
    if (!this.sessionId || !this.sharingState.screen || this.socket?.readyState !== 1) {
      return Promise.reject(new Error("no active sharing session to preserve"));
    }
    if (this.sleepMarkerRequest) return Promise.reject(new Error("sleep marker is already pending"));
    const requestId = crypto.randomUUID();
    return new Promise<void>((resolve, reject) => {
      this.sleepMarkerRequest = { requestId, resolve, reject };
      this.send({ type: "prepare_sleep", session_id: this.sessionId!, request_id: requestId });
      this.clientScheduler.setTimeout(() => {
        if (this.sleepMarkerRequest?.requestId !== requestId) return;
        this.sleepMarkerRequest = undefined;
        reject(new Error("sleep continuity marker was not acknowledged"));
      }, 2_000);
    });
  }

  protected override onSleepMarked(message: Extract<ServerMessage, { type: "sleep_marked" }>): void {
    if (this.sleepMarkerRequest?.requestId !== message.request_id) return;
    this.resume = {
      sessionId: message.session_id,
      epoch: message.epoch,
      capability: message.capability,
      expiresAt: message.expires_at,
    };
    this.resumeRequestId = undefined;
    this.sleepMarkerRequest.resolve();
    this.sleepMarkerRequest = undefined;
  }

  protected override onResumePending(message: Extract<ServerMessage, { type: "resume_pending" }>): void {
    if (this.resume?.sessionId !== message.session_id || this.resume.epoch !== message.epoch) return;
    this.resume.capability = message.capability;
    this.resume.expiresAt = message.expires_at;
    this.resumeRequestId = undefined;
  }

  protected override onSessionResumed(message: Extract<ServerMessage, { type: "session_resumed" }>): void {
    this.pendingSharingResumed = true;
    if (this.resume?.sessionId === message.session_id && this.resume.epoch === message.epoch) {
      this.resume = undefined;
      this.resumeRequestId = undefined;
    }
    if (!this.sharingState.screen || (this.peer && this.sessionId === message.session_id)) return;
    if (this.peer || this.sessionId) this.closePeer();
    this.setLifecycle("NEGOTIATING");
    const peer = this.createPeer(
      "owner",
      message.session_id,
      this.iceConfiguration,
      INITIAL_NEGOTIATION_TIMEOUT_MS,
      crypto.randomUUID(),
    );
    const generation = this.peerGeneration;
    void Promise.resolve(this.prepareOwnerPeer?.(peer)).then(() => {
      if (this.peer !== peer || this.peerGeneration !== generation || this.terminal || this.closing || !this.sharingState.screen) return;
      return peer.createOffer();
    }).catch(() => {
      if (this.peer === peer && this.peerGeneration === generation && !this.terminal && !this.closing) this.fail();
    });
  }

  resumeAfterWake(): void {
    if (!this.resume || this.resume.expiresAt <= this.clientScheduler.now() || this.socket?.readyState !== 1) return;
    this.resumeRequestId ??= crypto.randomUUID();
    this.send({
      type: "resume_session",
      session_id: this.resume.sessionId,
      epoch: this.resume.epoch,
      capability: this.resume.capability,
      request_id: this.resumeRequestId,
    });
  }

  decideShareRequest(requestId: string, decision: "allow" | "deny"): void {
    this.sendSessionMessage({
      type: "share_request_decision",
      session_id: this.sessionId!,
      request_id: requestId,
      decision,
    });
  }
}

export type ViewerClientOptions = {
  socketFactory: SignalingSocketFactory;
  peerFactory: WebRtcFactory;
  browserSessionToken?: string;
  managedAuthentication?: boolean;
  deviceId: string;
  loadIceServers?: () => Promise<WebRtcConfiguration>;
  reconnect?: ReconnectOptions;
  refreshPresence?: () => Promise<void>;
  onDiagnostic?: (
    diagnostic: WebRtcDiagnostic | RecoveryDiagnostic | ClientSignalingDiagnostic
  ) => void;
  onTerminalError?: (error: Error) => void;
  onSessionEnded?: (reason: string) => void;
  onSharingState?: (state: { screen: boolean; camera: boolean }) => void;
  onDeviceAvailability?: (online: boolean) => void;
};

export class ViewerWebRtcClient extends WebRtcClient {
  private readonly browserSessionToken: string;
  private readonly managedAuthentication: boolean;
  private readonly deviceId: string;
  private readonly loadIceServers?: () => Promise<WebRtcConfiguration>;
  private readonly refreshPresence?: () => Promise<void>;
  private readonly onDiagnostic?: (
    diagnostic: WebRtcDiagnostic | RecoveryDiagnostic | ClientSignalingDiagnostic
  ) => void;
  private readonly onTerminalError?: (error: Error) => void;
  private readonly onViewerSessionEnded?: (reason: string) => void;
  private readonly onSharingState?: (state: { screen: boolean; camera: boolean }) => void;
  private readonly onDeviceAvailability?: (online: boolean) => void;
  private iceConfiguration: WebRtcConfiguration | undefined;
  private reconnecting = false;
  private hasEstablishedSession = false;
  private authorizationRetryCount = 0;
  private readonly retiredSessionIds = new Set<string>();
  private readonly retiredNegotiationIds = new Set<string>();
  private sharingActive: boolean | undefined;
  private sessionRequestPending = false;
  private peerEverConnected = false;
  private resume: { sessionId: string; epoch: number; capability: string; expiresAt: number } | undefined;
  private resumeRequestId: string | undefined;
  private resumeRequestPending = false;
  private ownerRecoverySessionId: string | undefined;
  private ownerRecoveryTimer: ReturnType<typeof setTimeout> | undefined;

  public constructor(options: ViewerClientOptions) {
    super(options.socketFactory, options.peerFactory, options.reconnect);
    this.browserSessionToken = options.browserSessionToken ?? "";
    this.managedAuthentication = options.managedAuthentication ?? false;
    this.deviceId = options.deviceId;
    this.loadIceServers = options.loadIceServers;
    this.refreshPresence = options.refreshPresence;
    this.onDiagnostic = options.onDiagnostic;
    this.onTerminalError = options.onTerminalError;
    this.onViewerSessionEnded = options.onSessionEnded;
    this.onSharingState = options.onSharingState;
    this.onDeviceAvailability = options.onDeviceAvailability;
  }

  protected override replacePeerForNegotiation(
    message: Extract<ServerMessage, { type: "offer" }>,
  ): boolean {
    if (this.retiredNegotiationIds.has(message.negotiation_id) || !this.sessionId) return false;
    const previousNegotiationId = this.peer?.negotiationId;
    const queuedCandidates = this.pendingIceCandidatesByNegotiation.get(message.negotiation_id);
    if (previousNegotiationId) this.retireNegotiation(previousNegotiationId);
    this.closePeer();
    if (queuedCandidates) {
      this.pendingIceCandidatesByNegotiation.set(message.negotiation_id, queuedCandidates);
    }
    this.peerEverConnected = false;
    this.setLifecycle("NEGOTIATING");
    this.createPeer("viewer", message.session_id, this.iceConfiguration);
    return true;
  }

  protected override shouldBufferCandidateForNegotiation(negotiationId: string): boolean {
    return !this.retiredNegotiationIds.has(negotiationId);
  }

  private retireNegotiation(negotiationId: string): void {
    this.retiredNegotiationIds.add(negotiationId);
  }

  start(reconnecting = false): void {
    if (!reconnecting) this.closing = false;
    if (this.socket) return;
    this.reconnecting = reconnecting;
    this.sessionRequestPending = false;
    if (!this.managedAuthentication && !this.browserSessionToken) {
      this.markTerminal();
      this.setLifecycle("FAILED");
      return;
    }
    this.connect(this.managedAuthentication ? undefined : this.browserSessionToken, (message, socket) => {
      if (
        (message.type === "offer" || message.type === "answer" || message.type === "ice_candidate") &&
        this.retiredSessionIds.has(message.session_id)
      ) {
        this.onRecoveryDiagnostic("stale_session_signaling_ignored", undefined, message.session_id);
        return;
      }
      if (message.type === "session_created" || message.type === "session_attached") {
        this.sessionRequestPending = false;
        if (message.device_id !== this.deviceId) {
          this.fail(new Error("Attached session device did not match the requested device"), "signaling");
          return;
        }
        if (message.type === "session_attached") {
          this.sharingActive = message.screen;
          this.onSharingState?.({ screen: message.screen, camera: message.camera });
          if (!message.screen) {
            this.fail(new Error("Attached session is not actively sharing its screen"), "signaling");
            return;
          }
        }
        if (this.sharingActive === false) return;
        if (this.peer || this.sessionId) {
          if (
            message.session_id === this.sessionId
          ) {
            if (message.type === "session_created") return this.fail();
            this.reconnecting = false;
            this.sessionRequestPending = false;
            return this.handleMessage(message, socket);
          }
          if (!this.reconnecting || !this.sessionId) return this.fail();
          this.retireSession(this.sessionId);
          this.closePeer();
          this.peerEverConnected = false;
        }
        this.reconnecting = false;
        this.hasEstablishedSession = true;
        this.peerEverConnected = false;
        this.authorizationRetryCount = 0;
        const ownerRecoveryRemainingMs =
          message.type === "session_attached" ? message.owner_recovery_remaining_ms : undefined;
        const ownerRecoveryPending = ownerRecoveryRemainingMs !== undefined;
        if (this.sessionId !== message.session_id) this.retiredNegotiationIds.clear();
        this.setLifecycle(ownerRecoveryPending ? "RECONNECTING" : "NEGOTIATING");
        const peer = this.createPeer(
          "viewer",
          message.session_id,
          this.iceConfiguration,
          ownerRecoveryPending ? null : INITIAL_NEGOTIATION_TIMEOUT_MS,
        );
        if (ownerRecoveryPending) {
          this.ownerRecoverySessionId = message.session_id;
          this.ownerRecoveryTimer = this.clientScheduler.setTimeout(() => {
            this.ownerRecoveryTimer = undefined;
            if (this.ownerRecoverySessionId !== message.session_id) return;
            this.retireTimedOutSession();
          }, ownerRecoveryRemainingMs);
        }
      }
      return this.handleMessage(message, socket);
    });
  }

  protected override async onAuthenticated(sourceSocket?: SignalingSocket): Promise<void> {
    await this.refreshPresence?.();
    if (this.terminal || this.closing || (sourceSocket && this.socket !== sourceSocket)) return;
    this.iceConfiguration = await this.loadIceServers?.();
    if (this.terminal || this.closing || (sourceSocket && this.socket !== sourceSocket)) return;
    if (this.resume) {
      if (this.resume.expiresAt <= this.clientScheduler.now()) {
        this.fail(new Error("Saved sleep-resume capability has expired"), "timeout");
        return;
      }
      this.requestSessionResume();
      return;
    }
    if (this.reconnecting && this.peer && this.sessionId && this.sharingActive !== false) {
      this.requestSession(true);
      return;
    }
    this.requestSession();
  }

  private requestSessionResume(): void {
    if (
      this.closing || this.terminal || !this.resume ||
      this.resume.expiresAt <= this.clientScheduler.now() ||
      this.resumeRequestPending || this.socket?.readyState !== 1
    ) return;
    this.resumeRequestId ??= crypto.randomUUID();
    this.resumeRequestPending = true;
    try {
      this.send({
        type: "resume_session",
        session_id: this.resume.sessionId,
        epoch: this.resume.epoch,
        capability: this.resume.capability,
        request_id: this.resumeRequestId,
      });
    } catch (error) {
      this.resumeRequestPending = false;
      this.fail(error, "signaling");
    }
  }

  private requestSession(recovering = false): void {
    if (
      this.closing || this.terminal || this.sessionRequestPending ||
      ((!recovering) && (this.peer || this.sessionId)) || this.socket?.readyState !== 1 ||
      (this.resume && this.resume.expiresAt > this.clientScheduler.now())
    ) return;
    this.sessionRequestPending = true;
    if (this.sharingActive !== false) {
      this.setLifecycle(this.peer && this.sessionId ? "RECONNECTING" : "CONNECTING");
    }
    try {
      this.send({
        type: "create_session",
        device_id: this.deviceId,
        ...(recovering && this.sessionId ? { active_session_id: this.sessionId } : {}),
      });
    } catch (error) {
      this.sessionRequestPending = false;
      this.fail(error, "signaling");
    }
  }

  private retireSession(sessionId: string): void {
    this.retiredSessionIds.add(sessionId);
    if (this.retiredSessionIds.size > 8) {
      const oldest = this.retiredSessionIds.values().next().value as string | undefined;
      if (oldest) this.retiredSessionIds.delete(oldest);
    }
  }

  private retireCurrentSession(): void {
    if (this.sessionId) this.retireSession(this.sessionId);
    if (this.peer?.negotiationId) this.retireNegotiation(this.peer.negotiationId);
  }

  private retireTimedOutSession(): void {
    this.retireCurrentSession();
    this.clearOwnerRecoveryWait();
    this.sessionRequestPending = false;
    this.peerEverConnected = false;
    this.reconnecting = false;
    this.recoveryAttemptId = undefined;
    this.sharingActive = false;
    this.onDeviceAvailability?.(false);
    this.onSharingState?.({ screen: false, camera: false });
    this.onViewerSessionEnded?.("recovery_timeout");
    this.closePeer();
    this.setLifecycle("RECONNECTING");
  }

  protected override onRecoveryTimeout(_error: Error): void {
    this.retireTimedOutSession();
  }

  protected override onServerMessage(message: ServerMessage): boolean {
    if (message.type === "session_recovery") {
      this.sessionRequestPending = false;
      if (message.session_id === this.sessionId && this.peer) {
        const awaitingOwner = this.ownerRecoverySessionId === message.session_id;
        if (awaitingOwner) {
          this.ownerRecoverySessionId = undefined;
          if (this.ownerRecoveryTimer !== undefined) {
            this.clientScheduler.clearTimeout(this.ownerRecoveryTimer);
            this.ownerRecoveryTimer = undefined;
          }
          this.startInitialNegotiationTimeout(this.peer);
          this.setLifecycle("NEGOTIATING");
        }
        if (message.recovery_attempt_id) this.recoveryAttemptId = message.recovery_attempt_id;
        this.onRecoveryDiagnostic(
          "session_recovery_received",
          message.recovery_attempt_id,
          message.session_id,
        );
        this.reconnecting = false;
        if (this.peer.state === "connected") {
          this.completeRecovery();
          this.setLifecycle("CONNECTED");
        } else if (!awaitingOwner) {
          this.beginRecovery();
        }
      } else {
        this.onRecoveryDiagnostic(
          "session_recovery_ignored",
          message.recovery_attempt_id,
          message.session_id,
        );
      }
      return true;
    }
    if (message.type !== "device_sharing_state") return false;
    if (message.device_id !== this.deviceId) return true;
    this.onDeviceAvailability?.(true);
    this.sharingActive = message.screen;
    this.onSharingState?.({ screen: message.screen, camera: message.camera });
    if (!message.screen) {
      this.sessionRequestPending = false;
      this.peerEverConnected = false;
      if (this.peer || this.sessionId) {
        this.retireCurrentSession();
        this.closePeer();
        this.setLifecycle("CLOSED");
        this.onViewerSessionEnded?.("sharing_stopped");
      } else if (!this.terminal && !this.closing) {
        this.setLifecycle("CLOSED");
      }
      this.scheduleReconnect(() => this.requestSession());
      return true;
    }
    this.cancelReconnect();
    if (!this.sessionRequestPending && !this.peer && !this.sessionId) {
      this.requestSession();
    }
    return true;
  }

  protected override onSleepMarked(message: Extract<ServerMessage, { type: "sleep_marked" }>): void {
    this.resume = {
      sessionId: message.session_id,
      epoch: message.epoch,
      capability: message.capability,
      expiresAt: message.expires_at,
    };
    this.resumeRequestId = undefined;
  }

  protected override onResumePending(message: Extract<ServerMessage, { type: "resume_pending" }>): void {
    if (this.resume?.sessionId !== message.session_id || this.resume.epoch !== message.epoch) return;
    this.resume.capability = message.capability;
    this.resume.expiresAt = message.expires_at;
    this.resumeRequestId = undefined;
    this.resumeRequestPending = false;
  }

  protected override onSessionResumed(message: Extract<ServerMessage, { type: "session_resumed" }>): void {
    if (this.resume?.sessionId === message.session_id && this.resume.epoch === message.epoch) {
      this.resume = undefined;
      this.resumeRequestId = undefined;
    }
    this.resumeRequestPending = false;
    if (this.peer && this.sessionId === message.session_id) return;
    if (this.peer || this.sessionId) this.closePeer();
    this.reconnecting = false;
    this.setLifecycle("NEGOTIATING");
    this.peerEverConnected = false;
    this.createPeer("viewer", message.session_id, this.iceConfiguration);
  }

  protected override shouldPreservePeerOnSocketClose(): boolean {
    return Boolean(this.peer && this.sessionId && this.peerEverConnected);
  }

  protected override onPeerState(state: PeerState): void {
    if (this.ownerRecoverySessionId !== undefined && this.ownerRecoverySessionId === this.sessionId) {
      if (state === "connected") {
        this.ownerRecoverySessionId = undefined;
        if (this.ownerRecoveryTimer !== undefined) {
          this.clientScheduler.clearTimeout(this.ownerRecoveryTimer);
          this.ownerRecoveryTimer = undefined;
        }
        super.onPeerState(state);
      } else {
        this.setLifecycle("RECONNECTING");
      }
      return;
    }
    if (state === "connected") {
      this.peerEverConnected = true;
      this.completeRecovery();
      super.onPeerState(state);
      return;
    }
    if ((state === "disconnected" || state === "failed") && this.peerEverConnected) {
      this.beginRecovery();
      return;
    }
    super.onPeerState(state);
  }

  resumeAfterWake(): void {
    if (!this.resume) return;
    if (this.resume.expiresAt <= this.clientScheduler.now()) {
      this.fail(new Error("Saved sleep-resume capability has expired"), "timeout");
      return;
    }
    this.requestSessionResume();
  }

  protected override onControlPlaneClosed(): void {
    this.scheduleReconnect(() => this.start(true));
  }

  protected override onPeerDiagnostic(diagnostic: WebRtcDiagnostic): void {
    this.onDiagnostic?.(diagnostic);
  }

  protected override onClientDiagnostic(diagnostic: ClientSignalingDiagnostic): void {
    this.onDiagnostic?.({
      ...diagnostic,
      ...(this.deviceId ? { deviceId: this.deviceId } : {}),
    });
  }

  protected override onRecoveryDiagnostic(
    phase: string,
    recoveryAttemptId?: string,
    sessionId?: string,
  ): void {
    this.onDiagnostic?.({
      event: "recovery",
      phase,
      timestamp: new Date().toISOString(),
      recoveryAttemptId: recoveryAttemptId ?? this.recoveryAttemptId ?? crypto.randomUUID(),
      ...(sessionId ?? this.sessionId ? { sessionId: sessionId ?? this.sessionId } : {}),
      peerGeneration: this.peerGeneration,
      negotiationId: this.peer?.negotiationId,
      socketConnectionGeneration: this.socketConnectionGeneration,
      signalingState: this.socket?.readyState === 1
        ? "open"
        : this.socket?.readyState === 3 ? "closed" : "connecting",
      peer: this.peer?.diagnostic,
    });
  }

  protected override onFailure(error: Error): void {
    this.clearOwnerRecoveryWait();
    this.onTerminalError?.(error);
  }

  private clearOwnerRecoveryWait(): void {
    this.ownerRecoverySessionId = undefined;
    if (this.ownerRecoveryTimer !== undefined) {
      this.clientScheduler.clearTimeout(this.ownerRecoveryTimer);
      this.ownerRecoveryTimer = undefined;
    }
  }

  protected override onServerError(code: string): boolean {
    this.sessionRequestPending = false;
    if (code === "DEVICE_OFFLINE") {
      this.onDeviceAvailability?.(false);
      this.setLifecycle("RECONNECTING");
      this.scheduleReconnect(() => this.requestSession());
      return true;
    }
    if (
      (this.reconnecting || this.hasEstablishedSession) &&
      code === "NOT_AUTHORIZED" &&
      this.authorizationRetryCount < 1
    ) {
      this.authorizationRetryCount += 1;
      this.socket?.close();
      return true;
    }
    return false;
  }

  protected override onSessionEnded(reason: string): void {
    this.sessionRequestPending = false;
    this.clearOwnerRecoveryWait();
    if (reason === "recovery_timeout") {
      this.retireTimedOutSession();
      return;
    }
    this.onViewerSessionEnded?.(reason);
    if (reason === "sharing_stopped") {
      this.sharingActive = false;
      this.peerEverConnected = false;
      this.cancelReconnect();
      return;
    }
    if (reason === "authorization_revoked" || reason === "closed") {
      this.markTerminal();
      return;
    }
    this.scheduleReconnect(() => {
      this.requestSession();
    });
  }

  protected override onSocketClosed(code?: number): void {
    super.onSocketClosed(code);
    this.onDeviceAvailability?.(false);
    if (!this.terminal && !this.closing) this.setLifecycle("RECONNECTING");
    this.onRecoveryDiagnostic("signaling_disconnected");
    this.sessionRequestPending = false;
    this.resumeRequestPending = false;
  }

  override close(): void {
    this.clearOwnerRecoveryWait();
    super.close();
  }

  requestShare(requestId: string, kind: "screen" | "camera"): void {
    this.sendSessionMessage({
      type: "share_request",
      session_id: this.sessionId!,
      request_id: requestId,
      kind,
    });
  }

  cancelShareRequest(requestId: string): void {
    this.sendSessionMessage({
      type: "share_request_cancel",
      session_id: this.sessionId!,
      request_id: requestId,
    });
  }
}

export type { TrackMap };
