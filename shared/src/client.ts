import {
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
  type TrackMap,
} from "./protocol.js";
import {
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

export type DesktopDiagnostic = {
  event: "lifecycle" | "peer" | "failure" | "sharing-state" | "signaling" | "recovery";
  lifecycle: ClientLifecycleState;
  deviceId?: string;
  sessionId?: string;
  recoveryAttemptId?: string;
  recoveryPhase?: string;
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
  recoveryAttemptId: string;
  sessionId?: string;
  signalingState?: "connecting" | "open" | "closed" | "not-connected";
  peer?: WebRtcDiagnostic;
};

export interface SignalingSocket {
  readyState: number;
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
  protected recoveryAttemptId: string | undefined;
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
    this.lifecycleValue = value;
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
      }
      else this.fail(new Error("Received malformed signaling message"), "signaling");
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
  ): WebRtcPeer {
    this.closePeer();
    const peer = new WebRtcPeer(role, sessionId, () => this.peerFactory(configuration), (message) => this.send(message));
    peer.setStateListener((state) => this.onPeerState(state));
    peer.setDiagnosticListener((diagnostic) => this.onPeerDiagnostic(diagnostic));
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
      this.onSessionRecovery(message);
    } else if (message.type === "offer" || message.type === "answer" || message.type === "ice_candidate") {
      if (message.session_id !== this.sessionId || !this.peer) {
        this.fail(new Error("Signaling message did not match the active session"), "signaling");
        return;
      }
      if (message.type === "offer") {
        if (!message.track_map) {
          return this.fail(new Error("Signaling offer is missing its track map"), "signaling");
        }
        await this.peer.acceptOffer(message.sdp, message.track_map);
      } else if (message.type === "answer") {
        await this.peer.acceptAnswer(message.sdp);
        this.onAnswerApplied();
      } else if (message.type === "ice_candidate") {
        await this.peer.addIceCandidate(message.candidate);
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
      if (!this.closing && !this.terminal) callback();
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
      this.fail(
        new Error(`network recovery timed out after ${this.reconnectOptions.recoveryTimeoutMs / 1000} seconds`),
        "timeout",
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
  }

  protected onRecoveryDiagnostic(
    _phase: string,
    _recoveryAttemptId?: string,
    _sessionId?: string,
  ): void {}

  private clearRecoveryTimer(): void {
    if (this.recoveryTimer !== undefined) this.clientScheduler.clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
  }

  protected closePeer(): void {
    this.peerGeneration += 1;
    this.clearInitialNegotiationTimer();
    this.clearRecoveryTimer();
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
      this.iceRestartAttempts = 0;
      this.iceRestartInFlight = false;
      this.completeRecovery();
      if (this.iceRecoveryTimer !== undefined) this.clientScheduler.clearTimeout(this.iceRecoveryTimer);
      this.iceRecoveryTimer = undefined;
      this.clearRestartResponseTimer();
      super.onPeerState(state);
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
      lifecycle,
      ...(this.ownerDeviceId ? { deviceId: this.ownerDeviceId } : {}),
      ...(this.failureSessionId ?? this.sessionId
        ? { sessionId: this.failureSessionId ?? this.sessionId }
        : {}),
      signalingState: this.getSignalingState(),
      sharingState: { ...this.sharingState },
    });
  }

  protected override onRecoveryDiagnostic(
    recoveryPhase: string,
    recoveryAttemptId?: string,
    sessionId?: string,
  ): void {
    this.onDiagnostic?.({
      event: "recovery",
      recoveryPhase,
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
      event: "peer",
      lifecycle: this.lifecycle,
      ...(this.ownerDeviceId ? { deviceId: this.ownerDeviceId } : {}),
      sessionId: peer.sessionId,
      peer,
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
    if (this.awaitingControlPlaneRecovery) {
      this.awaitingControlPlaneRecovery = false;
      this.iceRestartAttempts = 0;
    }
    if (this.iceRecoveryTimer !== undefined) this.clientScheduler.clearTimeout(this.iceRecoveryTimer);
    this.iceRecoveryTimer = undefined;
    this.scheduleIceRecovery(true);
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
  }

  private iceRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private iceRestartAttempts = 0;
  private iceRestartInFlight = false;

  private scheduleIceRecovery(immediate = false, abandonPending = false): void {
    if (!this.peer || this.iceRecoveryTimer !== undefined || this.iceRestartInFlight) return;
    this.beginRecovery();
    if (this.peer.restartOfferPending && !abandonPending) return;
    if (this.peer.restartOfferPending) this.peer.markRestartOfferFailed();
    this.clearRestartResponseTimer();
    if (this.socket?.readyState !== 1) return;
    if (this.iceRestartAttempts >= 2) {
      return;
    }
    const delay = immediate ? 0 : 8_000;
    this.iceRecoveryTimer = this.clientScheduler.setTimeout(() => {
      this.iceRecoveryTimer = undefined;
      const peer = this.peer;
      if (!peer || this.terminal || this.closing) return;
      this.iceRestartAttempts += 1;
      this.iceRestartInFlight = true;
      this.onRecoveryDiagnostic(`ice_restart_started_${this.iceRestartAttempts}`);
      void this.refreshIceConfiguration(peer).then(() => {
        if (this.peer !== peer || this.terminal || this.closing) return;
        return peer.createOffer({ iceRestart: true });
      }).then(() => {
        if (this.peer !== peer || this.terminal || this.closing) return;
        this.iceRestartInFlight = false;
        this.restartResponseTimer = this.clientScheduler.setTimeout(() => {
          this.restartResponseTimer = undefined;
          if (this.peer !== peer || this.terminal || this.closing) return;
          peer.markRestartOfferFailed();
          this.scheduleIceRecovery(true, true);
        }, 8_000);
      }).catch(() => {
        this.iceRestartInFlight = false;
        this.onRecoveryDiagnostic(`ice_restart_failed_${this.iceRestartAttempts}`);
        if (this.peer !== peer || this.terminal || this.closing) return;
        if (this.socket?.readyState !== 1) return;
        if (this.iceRestartAttempts < 2) this.scheduleIceRecovery(true);
      });
    }, delay);
  }

  private async refreshIceConfiguration(peer: WebRtcPeer): Promise<void> {
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
  }

  private clearRestartResponseTimer(): void {
    if (this.restartResponseTimer !== undefined) this.clientScheduler.clearTimeout(this.restartResponseTimer);
    this.restartResponseTimer = undefined;
  }

  protected override onAnswerApplied(): void {
    this.clearRestartResponseTimer();
  }

  protected override closePeer(): void {
    if (this.iceRecoveryTimer !== undefined) this.clientScheduler.clearTimeout(this.iceRecoveryTimer);
    this.iceRecoveryTimer = undefined;
    this.clearRestartResponseTimer();
    this.iceRestartAttempts = 0;
    this.iceRestartInFlight = false;
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
        const peer = this.createPeer("owner", message.session_id, this.iceConfiguration);
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
        const peer = this.createPeer("owner", message.session_id, this.iceConfiguration);
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
    const peer = this.createPeer("owner", message.session_id, this.iceConfiguration);
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
  onDiagnostic?: (diagnostic: WebRtcDiagnostic | RecoveryDiagnostic) => void;
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
  private readonly onDiagnostic?: (diagnostic: WebRtcDiagnostic | RecoveryDiagnostic) => void;
  private readonly onTerminalError?: (error: Error) => void;
  private readonly onViewerSessionEnded?: (reason: string) => void;
  private readonly onSharingState?: (state: { screen: boolean; camera: boolean }) => void;
  private readonly onDeviceAvailability?: (online: boolean) => void;
  private iceConfiguration: WebRtcConfiguration | undefined;
  private reconnecting = false;
  private hasEstablishedSession = false;
  private authorizationRetryCount = 0;
  private readonly retiredSessionIds = new Set<string>();
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
            this.ownerRecoverySessionId = undefined;
            this.onDeviceAvailability?.(false);
            this.fail(new Error("Desktop recovery window expired before the owner reconnected"), "timeout");
            this.socket?.close();
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

  protected override onRecoveryDiagnostic(
    phase: string,
    recoveryAttemptId?: string,
    sessionId?: string,
  ): void {
    this.onDiagnostic?.({
      event: "recovery",
      phase,
      recoveryAttemptId: recoveryAttemptId ?? this.recoveryAttemptId ?? crypto.randomUUID(),
      ...(sessionId ?? this.sessionId ? { sessionId: sessionId ?? this.sessionId } : {}),
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
    this.onViewerSessionEnded?.(reason);
    if (reason === "recovery_timeout") {
      this.onDeviceAvailability?.(false);
      this.fail(new Error("Desktop recovery window expired before the owner reconnected"), "timeout");
      return;
    }
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
