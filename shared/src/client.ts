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
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export type SignalingSocketFactory = () => SignalingSocket;

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
  private closing = false;
  onRemoteTrack: ((track: WebRtcTrack) => void) | undefined;
  onShareRequest: ((request: Extract<ServerMessage, { type: "share_request" }>) => void) | undefined;

  protected constructor(socketFactory: SignalingSocketFactory, peerFactory: WebRtcFactory) {
    this.socketFactory = socketFactory;
    this.peerFactory = peerFactory;
  }

  get lifecycle(): ClientLifecycleState { return this.lifecycleValue; }

  protected setLifecycle(value: ClientLifecycleState): void {
    this.lifecycleValue = value;
  }

  protected connect(token: string): void {
    this.setLifecycle("CONNECTING");
    const socket = this.socketFactory();
    this.socket = socket;
    socket.onopen = () => this.send({ type: "auth", token });
    socket.onmessage = (event) => {
      const message = socketMessage(event);
      if (message) void this.handleMessage(message).catch(() => this.fail());
      else this.fail();
    };
    socket.onerror = () => this.fail();
    socket.onclose = () => {
      this.closePeer();
      if (!this.closing) this.setLifecycle("CLOSED");
    };
  }

  protected send(message: ClientMessage): void {
    if (!this.socket || this.socket.readyState !== 1) throw new Error("signaling socket is not open");
    this.socket.send(JSON.stringify(message));
  }

  protected createPeer(role: "owner" | "viewer", sessionId: string): WebRtcPeer {
    this.closePeer();
    const peer = new WebRtcPeer(role, sessionId, this.peerFactory, (message) => this.send(message));
    peer.setStateListener((state) => this.onPeerState(state));
    peer.setRemoteTrackListener((track) => this.onRemoteTrack?.(track));
    this.peer = peer;
    this.sessionId = sessionId;
    return peer;
  }

  protected onPeerState(state: PeerState): void {
    if (state === "connected") this.setLifecycle("CONNECTED");
    else if (state === "failed") this.fail();
    else if (state === "connecting") this.setLifecycle("NEGOTIATING");
  }

  protected async handleMessage(message: ServerMessage): Promise<void> {
    if (message.type === "offer" || message.type === "answer" || message.type === "ice_candidate") {
      if (message.session_id !== this.sessionId || !this.peer) return this.fail();
      if (message.type === "offer") {
        if (!message.track_map) return this.fail();
        await this.peer.acceptOffer(message.sdp, message.track_map);
      } else if (message.type === "answer") {
        await this.peer.acceptAnswer(message.sdp);
      } else if (message.type === "ice_candidate") {
        await this.peer.addIceCandidate(message.candidate);
      }
    } else if (message.type === "viewer_left" && message.session_id === this.sessionId) {
      this.closePeer();
      this.setLifecycle("CLOSED");
    } else if (message.type === "share_request" && message.session_id === this.sessionId) {
      this.onShareRequest?.(message);
    } else if (message.type === "error") {
      this.fail();
    }
  }

  protected closePeer(): void {
    this.peer?.close();
    this.peer = undefined;
    this.sessionId = undefined;
  }

  protected fail(): void {
    this.setLifecycle("FAILED");
    this.closePeer();
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
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
};

export class DesktopWebRtcClient extends WebRtcClient {
  public constructor(options: DesktopClientOptions) {
    super(options.socketFactory, options.peerFactory);
    this.loadRefreshCredential = options.loadRefreshCredential;
  }

  private readonly loadRefreshCredential: () => Promise<string | null>;

  async start(): Promise<void> {
    const credential = await this.loadRefreshCredential();
    if (!credential) {
      this.setLifecycle("FAILED");
      throw new Error("device credential unavailable");
    }
    this.connect(credential);
    this.socket!.onmessage = (event) => {
      const message = socketMessage(event);
      if (!message) return this.fail();
      if (message.type === "viewer_joined") {
        if (this.peer || this.sessionId) return this.fail();
        this.setLifecycle("NEGOTIATING");
        const peer = this.createPeer("owner", message.session_id);
        void peer.createOffer().catch(() => this.fail());
      }
      void this.handleMessage(message).catch(() => this.fail());
    };
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
};

export class ViewerWebRtcClient extends WebRtcClient {
  private readonly browserSessionToken: string;
  private readonly deviceId: string;

  public constructor(options: ViewerClientOptions) {
    super(options.socketFactory, options.peerFactory);
    this.browserSessionToken = options.browserSessionToken;
    this.deviceId = options.deviceId;
  }

  start(): void {
    this.connect(this.browserSessionToken);
    this.socket!.onmessage = (event) => {
      const message = socketMessage(event);
      if (!message) return this.fail();
      if (message.type === "authenticated") {
        this.send({ type: "create_session", device_id: this.deviceId });
      } else if (message.type === "session_created") {
        if (this.peer || this.sessionId) return this.fail();
        this.setLifecycle("NEGOTIATING");
        this.createPeer("viewer", message.session_id);
      }
      void this.handleMessage(message).catch(() => this.fail());
    };
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
