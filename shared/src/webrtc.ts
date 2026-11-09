import { validTrackMap, type ClientMessage, type MediaKind, type TrackMap } from "./protocol.js";

export interface WebRtcTrack {
  readonly kind?: string;
}

export interface WebRtcSender {
  replaceTrack(track: WebRtcTrack | null): Promise<void>;
}

export interface WebRtcTransceiver {
  readonly mid: string | null;
  readonly sender: WebRtcSender;
  direction: string;
}

export interface WebRtcDescription {
  readonly type: "offer" | "answer";
  readonly sdp?: string;
}

export interface WebRtcPeerConnection {
  readonly connectionState?: string;
  readonly iceConnectionState?: string;
  readonly transceivers: readonly WebRtcTransceiver[];
  addTransceiver(kind: string, init: { direction: "sendonly" | "recvonly" }): WebRtcTransceiver;
  setConfiguration(configuration: WebRtcConfiguration): void;
  createOffer(options?: { iceRestart?: boolean }): Promise<WebRtcDescription>;
  createAnswer(): Promise<WebRtcDescription>;
  setLocalDescription(description: WebRtcDescription): Promise<void>;
  setRemoteDescription(description: WebRtcDescription): Promise<void>;
  addIceCandidate(candidate: unknown): Promise<void>;
  close(): void;
  onicecandidate: ((event: { candidate: unknown | null }) => void) | null;
  onerror?: (() => void) | null;
  ontrack?: ((event: { track: WebRtcTrack }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  oniceconnectionstatechange: (() => void) | null;
}

export type IceTransportPolicy = "all" | "relay";
export type WebRtcConfiguration = {
  iceServers?: readonly {
    urls: string | readonly string[];
    username?: string;
    credential?: string;
  }[];
  iceTransportPolicy?: IceTransportPolicy;
};
export type WebRtcFactory = (configuration?: WebRtcConfiguration) => WebRtcPeerConnection;
export type SignalingSender = (message: ClientMessage) => void;
export type PeerState = "new" | "connecting" | "connected" | "disconnected" | "failed" | "closed";

const ORDER: readonly MediaKind[] = ["screen", "camera"];
const MAX_QUEUED_ICE_CANDIDATES = 64;

type NegotiationState =
  | "new"
  | "offer_created"
  | "offer_applied"
  | "answer_created"
  | "answer_applied"
  | "restart_offer_created"
  | "restart_offer_applied"
  | "restart_answer_created"
  | "restart_answer_applied"
  | "failed";

function validIceCandidate(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" && serialized.length <= 32 * 1024;
  } catch {
    return false;
  }
}

export function trackMapFromTransceivers(
  transceivers: readonly WebRtcTransceiver[],
  direction: "sendonly" | "recvonly" = "sendonly",
): TrackMap {
  if (transceivers.length !== 2 || transceivers.some((tx) => tx.direction !== direction || !tx.mid)) {
    throw new Error(`expected two negotiated ${direction} transceivers`);
  }
  const map = transceivers.map((tx, index) => ({ mid: tx.mid as string, kind: ORDER[index] })) as TrackMap;
  if (new Set(map.map((entry) => entry.mid)).size !== 2) throw new Error("duplicate negotiated mid");
  return map;
}

export class WebRtcPeer {
  readonly connection: WebRtcPeerConnection;
  private readonly sessionId: string;
  private readonly role: "owner" | "viewer";
  private readonly send: SignalingSender;
  private readonly transceivers!: Record<MediaKind, WebRtcTransceiver>;
  private stateValue: PeerState = "new";
  private negotiationState: NegotiationState = "new";
  private remoteDescriptionSet = false;
  private flushingCandidates = false;
  private readonly queuedCandidates: unknown[] = [];
  private closed = false;
  private stateListener: ((state: PeerState) => void) | undefined;
  private remoteTrackListener: ((track: WebRtcTrack) => void) | undefined;

  constructor(
    role: "owner" | "viewer",
    sessionId: string,
    factory: WebRtcFactory,
    send: SignalingSender,
  ) {
    this.role = role;
    this.sessionId = sessionId;
    this.send = send;
    this.connection = factory();
    this.connection.onicecandidate = (event) => {
      if (!this.closed && event.candidate !== null) {
        this.send({ type: "ice_candidate", session_id: this.sessionId, candidate: event.candidate });
      }
    };
    this.connection.onerror = () => this.close();
    this.connection.ontrack = (event) => this.remoteTrackListener?.(event.track);
    this.connection.onconnectionstatechange = () => this.updateState(this.connection.connectionState);
    this.connection.oniceconnectionstatechange = () => this.updateState(this.connection.iceConnectionState);
    const direction = role === "owner" ? "sendonly" : "recvonly";
    const screen = this.connection.addTransceiver("video", { direction });
    const camera = this.connection.addTransceiver("video", { direction });
    this.transceivers = { screen, camera };
  }

  get state(): PeerState { return this.stateValue; }

  get restartOfferPending(): boolean {
    return this.negotiationState === "restart_offer_created";
  }

  setConfiguration(configuration: WebRtcConfiguration): void {
    if (this.closed) throw new Error("peer is closed");
    this.connection.setConfiguration(configuration);
  }

  markRestartOfferFailed(): void {
    if (this.restartOfferPending) this.negotiationState = "failed";
  }

  setStateListener(listener: ((state: PeerState) => void) | undefined): void {
    this.stateListener = listener;
    listener?.(this.stateValue);
  }

  setRemoteTrackListener(listener: ((track: WebRtcTrack) => void) | undefined): void {
    this.remoteTrackListener = listener;
  }

  private updateState(value: string | undefined): void {
    if (this.closed) return;
    if (value === "connected" || value === "completed") this.stateValue = "connected";
    else if (value === "failed") {
      this.stateValue = "failed";
      this.negotiationState = "failed";
    }
    else if (value === "disconnected" || value === "closed") {
      this.stateValue = "disconnected";
      this.negotiationState = "failed";
    }
    else if (value === "connecting" || value === "checking") this.stateValue = "connecting";
    this.stateListener?.(this.stateValue);
  }

  async createOffer(options?: { iceRestart?: boolean }): Promise<void> {
    if (this.closed) throw new Error("peer is closed");
    const restarting = options?.iceRestart === true;
    if (this.role !== "owner" ||
      (!restarting && this.negotiationState !== "new") ||
      (restarting && ![
        "answer_applied",
        "restart_answer_applied",
        "failed",
      ].includes(this.negotiationState))) {
      throw new Error("peer cannot create an offer in its current state");
    }
    try {
      if (restarting) this.negotiationState = "restart_offer_created";
      const description = await this.connection.createOffer(options);
      await this.connection.setLocalDescription(description);
      if (!restarting) this.negotiationState = "offer_created";
      this.send({ type: "offer", session_id: this.sessionId, sdp: description.sdp ?? "", track_map: trackMapFromTransceivers(this.connection.transceivers) });
    } catch (error) {
      this.negotiationState = "failed";
      throw error;
    }
  }

  async acceptOffer(sdp: string, trackMap: TrackMap): Promise<void> {
    if (this.closed) throw new Error("peer is closed");
    const restarting = this.negotiationState === "failed" ||
      this.negotiationState === "restart_answer_applied";
    if (this.role !== "viewer" || (!restarting && this.negotiationState !== "new")) {
      throw new Error("peer cannot accept an offer in its current state");
    }
    if (!validTrackMap(trackMap)) throw new Error("invalid track map");
    try {
      await this.connection.setRemoteDescription({ type: "offer", sdp });
      this.remoteDescriptionSet = true;
      await this.flushQueuedCandidates();
      const negotiatedMap = trackMapFromTransceivers(this.connection.transceivers, "recvonly");
      if (negotiatedMap.some((entry, index) => entry.mid !== trackMap[index].mid || entry.kind !== trackMap[index].kind)) {
        throw new Error("track map does not match negotiated transceivers");
      }
      this.negotiationState = restarting ? "restart_offer_applied" : "offer_applied";
      const description = await this.connection.createAnswer();
      await this.connection.setLocalDescription(description);
      this.negotiationState = restarting ? "restart_answer_created" : "answer_created";
      this.send({ type: "answer", session_id: this.sessionId, sdp: description.sdp ?? "", track_map: negotiatedMap });
    } catch (error) {
      this.negotiationState = "failed";
      throw error;
    }
  }

  async acceptAnswer(sdp: string): Promise<void> {
    if (this.closed) throw new Error("peer is closed");
    const restarting = this.negotiationState === "restart_offer_created";
    if (this.role !== "owner" ||
      (!restarting && this.negotiationState !== "offer_created")) {
      throw new Error("peer cannot accept an answer in its current state");
    }
    try {
      await this.connection.setRemoteDescription({ type: "answer", sdp });
      this.remoteDescriptionSet = true;
      await this.flushQueuedCandidates();
      this.negotiationState = restarting ? "restart_answer_applied" : "answer_applied";
    } catch (error) {
      this.negotiationState = "failed";
      throw error;
    }
  }

  async addIceCandidate(candidate: unknown): Promise<void> {
    if (this.closed) throw new Error("peer is closed");
    if (this.negotiationState === "failed") throw new Error("peer negotiation has failed");
    if (!validIceCandidate(candidate)) throw new Error("invalid ICE candidate");
    if (!this.remoteDescriptionSet || this.flushingCandidates) {
      if (this.queuedCandidates.length >= MAX_QUEUED_ICE_CANDIDATES) {
        throw new Error("ICE candidate queue is full");
      }
      this.queuedCandidates.push(candidate);
      return;
    }
    try {
      await this.connection.addIceCandidate(candidate);
    } catch (error) {
      this.negotiationState = "failed";
      throw error;
    }
  }

  async replaceTrack(kind: MediaKind, track: WebRtcTrack | null): Promise<void> {
    if (this.closed) throw new Error("peer is closed");
    if (this.role !== "owner" || this.negotiationState === "failed" || !this.transceivers[kind]) {
      throw new Error("peer is not an owner");
    }
    await this.transceivers[kind].sender.replaceTrack(track);
  }

  private async flushQueuedCandidates(): Promise<void> {
    if (this.flushingCandidates) return;
    this.flushingCandidates = true;
    try {
      while (this.queuedCandidates.length > 0) {
        const candidate = this.queuedCandidates.shift();
        await this.connection.addIceCandidate(candidate);
      }
    } catch (error) {
      this.queuedCandidates.length = 0;
      this.negotiationState = "failed";
      throw error;
    } finally {
      this.flushingCandidates = false;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stateValue = "closed";
    this.stateListener?.(this.stateValue);
    this.queuedCandidates.length = 0;
    this.connection.onicecandidate = null;
    this.connection.onerror = null;
    this.connection.ontrack = null;
    this.connection.onconnectionstatechange = null;
    this.connection.oniceconnectionstatechange = null;
    this.connection.close();
  }
}
