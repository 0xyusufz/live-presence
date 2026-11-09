import {
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
  type TrackMap,
} from "./protocol.js";
import {
  WebRtcPeer,
  type PeerState,
  type WebRtcTrack,
  type WebRtcConfiguration,
  type WebRtcFactory,
} from "./webrtc.js";

export type ClientLifecycleState =
  | "IDLE"
  | "CONNECTING"
  | "NEGOTIATING"
  | "CONNECTED"
  | "CLOSING"
  | "CLOSED"
  | "FAILED";

export interface SignalingSocket {
  readyState: number;
  send(data: string): void;
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
  protected closing = false;
  protected terminal = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private stableTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempts = 0;
  private initialNegotiationTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly reconnectOptions: Required<Omit<ReconnectOptions, "scheduler">>;
  protected readonly clientScheduler: ClientScheduler;
  onRemoteTrack: ((track: WebRtcTrack) => void) | undefined;
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
    };
  }

  get lifecycle(): ClientLifecycleState { return this.lifecycleValue; }

  protected setLifecycle(value: ClientLifecycleState): void {
    if (this.terminal && !["FAILED", "CLOSING", "CLOSED"].includes(value)) return;
    if (this.closing && !["CLOSING", "CLOSED"].includes(value)) return;
    this.lifecycleValue = value;
  }

  protected connect(
    token: string,
    messageHandler: (message: ServerMessage, socket: SignalingSocket) => void | Promise<void> =
      (message, socket) => this.handleMessage(message, socket),
  ): void {
    if (this.closing || this.terminal || this.socket) return;
    this.setLifecycle("CONNECTING");
    const socket = this.socketFactory();
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket || this.terminal || this.closing) return;
      this.send({ type: "auth", token });
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket || this.terminal || this.closing) return;
      const message = socketMessage(event);
      if (message) {
        void Promise.resolve(messageHandler(message, socket)).catch(() => {
          if (this.socket === socket && !this.terminal && !this.closing) this.fail();
        });
      }
      else this.fail();
    };
    socket.onerror = () => {
      if (this.socket !== socket) return;
      this.fail();
      socket.close();
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.closePeer();
      this.clearStableTimer();
      if (!this.closing) {
        if (event?.code === 1008) {
          this.markTerminal();
          this.setLifecycle("FAILED");
        } else if (!this.terminal) {
          this.setLifecycle("CLOSED");
          this.onControlPlaneClosed();
        }
      }
    };
  }

  protected send(message: ClientMessage): void {
    if (!this.socket || this.socket.readyState !== 1) throw new Error("signaling socket is not open");
    this.socket.send(JSON.stringify(message));
  }

  protected createPeer(role: "owner" | "viewer", sessionId: string, configuration?: WebRtcConfiguration): WebRtcPeer {
    this.closePeer();
    const peer = new WebRtcPeer(role, sessionId, () => this.peerFactory(configuration), (message) => this.send(message));
    peer.setStateListener((state) => this.onPeerState(state));
    peer.setRemoteTrackListener((track) => this.onRemoteTrack?.(track));
    this.peer = peer;
    this.sessionId = sessionId;
    this.initialNegotiationTimer = this.clientScheduler.setTimeout(() => {
      this.initialNegotiationTimer = undefined;
      if (this.peer !== peer || this.lifecycleValue !== "NEGOTIATING") return;
      this.markTerminal();
      this.onInitialNegotiationTimeout();
      this.fail();
      this.socket?.close();
    }, INITIAL_NEGOTIATION_TIMEOUT_MS);
    return peer;
  }

  protected onPeerState(state: PeerState): void {
    if (this.terminal || this.closing) return;
    if (state === "connected") {
      this.clearInitialNegotiationTimer();
      this.setLifecycle("CONNECTED");
    }
    else if (state === "failed") this.fail();
    else if (state === "connecting") this.setLifecycle("NEGOTIATING");
  }

  protected async handleMessage(message: ServerMessage, sourceSocket?: SignalingSocket): Promise<void> {
    if (this.terminal || this.closing) return;
    if (message.type === "authenticated") {
      await this.onAuthenticated(sourceSocket);
      if (
        this.terminal ||
        this.closing ||
        (sourceSocket && this.socket !== sourceSocket)
      ) return;
      this.startStableTimer();
      return;
    }

    if (message.type === "offer" || message.type === "answer" || message.type === "ice_candidate") {
      if (message.session_id !== this.sessionId || !this.peer) return this.fail();
      if (message.type === "offer") {
        if (!message.track_map) return this.fail();
        await this.peer.acceptOffer(message.sdp, message.track_map);
      } else if (message.type === "answer") {
        await this.peer.acceptAnswer(message.sdp);
        this.onAnswerApplied();
      } else if (message.type === "ice_candidate") {
        await this.peer.addIceCandidate(message.candidate);
      }
    } else if (message.type === "viewer_left" && message.session_id === this.sessionId) {
      this.closePeer();
      this.setLifecycle("CLOSED");
      this.onSessionEnded(message.reason);
    } else if (message.type === "share_request" && message.session_id === this.sessionId) {
      this.onShareRequest?.(message);
    } else if (message.type === "error") {
      if (this.onServerError(message.code)) return;
      this.markTerminal();
      this.fail();
      this.socket?.close();
    }
  }

  protected onAuthenticated(_sourceSocket?: SignalingSocket): void {}

  protected onAnswerApplied(): void {}

  protected onControlPlaneClosed(): void {}

  protected onSessionEnded(_reason: string): void {}

  protected onInitialNegotiationTimeout(): void {}

  protected onServerError(_code: string): boolean {
    return false;
  }

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

  protected closePeer(): void {
    this.clearInitialNegotiationTimer();
    this.peer?.close();
    this.peer = undefined;
    this.sessionId = undefined;
  }

  protected fail(): void {
    if (this.terminal && this.lifecycleValue === "FAILED") {
      this.closePeer();
      return;
    }
    this.setLifecycle("FAILED");
    this.closePeer();
  }

  close(): void {
    if (this.closing && this.lifecycleValue === "CLOSED") return;
    this.closing = true;
    this.cancelReconnect();
    this.clearStableTimer();
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
  loadRefreshCredential: () => Promise<string | null>;
  loadIceServers?: (credential: string) => Promise<WebRtcConfiguration>;
  reconnect?: ReconnectOptions;
  refreshPresence?: () => Promise<void>;
  onTerminalError?: (error: Error) => void;
};

export class DesktopWebRtcClient extends WebRtcClient {
  public constructor(options: DesktopClientOptions) {
    super(options.socketFactory, options.peerFactory, options.reconnect);
    this.loadRefreshCredential = options.loadRefreshCredential;
    this.loadIceServers = options.loadIceServers;
    this.refreshPresence = options.refreshPresence;
    this.onTerminalError = options.onTerminalError;
  }

  private readonly loadRefreshCredential: () => Promise<string | null>;
  private readonly loadIceServers?: (credential: string) => Promise<WebRtcConfiguration>;
  private iceConfiguration: WebRtcConfiguration | undefined;
  private readonly refreshPresence?: () => Promise<void>;
  private readonly onTerminalError?: (error: Error) => void;
  private restartResponseTimer: ReturnType<typeof setTimeout> | undefined;
  private startInFlight: Promise<void> | undefined;

  protected override onPeerState(state: PeerState): void {
    if (this.terminal || this.closing) return;
    if (
      this.lifecycle === "NEGOTIATING" &&
      (state === "disconnected" || state === "failed")
    ) {
      if (state === "failed") this.markTerminal();
      super.onPeerState(state);
      return;
    }
    if (state === "connected") {
      this.iceRestartAttempts = 0;
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
      this.scheduleIceRecovery(true);
      return;
    }
    super.onPeerState(state);
  }

  protected override onControlPlaneClosed(): void {
    this.scheduleReconnect(() => void this.start(true).catch(() => this.onControlPlaneClosed()));
  }

  protected override onInitialNegotiationTimeout(): void {
    this.onTerminalError?.(
      new Error(`initial ICE negotiation timed out after ${INITIAL_NEGOTIATION_TIMEOUT_MS / 1000} seconds`),
    );
  }

  protected override async onAuthenticated(): Promise<void> {
    await this.refreshPresence?.();
  }

  private iceRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private iceRestartAttempts = 0;

  private scheduleIceRecovery(immediate = false): void {
    if (!this.peer || this.iceRecoveryTimer !== undefined) return;
    if (this.peer.restartOfferPending) this.peer.markRestartOfferFailed();
    this.clearRestartResponseTimer();
    if (this.iceRestartAttempts >= 2) {
      this.failIceRecovery();
      return;
    }
    const delay = immediate ? 0 : 8_000;
    this.iceRecoveryTimer = this.clientScheduler.setTimeout(() => {
      this.iceRecoveryTimer = undefined;
      const peer = this.peer;
      if (!peer || this.terminal || this.closing) return;
      this.iceRestartAttempts += 1;
      void this.refreshIceConfiguration(peer).then(() => {
        if (this.peer !== peer || this.terminal || this.closing) return;
        return peer.createOffer({ iceRestart: true });
      }).then(() => {
        if (this.peer !== peer || this.terminal || this.closing) return;
        this.restartResponseTimer = this.clientScheduler.setTimeout(() => {
          this.restartResponseTimer = undefined;
          if (this.peer !== peer || this.terminal || this.closing) return;
          peer.markRestartOfferFailed();
          this.scheduleIceRecovery(true);
        }, 8_000);
      }).catch(() => {
        if (this.peer !== peer || this.terminal || this.closing) return;
        if (this.iceRestartAttempts >= 2) this.failIceRecovery();
        else this.scheduleIceRecovery(true);
      });
    }, delay);
  }

  private async refreshIceConfiguration(peer: WebRtcPeer): Promise<void> {
    if (!this.loadIceServers) return;
    const credential = await this.loadRefreshCredential();
    if (!credential) throw new Error("device credential unavailable");
    const configuration = await this.loadIceServers(credential);
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

  private failIceRecovery(): void {
    if (this.terminal || this.closing) return;
    this.markTerminal();
    const relayStatus = this.iceConfiguration?.iceTransportPolicy === "relay"
      ? "relay-only"
      : "direct-or-relay";
    this.onTerminalError?.(
      new Error(`ICE restart failed twice; relay status: ${relayStatus}`),
    );
    super.fail();
  }

  protected override closePeer(): void {
    if (this.iceRecoveryTimer !== undefined) this.clientScheduler.clearTimeout(this.iceRecoveryTimer);
    this.iceRecoveryTimer = undefined;
    this.clearRestartResponseTimer();
    this.iceRestartAttempts = 0;
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
    const credential = await this.loadRefreshCredential();
    if (this.closing || this.terminal) return;
    if (!credential) {
      this.markTerminal();
      this.setLifecycle("FAILED");
      throw new Error("device credential unavailable");
    }
    this.iceConfiguration = this.loadIceServers ? await this.loadIceServers(credential) : undefined;
    if (this.closing || this.terminal) return;
    this.connect(credential, (message, socket) => {
      if (message.type === "viewer_joined") {
        if (this.peer || this.sessionId) return this.fail();
        this.setLifecycle("NEGOTIATING");
        const peer = this.createPeer("owner", message.session_id, this.iceConfiguration);
        void peer.createOffer().catch(() => this.fail());
      }
      return this.handleMessage(message, socket);
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
  browserSessionToken: string;
  deviceId: string;
  loadIceServers?: () => Promise<WebRtcConfiguration>;
  reconnect?: ReconnectOptions;
  refreshPresence?: () => Promise<void>;
};

export class ViewerWebRtcClient extends WebRtcClient {
  private readonly browserSessionToken: string;
  private readonly deviceId: string;
  private readonly loadIceServers?: () => Promise<WebRtcConfiguration>;
  private readonly refreshPresence?: () => Promise<void>;
  private iceConfiguration: WebRtcConfiguration | undefined;
  private reconnecting = false;
  private hasEstablishedSession = false;
  private authorizationRetryCount = 0;

  public constructor(options: ViewerClientOptions) {
    super(options.socketFactory, options.peerFactory, options.reconnect);
    this.browserSessionToken = options.browserSessionToken;
    this.deviceId = options.deviceId;
    this.loadIceServers = options.loadIceServers;
    this.refreshPresence = options.refreshPresence;
  }

  start(reconnecting = false): void {
    if (!reconnecting) this.closing = false;
    if (this.socket) return;
    this.reconnecting = reconnecting;
    this.connect(this.browserSessionToken, (message, socket) => {
      if (message.type === "session_created") {
        if (this.peer || this.sessionId) return this.fail();
        this.reconnecting = false;
        this.hasEstablishedSession = true;
        this.authorizationRetryCount = 0;
        this.setLifecycle("NEGOTIATING");
        this.createPeer("viewer", message.session_id, this.iceConfiguration);
      }
      return this.handleMessage(message, socket);
    });
  }

  protected override async onAuthenticated(sourceSocket?: SignalingSocket): Promise<void> {
    await this.refreshPresence?.();
    if (this.terminal || this.closing || (sourceSocket && this.socket !== sourceSocket)) return;
    this.iceConfiguration = await this.loadIceServers?.();
    if (this.terminal || this.closing || (sourceSocket && this.socket !== sourceSocket)) return;
    this.send({ type: "create_session", device_id: this.deviceId });
  }

  protected override onControlPlaneClosed(): void {
    this.scheduleReconnect(() => this.start(true));
  }

  protected override onServerError(code: string): boolean {
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
    if (reason === "authorization_revoked" || reason === "closed") {
      this.markTerminal();
      return;
    }
    this.scheduleReconnect(() => {
      if (this.socket?.readyState === 1) this.send({ type: "create_session", device_id: this.deviceId });
    });
  }

  override close(): void {
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
