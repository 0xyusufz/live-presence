import { validTrackMap, type ClientMessage, type MediaKind, type TrackMap } from "./protocol.js";

export interface WebRtcTrack {
  readonly kind?: string;
  readonly readyState?: string;
}

export interface WebRtcSender {
  replaceTrack(track: WebRtcTrack | null): Promise<void>;
}

export interface WebRtcTransceiver {
  readonly mid: string | null;
  currentDirection?: string | null;
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
  readonly signalingState?: string;
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
  ontrack?: ((event: { track: WebRtcTrack; transceiver?: { mid: string | null } }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  oniceconnectionstatechange: (() => void) | null;
  onsignalingstatechange?: (() => void) | null;
}

export type WebRtcFailureCategory = "negotiation" | "sdp" | "ice" | "peer" | "signaling";

export type WebRtcDiagnostic = {
  event?:
    | "ice_restart_offer_created"
    | "ice_restart_offer_sent"
    | "ice_candidate_sent"
    | "peer_connection_state_changed"
    | "ice_connection_state_changed"
    | "signaling_state_changed";
  timestamp?: string;
  role: "owner" | "viewer";
  sessionId: string;
  negotiationId?: string;
  peerGeneration?: number;
  recoveryAttemptId?: string;
  socketConnectionGeneration?: number;
  reason?: string;
  candidateType?: "host" | "srflx" | "prflx" | "relay" | "unknown";
  peerState: PeerState;
  connectionState?: string;
  iceConnectionState?: string;
  signalingState?: string;
  operation?: "setRemoteDescription" | "createAnswer" | "setLocalDescription" | "sendAnswer";
  operationStatus?: "started" | "succeeded" | "failed";
};

export class WebRtcPeerError extends Error {
  constructor(
    readonly category: WebRtcFailureCategory,
    message: string,
    readonly diagnostic: WebRtcDiagnostic,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WebRtcPeerError";
  }
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

export function candidateTypeFromCandidate(candidate: unknown): WebRtcDiagnostic["candidateType"] {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return "unknown";
  const value = candidate as Record<string, unknown>;
  if (value.type === "host" || value.type === "srflx" || value.type === "prflx" || value.type === "relay") {
    return value.type;
  }
  if (typeof value.candidate === "string") {
    return /\btyp host\b/.test(value.candidate) ? "host" :
      /\btyp srflx\b/.test(value.candidate) ? "srflx" :
      /\btyp prflx\b/.test(value.candidate) ? "prflx" :
      /\btyp relay\b/.test(value.candidate) ? "relay" : "unknown";
  }
  return "unknown";
}

type NegotiationState =
  | "new"
  | "offer_created"
  | "offer_applying"
  | "offer_applied"
  | "answer_created"
  | "answer_applied"
  | "restart_offer_created"
  | "restart_offer_applying"
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
  private negotiationIdValue: string | undefined;
  private readonly role: "owner" | "viewer";
  private readonly send: SignalingSender;
  private readonly transceivers: Record<MediaKind, WebRtcTransceiver> | undefined = undefined;
  private stateValue: PeerState = "new";
  private negotiationState: NegotiationState = "new";
  private remoteDescriptionSet = false;
  private flushingCandidates = false;
  private readonly queuedCandidates: unknown[] = [];
  private closed = false;
  private stateListener: ((state: PeerState) => void) | undefined;
  private diagnosticListener: ((diagnostic: WebRtcDiagnostic) => void) | undefined;
  private failureListener: ((error: WebRtcPeerError) => void) | undefined;
  private remoteTrackListener: ((track: WebRtcTrack, mid: string | null, kind?: MediaKind) => void) | undefined;
  private remoteTrackKinds = new Map<string, MediaKind>();
  private pendingRemoteTracks: Array<{ track: WebRtcTrack; mid: string | null }> = [];
  private pendingOffer?: { key: string; promise: Promise<void> };
  private lastAnsweredOfferKey: string | undefined;
  private lastConnectionState: string | undefined;
  private lastIceConnectionState: string | undefined;
  private lastSignalingState: string | undefined;

  constructor(
    role: "owner" | "viewer",
    sessionId: string,
    factory: WebRtcFactory,
    send: SignalingSender,
    negotiationId?: string,
  ) {
    this.role = role;
    this.sessionId = sessionId;
    this.negotiationIdValue = negotiationId ?? (role === "owner" ? crypto.randomUUID() : undefined);
    this.send = send;
    this.connection = factory();
    this.lastConnectionState = this.connection.connectionState;
    this.lastIceConnectionState = this.connection.iceConnectionState;
    this.lastSignalingState = this.connection.signalingState;
    this.connection.onicecandidate = (event) => {
      if (!this.closed && event.candidate !== null) {
        try {
          if (!this.negotiationIdValue) return;
          this.send({
            type: "ice_candidate",
            session_id: this.sessionId,
            negotiation_id: this.negotiationIdValue,
            candidate: event.candidate,
          });
          this.emitDiagnostic("ice_candidate_sent", {
            candidateType: candidateTypeFromCandidate(event.candidate),
            reason: "local ICE candidate handed to signaling sender",
          });
        } catch (error) {
          this.failureListener?.(this.makeError("signaling", "Sending ICE candidate failed", error));
        }
      }
    };
    this.connection.onerror = () => {
      this.stateValue = "failed";
      this.negotiationState = "failed";
      this.emitDiagnostic();
      const error = this.makeError("peer", "Peer connection reported an error");
      this.failureListener?.(error);
      this.close();
    };
    this.connection.ontrack = (event) => {
      const mid = event.transceiver?.mid ?? null;
      const kind = mid === null ? undefined : this.remoteTrackKinds.get(mid);
      if (kind) this.remoteTrackListener?.(event.track, mid, kind);
      else this.pendingRemoteTracks.push({ track: event.track, mid });
    };
    this.connection.onconnectionstatechange = () => {
      const current = this.connection.connectionState;
      if (current !== this.lastConnectionState) {
        const previous = this.lastConnectionState;
        this.lastConnectionState = current;
        this.emitDiagnostic("peer_connection_state_changed", {
          reason: `${previous ?? "unknown"} -> ${current ?? "unknown"}`,
        });
      }
      this.updateState(current);
    };
    this.connection.oniceconnectionstatechange = () => {
      const current = this.connection.iceConnectionState;
      if (current !== this.lastIceConnectionState) {
        const previous = this.lastIceConnectionState;
        this.lastIceConnectionState = current;
        this.emitDiagnostic("ice_connection_state_changed", {
          reason: `${previous ?? "unknown"} -> ${current ?? "unknown"}`,
        });
      }
      this.updateState(current);
    };
    if ("onsignalingstatechange" in this.connection) {
      this.connection.onsignalingstatechange = () => {
        const current = this.connection.signalingState;
        if (current !== this.lastSignalingState) {
          const previous = this.lastSignalingState;
          this.lastSignalingState = current;
          this.emitDiagnostic("signaling_state_changed", {
            reason: `${previous ?? "unknown"} -> ${current ?? "unknown"}`,
          });
        }
      };
    }
    if (role === "owner") {
      const screen = this.connection.addTransceiver("video", { direction: "sendonly" });
      const camera = this.connection.addTransceiver("video", { direction: "sendonly" });
      this.transceivers = { screen, camera };
    }
  }

  get state(): PeerState { return this.stateValue; }

  get negotiationId(): string | undefined { return this.negotiationIdValue; }

  get diagnostic(): WebRtcDiagnostic { return this.createDiagnostic(); }

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

  setDiagnosticListener(listener: ((diagnostic: WebRtcDiagnostic) => void) | undefined): void {
    this.diagnosticListener = listener;
    this.emitDiagnostic();
  }

  setFailureListener(listener: ((error: WebRtcPeerError) => void) | undefined): void {
    this.failureListener = listener;
  }

  private createDiagnostic(
    event?: WebRtcDiagnostic["event"],
    fields: Partial<WebRtcDiagnostic> = {},
  ): WebRtcDiagnostic {
    return {
      ...(event ? { event } : {}),
      timestamp: new Date().toISOString(),
      role: this.role,
      sessionId: this.sessionId,
      ...(this.negotiationIdValue ? { negotiationId: this.negotiationIdValue } : {}),
      peerState: this.stateValue,
      ...(this.connection.connectionState ? { connectionState: this.connection.connectionState } : {}),
      ...(this.connection.iceConnectionState ? { iceConnectionState: this.connection.iceConnectionState } : {}),
      ...(this.connection.signalingState ? { signalingState: this.connection.signalingState } : {}),
      ...fields,
    };
  }

  private emitDiagnostic(
    event?: WebRtcDiagnostic["event"],
    fields: Partial<WebRtcDiagnostic> = {},
  ): void {
    this.diagnosticListener?.(this.createDiagnostic(event, fields));
  }

  private emitOperation(
    operation: NonNullable<WebRtcDiagnostic["operation"]>,
    operationStatus: NonNullable<WebRtcDiagnostic["operationStatus"]>,
  ): void {
    this.diagnosticListener?.({ ...this.createDiagnostic(), operation, operationStatus });
  }

  private makeError(
    category: WebRtcFailureCategory,
    operation: string,
    cause?: unknown,
  ): WebRtcPeerError {
    const detail = cause instanceof Error ? cause.message : undefined;
    const safeDetail = detail && !/(?:v=0|a=candidate:|candidate:|bearer\s|cookie|token|credential|authorization)/i.test(detail)
      ? `: ${detail.slice(0, 240)}`
      : "";
    return new WebRtcPeerError(category, `${operation}${safeDetail}`, this.createDiagnostic(), {
      ...(cause === undefined ? {} : { cause }),
    });
  }

  setRemoteTrackListener(listener: ((track: WebRtcTrack, mid: string | null, kind?: MediaKind) => void) | undefined): void {
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
    this.emitDiagnostic();
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
    if (!this.negotiationIdValue) throw new Error("peer negotiation identifier is unavailable");
    let description: WebRtcDescription;
    try {
      if (restarting) this.negotiationState = "restart_offer_created";
      description = await this.connection.createOffer(options);
      await this.connection.setLocalDescription(description);
      if (!restarting) this.negotiationState = "offer_created";
      else this.emitDiagnostic("ice_restart_offer_created", {
        reason: "ICE restart offer created and set as local description",
      });
    } catch (error) {
      this.negotiationState = "failed";
      throw this.makeError(restarting ? "ice" : "negotiation", "Creating WebRTC offer failed", error);
    }
    try {
      this.send({
        type: "offer",
        session_id: this.sessionId,
        negotiation_id: this.negotiationIdValue,
        sdp: description.sdp ?? "",
        track_map: trackMapFromTransceivers(this.connection.transceivers),
      });
      if (restarting) this.emitDiagnostic("ice_restart_offer_sent", {
        reason: "ICE restart offer handed to signaling sender",
      });
    } catch (error) {
      this.negotiationState = "failed";
      throw this.makeError("signaling", "Sending WebRTC offer failed", error);
    }
  }

  acceptOffer(sdp: string, trackMap: TrackMap, negotiationId: string): Promise<void> {
    if (this.negotiationIdValue && this.negotiationIdValue !== negotiationId) {
      return Promise.reject(new Error("offer negotiation identifier did not match the active peer"));
    }
    this.negotiationIdValue = negotiationId;
    const key = JSON.stringify([sdp, trackMap]);
    if (this.pendingOffer?.key === key) return this.pendingOffer.promise;
    if (this.lastAnsweredOfferKey === key) return Promise.resolve();
    const operation = this.applyOffer(sdp, trackMap);
    let tracked: Promise<void>;
    tracked = operation.then(
      () => {
        this.lastAnsweredOfferKey = key;
        if (this.pendingOffer?.promise === tracked) this.pendingOffer = undefined;
      },
      (error: unknown) => {
        if (this.pendingOffer?.promise === tracked) this.pendingOffer = undefined;
        throw error;
      },
    );
    this.pendingOffer = { key, promise: tracked };
    return tracked;
  }

  private async applyOffer(sdp: string, trackMap: TrackMap): Promise<void> {
    if (this.closed) throw new Error("peer is closed");
    const restarting = this.negotiationState === "failed" ||
      this.negotiationState === "restart_answer_applied";
    if (this.role !== "viewer" || (!restarting && this.negotiationState !== "new")) {
      throw new Error("peer cannot accept an offer in its current state");
    }
    if (!validTrackMap(trackMap)) throw new Error("invalid track map");
    this.negotiationState = restarting ? "restart_offer_applying" : "offer_applying";
    try {
      this.emitOperation("setRemoteDescription", "started");
      try {
        await this.connection.setRemoteDescription({ type: "offer", sdp });
      } catch (error) {
        this.emitOperation("setRemoteDescription", "failed");
        throw this.makeError("sdp", "Viewer setRemoteDescription(offer) failed", error);
      }
      this.emitOperation("setRemoteDescription", "succeeded");
      this.remoteDescriptionSet = true;
      await this.flushQueuedCandidates();
      const negotiatedMap = trackMapFromTransceivers(this.connection.transceivers, "recvonly");
      if (negotiatedMap.some((entry, index) => entry.mid !== trackMap[index].mid || entry.kind !== trackMap[index].kind)) {
        throw new Error("track map does not match negotiated transceivers");
      }
      this.remoteTrackKinds = new Map(negotiatedMap.map((entry) => [entry.mid, entry.kind]));
      for (const pending of this.pendingRemoteTracks.splice(0)) {
        const kind = pending.mid === null ? undefined : this.remoteTrackKinds.get(pending.mid);
        if (kind) this.remoteTrackListener?.(pending.track, pending.mid, kind);
      }
      this.negotiationState = restarting ? "restart_offer_applied" : "offer_applied";
      this.emitOperation("createAnswer", "started");
      let description: WebRtcDescription;
      try {
        description = await this.connection.createAnswer();
      } catch (error) {
        this.emitOperation("createAnswer", "failed");
        throw this.makeError("negotiation", "Viewer createAnswer() failed", error);
      }
      this.emitOperation("createAnswer", "succeeded");
      this.emitOperation("setLocalDescription", "started");
      try {
        await this.connection.setLocalDescription(description);
      } catch (error) {
        this.emitOperation("setLocalDescription", "failed");
        throw this.makeError("sdp", "Viewer setLocalDescription(answer) failed", error);
      }
      this.emitOperation("setLocalDescription", "succeeded");
      this.negotiationState = restarting ? "restart_answer_created" : "answer_created";
      const negotiatedTransceivers = this.connection.transceivers;
      const negotiatedAnswerMap = trackMapFromTransceivers(negotiatedTransceivers, "recvonly");
      if (
        negotiatedAnswerMap.some((entry, index) =>
          entry.mid !== negotiatedMap[index].mid ||
          entry.kind !== negotiatedMap[index].kind ||
          (negotiatedTransceivers[index]?.currentDirection !== undefined &&
            negotiatedTransceivers[index]?.currentDirection !== "recvonly"))
      ) {
        throw new Error("viewer answer did not negotiate the canonical recvonly transceivers");
      }
      this.emitOperation("sendAnswer", "started");
      try {
        this.send({
          type: "answer",
          session_id: this.sessionId,
          negotiation_id: this.negotiationIdValue!,
          sdp: description.sdp ?? "",
          track_map: negotiatedMap,
        });
      } catch (error) {
        this.emitOperation("sendAnswer", "failed");
        throw this.makeError("signaling", "Sending WebRTC answer through signaling failed", error);
      }
      this.emitOperation("sendAnswer", "succeeded");
    } catch (error) {
      this.negotiationState = "failed";
      if (error instanceof WebRtcPeerError) throw error;
      throw this.makeError("sdp", "Processing remote SDP offer failed", error);
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
      if (error instanceof WebRtcPeerError) throw error;
      throw this.makeError("sdp", "Processing remote SDP answer failed", error);
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
      throw this.makeError("ice", "Adding ICE candidate failed", error);
    }
  }

  async replaceTrack(kind: MediaKind, track: WebRtcTrack | null): Promise<void> {
    if (this.closed) throw new Error("peer is closed");
    if (this.role !== "owner" || this.negotiationState === "failed" || !this.transceivers?.[kind]) {
      throw new Error("peer is not an owner");
    }
    if (track?.readyState === "ended") throw new Error("cannot attach an ended track");
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
      this.pendingRemoteTracks.length = 0;
      this.remoteTrackKinds.clear();
      this.negotiationState = "failed";
      throw this.makeError("ice", "Applying queued ICE candidates failed", error);
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
    if ("onsignalingstatechange" in this.connection) this.connection.onsignalingstatechange = null;
    this.connection.close();
  }
}
