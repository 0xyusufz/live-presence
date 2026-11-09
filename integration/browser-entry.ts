import {
  DesktopWebRtcClient,
  ViewerWebRtcClient,
  type SignalingSocket,
} from "../shared/src/client.js";
import type {
  WebRtcConfiguration,
  WebRtcPeerConnection,
  WebRtcTrack,
} from "../shared/src/webrtc.js";

type Role = "owner" | "viewer";
type Policy = "all" | "relay";

type StartOptions = {
  role: Role;
  baseUrl: string;
  wsUrl: string;
  token: string;
  deviceId?: string;
  policy: Policy;
  iceServersOverride?: WebRtcConfiguration["iceServers"];
  reconnectBaseDelayMs?: number;
  blockDirectCandidates?: boolean;
};

type StatsSnapshot = {
  candidateType: string | null;
  localCandidateType: string | null;
  remoteCandidateType: string | null;
  dtlsState: string | null;
};

type HarnessSnapshot = {
  lifecycle: string;
  receivedTracks: number;
  renderedFrames: number;
  peerConnectionState: string | null;
  iceConnectionState: string | null;
  openSockets: number;
  stats: StatsSnapshot | null;
  gatheredCandidateTypes: string[];
  authenticatedSockets: number;
  authenticated: boolean;
  error: string | null;
  peerConnectionsCreated: number;
  syntheticTracksAttached: number;
  sessionId: string | null;
};

type Harness = {
  start: () => Promise<void>;
  snapshot: () => Promise<HarnessSnapshot>;
  close: () => void;
  forceSocketClose: () => void;
  forceReconnect: () => void;
};

const sockets: BrowserSocket[] = [];
let connection: WebRtcPeerConnection | undefined;
let client: BrowserClient | undefined;
let receivedTracks = 0;
let renderedFrames = 0;
let remoteVideo: HTMLVideoElement | undefined;
let remoteStream: MediaStream | undefined;
let authenticatedSockets = 0;
let lastError: string | null = null;
let lastMessageType: string | null = null;
let lastSentType: string | null = null;
let syntheticTimers: number[] = [];
let syntheticStreams: MediaStream[] = [];
let peerConnectionsCreated = 0;
let syntheticTracksAttached = 0;

class BrowserSocket implements SignalingSocket {
  readonly raw: WebSocket;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event?: { code?: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  protected readonly blockDirectCandidates: boolean;

  constructor(
    url: string,
    blockDirectCandidates = false,
  ) {
    this.blockDirectCandidates = blockDirectCandidates;
    this.raw = new WebSocket(url);
    this.raw.onopen = () => {
      authenticatedSockets += 1;
      this.onopen?.();
    };
    this.raw.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data)) as { type?: unknown; code?: unknown };
        if (typeof message.type === "string") {
          lastMessageType = message.type;
          if (message.type === "error" && typeof message.code === "string") {
            lastError = `server error: ${message.code}`;
          }

        }
      } catch {
        lastError = "received malformed signaling message";
      }
      this.onmessage?.({ data: event.data });
    };
    this.raw.onclose = (event) => this.onclose?.({ code: event.code });
    this.raw.onerror = () => this.onerror?.();
  }

  get readyState(): number {
    return this.raw.readyState;
  }

  send(data: string): void {
    try {
      const message = JSON.parse(data) as { type?: unknown; candidate?: unknown };
      if (typeof message.type === "string") lastSentType = message.type;
      const candidate = message.candidate as { candidate?: unknown } | null;
      if (
        this.blockDirectCandidates &&
        message.type === "ice_candidate" &&
        typeof candidate?.candidate === "string" &&
        /\btyp\s+(host|srflx)\b/.test(candidate.candidate)
      ) {
        return;
      }
    } catch {
      lastError = "attempted to send malformed signaling message";
    }
    this.raw.send(data);
  }

  close(): void {
    this.raw.close();
  }
}

class BrowserClient {
  protected readonly socketUrl: string;
  protected readonly baseUrl: string;
  protected readonly token: string;
  protected readonly policy: Policy;
  protected readonly iceServersOverride: WebRtcConfiguration["iceServers"] | undefined;
  protected readonly socketList: BrowserSocket[];
  protected currentConnection: WebRtcPeerConnection | undefined;

  constructor(options: StartOptions) {
    this.socketUrl = options.wsUrl;
    this.baseUrl = options.baseUrl;
    this.token = options.token;
    this.policy = options.policy;
    this.iceServersOverride = options.iceServersOverride;
    this.blockDirectCandidates = options.blockDirectCandidates ?? false;
    this.socketList = sockets;
  }

  protected socketFactory = (): SignalingSocket => {
    const socket = new BrowserSocket(this.socketUrl, this.blockDirectCandidates);
    this.socketList.push(socket);
    return socket;
  };

  protected peerFactory = (
    configuration?: WebRtcConfiguration,
  ): WebRtcPeerConnection => {
    const peer = new RTCPeerConnection(configuration);
    const createOffer = peer.createOffer.bind(peer);
    peer.createOffer = ((options?: { iceRestart?: boolean }) =>
      createOffer(options).catch((error: unknown) => {
        lastError = error instanceof Error ? error.message : "createOffer failed";
        throw error;
      })) as typeof peer.createOffer;
    const setLocalDescription = peer.setLocalDescription.bind(peer);
    peer.setLocalDescription = ((description: RTCSessionDescriptionInit) =>
      setLocalDescription(description).catch((error: unknown) => {
        lastError = error instanceof Error ? error.message : "setLocalDescription failed";
        throw error;
      })) as typeof peer.setLocalDescription;
    Object.defineProperty(peer, "transceivers", {
      configurable: true,
      get: () => {
        const all = peer.getTransceivers();
        const negotiated = all.filter((transceiver) => transceiver.mid !== null);
        return negotiated.length === 2 ? negotiated : all;
      },
    });
    this.currentConnection = peer;
    connection = peer;
    peerConnectionsCreated += 1;
    return peer;
  };

  protected async loadIceServers(
    authorization?: string,
  ): Promise<WebRtcConfiguration> {
    const headers: Record<string, string> = {};
    if (authorization) headers.authorization = `Bearer ${authorization}`;
    try {
      const response = await fetch(`${this.baseUrl}/webrtc/ice-servers`, {
        headers,
        credentials: authorization ? "omit" : "include",
      });
      if (!response.ok) throw new Error(`ICE server request failed (${response.status})`);
      const value = await response.json() as { iceServers?: WebRtcConfiguration["iceServers"] };
      if (!Array.isArray(value.iceServers) || value.iceServers.length === 0) {
        throw new Error("ICE server response was empty");
      }
      return {
        iceServers: this.iceServersOverride ?? value.iceServers,
        iceTransportPolicy: this.policy,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : "ICE server request failed";
      throw error;
    }
  }

  get peerConnection(): WebRtcPeerConnection | undefined {
    return this.currentConnection;
  }

  describeTransceivers(): string {
    const peer = this.currentConnection as RTCPeerConnection | undefined;
    return peer
      ? peer.getTransceivers().map((tx) => `${tx.mid ?? "null"}:${tx.direction}`).join(",")
      : "no connection";
  }
}

class OwnerClient extends DesktopWebRtcClient {
  private readonly browser: BrowserClient;

  constructor(options: StartOptions) {
    const browser = new BrowserClient(options);
    super({
      socketFactory: browser.socketFactory,
      peerFactory: browser.peerFactory,
      loadRefreshCredential: async () => options.token,
      loadIceServers: async (credential) => browser.loadIceServers(credential),
      reconnect: options.reconnectBaseDelayMs === undefined
        ? undefined
        : { baseDelayMs: options.reconnectBaseDelayMs },
    });
    this.browser = browser;
  }

  protected override createPeer(
    role: "owner" | "viewer",
    sessionId: string,
    configuration?: WebRtcConfiguration,
  ) {
    try {
      const peer = super.createPeer(role, sessionId, configuration);
      const acceptAnswer = peer.acceptAnswer.bind(peer);
      peer.acceptAnswer = async (sdp: string) => {
        try {
          await acceptAnswer(sdp);
        } catch (error) {
          lastError = error instanceof Error ? error.message : "owner answer handling failed";
          throw error;
        }
      };
      return peer;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "owner peer creation failed";
      throw error;
    }
  }

  async attachSyntheticTracks(): Promise<void> {
    try {
      await waitFor(() => this.peer !== undefined, 5_000, "owner peer is not ready");
    } catch (error) {
      const message = error instanceof Error ? error.message : "owner peer is not ready";
      throw new Error(`${message}; ${lastError ?? "no peer creation diagnostic"}`);
    }
    if (!this.peer) throw new Error("owner peer is not ready");
    const tracks = ["screen", "camera"].map((label, index) => {
      const canvas = document.createElement("canvas");
      canvas.width = 160;
      canvas.height = 90;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("canvas context unavailable");
      context.fillStyle = index === 0 ? "#1769aa" : "#b33a3a";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#ffffff";
      context.font = "16px sans-serif";
      context.fillText(label, 12, 48);
      const stream = canvas.captureStream(5);
      let frame = 0;
      syntheticTimers.push(window.setInterval(() => {
        frame += 1;
        context.fillStyle = index === 0 ? "#1769aa" : "#b33a3a";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = "#ffffff";
        context.fillText(`${label} ${frame}`, 12, 48);
      }, 200));
      syntheticStreams.push(stream);
      return stream.getVideoTracks()[0]!;
    });
    void this.peer.replaceTrack("screen", tracks[0]);
    void this.peer.replaceTrack("camera", tracks[1]);
    syntheticTracksAttached += 1;
  }

  get connection(): WebRtcPeerConnection | undefined {
    return this.browser.peerConnection;
  }

  get activeSessionId(): string | null {
    return this.sessionId ?? null;
  }

  forceSocketClose(): void {
    this.socket?.close();
  }

  forceReconnect(): void {
    this.close();
    this.terminal = false;
    window.setTimeout(() => void this.start(), 100);
  }
}

class ViewerClient extends ViewerWebRtcClient {
  private readonly browser: BrowserClient;

  constructor(options: StartOptions) {
    const browser = new BrowserClient(options);
    super({
      socketFactory: browser.socketFactory,
      peerFactory: browser.peerFactory,
      browserSessionToken: options.token,
      deviceId: options.deviceId!,
      loadIceServers: async () => browser.loadIceServers(),
      reconnect: options.reconnectBaseDelayMs === undefined
        ? undefined
        : { baseDelayMs: options.reconnectBaseDelayMs },
    });
    this.browser = browser;
    this.onRemoteTrack = (track) => receiveTrack(track);
  }

  protected override createPeer(
    role: "owner" | "viewer",
    sessionId: string,
    configuration?: WebRtcConfiguration,
  ) {
    try {
      const peer = super.createPeer(role, sessionId, configuration);
      const acceptOffer = peer.acceptOffer.bind(peer);
      peer.acceptOffer = async (sdp, trackMap) => {
        try {
          await acceptOffer(sdp, trackMap);
        } catch (error) {
          lastError = `${error instanceof Error ? error.message : "viewer offer handling failed"}; transceivers: ${this.browser.describeTransceivers()}`;
          throw error;
        }
      };
      return peer;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "viewer peer creation failed";
      throw error;
    }
  }

  get connection(): WebRtcPeerConnection | undefined {
    return this.browser.peerConnection;
  }

  get activeSessionId(): string | null {
    return this.sessionId ?? null;
  }

  forceSocketClose(): void {
    this.socket?.close();
  }

  forceReconnect(): void {
    this.close();
    this.terminal = false;
    window.setTimeout(() => this.start(), 100);
  }
}

function receiveTrack(track: WebRtcTrack): void {
  receivedTracks += 1;
  if (!(track instanceof MediaStreamTrack)) return;
  remoteStream ??= new MediaStream();
  remoteStream.addTrack(track);
  remoteVideo ??= document.createElement("video");
  remoteVideo.autoplay = true;
  remoteVideo.muted = true;
  remoteVideo.playsInline = true;
  remoteVideo.srcObject = remoteStream;
  document.body.append(remoteVideo);
  track.addEventListener("unmute", () => {
    void remoteVideo?.play();
  }, { once: true });
  if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) {
    remoteVideo.requestVideoFrameCallback(() => {
      renderedFrames += 1;
    });
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  message: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function selectedStats(
  peerConnection: WebRtcPeerConnection,
): Promise<StatsSnapshot | null> {
  const report = await (peerConnection as RTCPeerConnection).getStats();
  const candidates = new Map<string, RTCIceCandidateStats>();
  let selectedPair: RTCIceCandidatePairStats | undefined;
  let dtlsState: string | null = null;
  for (const value of report.values()) {
    if (value.type === "local-candidate" || value.type === "remote-candidate") {
      candidates.set(value.id, value as RTCIceCandidateStats);
    } else if (value.type === "candidate-pair" &&
      value.state === "succeeded" &&
      (value.nominated || value.selected)) {
      selectedPair = value as RTCIceCandidatePairStats;
    } else if (value.type === "transport" && value.dtlsState) {
      dtlsState = value.dtlsState;
      if (value.selectedCandidatePairId) {
        const selected = report.get(value.selectedCandidatePairId);
        if (selected?.type === "candidate-pair") {
          selectedPair = selected as RTCIceCandidatePairStats;
        }
      }
    }
  }
  if (!selectedPair) return null;
  const local = candidates.get(selectedPair.localCandidateId);
  const remote = candidates.get(selectedPair.remoteCandidateId);
  return {
    candidateType: local?.candidateType === "relay" || remote?.candidateType === "relay"
      ? "relay" : "direct",
    localCandidateType: local?.candidateType ?? null,
    remoteCandidateType: remote?.candidateType ?? null,
    dtlsState,
  };
}

async function gatheredCandidateTypes(
  peerConnection: WebRtcPeerConnection,
): Promise<string[]> {
  const report = await (peerConnection as RTCPeerConnection).getStats();
  return [...new Set([...report.values()]
    .filter((value) => value.type === "local-candidate" || value.type === "remote-candidate")
    .map((value) => (value as RTCIceCandidateStats).candidateType)
    .filter((value): value is string => typeof value === "string"))];
}

async function start(options: StartOptions): Promise<void> {
  client = options.role === "owner"
    ? new OwnerClient(options)
    : new ViewerClient(options);
  try {
    if (options.role === "viewer") {
      client.start();
    } else {
      await client.start();
    }
  } catch (error) {
    lastError = error instanceof Error ? error.message : "client startup failed";
    throw error;
  }
  try {
    await waitFor(
      () => (client instanceof OwnerClient || client instanceof ViewerClient)
        ? client.connection !== undefined
        : false,
      15_000,
      `${options.role} did not create a peer`,
    );
  } catch (error) {
    const startupError = error instanceof Error ? error.message : `${options.role} did not create a peer`;
    const diagnostic = lastError ?? startupError;
    throw new Error(`${startupError}; ${diagnostic}; ${lastMessageType ? `last signaling message: ${lastMessageType}` : "no signaling message"}`);
  }
  if (client instanceof OwnerClient) {
    await client.attachSyntheticTracks();
  }
}

async function snapshot(): Promise<HarnessSnapshot> {
  const stats = connection ? await selectedStats(connection) : null;
  return {
    lifecycle: client?.lifecycle ?? "IDLE",
    receivedTracks,
    renderedFrames,
    peerConnectionState: connection?.connectionState ?? null,
    iceConnectionState: connection?.iceConnectionState ?? null,
    openSockets: sockets.filter((socket) => socket.readyState === WebSocket.OPEN).length,
    stats,
    gatheredCandidateTypes: connection ? await gatheredCandidateTypes(connection) : [],
    authenticatedSockets,
    authenticated: lastMessageType === "authenticated",
    error: lastError ?? ([
      lastMessageType ? `last signaling message: ${lastMessageType}` : null,
      lastSentType ? `last sent signaling message: ${lastSentType}` : null,
    ].filter((value): value is string => value !== null).join("; ") || null),
    peerConnectionsCreated,
    syntheticTracksAttached,
    sessionId: client instanceof OwnerClient || client instanceof ViewerClient
      ? client.activeSessionId
      : null,
  };
}

function close(): void {
  client?.close();
  for (const socket of sockets) socket.close();
  stopSyntheticMedia();
  remoteVideo?.remove();
  remoteVideo = undefined;
  remoteStream = undefined;
}

function stopSyntheticMedia(): void {
  for (const stream of syntheticStreams) {
    for (const track of stream.getTracks()) track.stop();
  }
  for (const timer of syntheticTimers) window.clearInterval(timer);
  syntheticTimers = [];
  syntheticStreams = [];
}

function forceSocketClose(): void {
  if (client instanceof OwnerClient || client instanceof ViewerClient) {
    client.forceSocketClose();
  }
}

function forceReconnect(): void {
  if (client instanceof OwnerClient || client instanceof ViewerClient) {
    if (client instanceof OwnerClient) stopSyntheticMedia();
    client.forceReconnect();
  }
}

(window as Window & { livePresenceHarness?: Harness }).livePresenceHarness = {
  start: () => {
    const options = (window as Window & { livePresenceOptions?: StartOptions }).livePresenceOptions;
    if (!options) throw new Error("harness options are missing");
    return start(options);
  },
  snapshot,
  close,
  forceSocketClose,
  forceReconnect,
};
