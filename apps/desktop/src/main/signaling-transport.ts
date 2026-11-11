import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { parseClientMessage, parseServerMessage, type ClientMessage } from "../../../../shared/src/protocol.js";
import type { WebRtcConfiguration } from "../../../../shared/src/webrtc.js";
import type { SocketEvent } from "../ipc-contract.js";

type EventSink = (event: SocketEvent) => void;
type HeartbeatScheduler = (callback: () => void, delayMs: number) => () => void;

export interface DeviceCredentialLoader {
  load(): Promise<string | null>;
}

export class MainSignalingTransport {
  private socket: WebSocket | undefined;
  private stopHeartbeat: (() => void) | undefined;
  private authenticated = false;
  private connectInFlight: Promise<void> | undefined;
  private generation = 0;
  private authenticatedDeviceId: string | undefined;
  private lastHeartbeatAckAt = 0;
  private heartbeatSentCount = 0;
  private heartbeatAckCount = 0;
  private activeSessionId: string | undefined;

  get deviceId(): string | undefined { return this.authenticatedDeviceId; }

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
  ) {}

  async connect(): Promise<void> {
    if (this.socket) return;
    if (this.connectInFlight) return this.connectInFlight;
    const generation = this.generation;
    const pending = this.openSocket(generation);
    this.connectInFlight = pending;
    try {
      await pending;
    } finally {
      if (this.connectInFlight === pending) this.connectInFlight = undefined;
    }
  }

  private async openSocket(generation: number): Promise<void> {
    const token = await this.credentials.load();
    if (!token) throw new Error("device is not enrolled");
    if (generation !== this.generation) return;
    const wsUrl = new URL("/ws", this.apiUrl);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(wsUrl, {
      origin: this.webOrigin,
      handshakeTimeout: 10_000,
      maxPayload: 128 * 1024,
    });
    this.socket = socket;
    socket.once("open", () => {
      if (this.socket !== socket) return;
      socket.send(JSON.stringify({ type: "auth", token }));
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
          this.stopHeartbeatFor(socket);
          socket.close(1008, "wrong account role");
          return;
        }
        this.authenticated = true;
        this.authenticatedDeviceId = message.device_id;
        this.lastHeartbeatAckAt = this.now();
        this.heartbeatSentCount = 0;
        this.heartbeatAckCount = 0;
        console.info(JSON.stringify({
          source: "desktop-main",
          event: "signaling-authenticated",
          deviceId: this.authenticatedDeviceId,
          signalingState: "open",
        }));
        this.emit({ type: "open" });
        if (!this.stopHeartbeat) {
          this.stopHeartbeat = this.scheduleHeartbeat(() => {
            if (this.socket === socket && this.authenticated && socket.readyState === WebSocket.OPEN) {
              if (this.now() - this.lastHeartbeatAckAt >= this.heartbeatIntervalMs * 2) {
                console.warn(JSON.stringify({
                  source: "desktop-main",
                  event: "signaling-heartbeat-timeout",
                  deviceId: this.authenticatedDeviceId,
                  signalingState: "open",
                  sent: false,
                  category: "signaling-timeout",
                  sessionId: this.activeSessionId,
                  heartbeatSentCount: this.heartbeatSentCount,
                  heartbeatAckCount: this.heartbeatAckCount,
                  lastHeartbeatAckAgeMs: this.now() - this.lastHeartbeatAckAt,
                  recoveryAttemptId: randomUUID(),
                }));
                socket.terminate();
                return;
              }
              try {
                socket.send(JSON.stringify({ type: "heartbeat" }));
                this.heartbeatSentCount += 1;
                console.debug(JSON.stringify({
                  source: "desktop-main",
                  event: "signaling-heartbeat-sent",
                  deviceId: this.authenticatedDeviceId,
                  sessionId: this.activeSessionId,
                  signalingState: "open",
                  heartbeatSentCount: this.heartbeatSentCount,
                }));
              } catch {
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
        console.info(JSON.stringify({
          source: "desktop-main",
          event: "signaling-heartbeat-ack-received",
          deviceId: this.authenticatedDeviceId,
          sessionId: this.activeSessionId,
          signalingState: "open",
          heartbeatAckCount: this.heartbeatAckCount,
          heartbeatAckIntervalMs: previousAckAt ? this.lastHeartbeatAckAt - previousAckAt : undefined,
        }));
      }
      if (message.type === "viewer_joined" || message.type === "session_recovery") {
        this.activeSessionId = message.session_id;
      }
      this.emit({ type: "message", data: JSON.stringify(message) });
    });
    socket.once("error", () => {
      if (this.socket === socket) this.emit({ type: "error", message: "signaling connection failed" });
    });
    socket.once("close", (code) => {
      if (this.socket !== socket) return;
      console.warn(JSON.stringify({
        source: "desktop-main",
        event: "signaling-socket-closed",
        deviceId: this.authenticatedDeviceId,
        sessionId: this.activeSessionId,
        signalingState: "closed",
        closeCode: code,
        authenticated: this.authenticated,
        heartbeatSentCount: this.heartbeatSentCount,
        heartbeatAckCount: this.heartbeatAckCount,
        lastHeartbeatAckAgeMs: this.lastHeartbeatAckAt
          ? this.now() - this.lastHeartbeatAckAt
          : undefined,
      }));
      this.cleanup(socket);
      this.emit({ type: "close", code });
    });
  }

  send(raw: string): void {
    const socket = this.socket;
    if (!socket || !this.authenticated || socket.readyState !== WebSocket.OPEN) {
      throw new Error("signaling socket is not open");
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("invalid signaling message");
    }
    const message = parseClientMessage(value);
    if (!message || !this.allowedOwnerMessage(message)) throw new Error("signaling message is not allowed");
    socket.send(JSON.stringify(message));
    if (message.type === "sharing_state") {
      console.info(JSON.stringify({
        source: "desktop-main",
        event: "sharing-state-written-to-websocket",
        deviceId: this.authenticatedDeviceId,
        signalingState: "open",
        sharingState: { screen: message.screen, camera: message.camera },
        sent: true,
      }));
      if (!message.screen) this.activeSessionId = undefined;
    }
    if (message.type === "offer" || message.type === "ice_candidate") {
      this.activeSessionId = message.session_id;
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

  close(): void {
    this.generation += 1;
    this.connectInFlight = undefined;
    const socket = this.socket;
    if (socket) {
      this.cleanup(socket);
      socket.close();
      this.emit({ type: "close", code: 1000 });
    }
  }

  private cleanup(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.stopHeartbeatFor(socket);
    this.authenticated = false;
    this.authenticatedDeviceId = undefined;
    this.lastHeartbeatAckAt = 0;
    this.activeSessionId = undefined;
    this.socket = undefined;
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
