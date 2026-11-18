import { parseClientMessage } from "../../../../shared/src/protocol.js";
import { SignalingPeerGeneration } from "./signaling-peer-generation.js";

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;
type IpcListener = (event: unknown, ...args: unknown[]) => void;

export type SignalingIpcRegistrar = {
  handle(channel: string, handler: IpcHandler): void;
  on(channel: string, listener: IpcListener): void;
};

export type SignalingTransportBoundary = {
  readonly connectionGeneration: number;
  readonly hasAuthenticatedOpenSocket: boolean;
  readonly activeSessionId: string | undefined;
  send(raw: string, expectedGeneration?: number): void;
  close(expectedGeneration?: number, initiatingPath?: string): boolean;
};

export type SignalingIpcDependencies = {
  isSenderAllowed(event: unknown): boolean;
  getTransport(): SignalingTransportBoundary | undefined;
  isSharingActive(): boolean;
  isStopping(): boolean;
  peerGeneration: SignalingPeerGeneration;
  onSendRejected?(raw: unknown, error: unknown): void;
  onClose?(connectionGeneration: number, matchedActiveConnection: boolean): void;
};

export function registerSignalingIpcHandlers(
  ipc: SignalingIpcRegistrar,
  dependencies: SignalingIpcDependencies,
): void {
  ipc.handle("signaling:peer-generation", (event, sessionId, connectionGeneration, ...extra) => {
    if (!dependencies.isSenderAllowed(event) ||
      extra.length > 0 ||
      typeof sessionId !== "string" ||
      sessionId.length === 0 ||
      typeof connectionGeneration !== "number" ||
      !Number.isSafeInteger(connectionGeneration) ||
      connectionGeneration < 0) {
      throw new Error("invalid signaling peer registration request");
    }
    const transport = dependencies.getTransport();
    if (!transport ||
      connectionGeneration !== transport.connectionGeneration ||
      !transport.hasAuthenticatedOpenSocket ||
      !dependencies.isSharingActive() ||
      dependencies.isStopping() ||
      transport.activeSessionId !== sessionId) {
      throw new Error("signaling peer registration is not authorized by the active session");
    }
    return dependencies.peerGeneration.register(connectionGeneration, sessionId, transport);
  });

  ipc.handle("signaling:peer-generation:clear", (event, registrationId, ...extra) => {
    if (!dependencies.isSenderAllowed(event) ||
      extra.length > 0 ||
      typeof registrationId !== "string") {
      throw new Error("invalid signaling peer cleanup request");
    }
    dependencies.peerGeneration.clearRegistration(registrationId);
  });

  ipc.handle("signaling:send", async (event, raw, connectionGeneration, registrationId, ...extra) => {
    if (!dependencies.isSenderAllowed(event) ||
      typeof raw !== "string" ||
      raw.length > 128 * 1024 ||
      typeof connectionGeneration !== "number" ||
      !Number.isSafeInteger(connectionGeneration) ||
      connectionGeneration < 0 ||
      extra.length > 0) {
      throw new Error("invalid signaling IPC request");
    }
    try {
      const parsed = parseClientMessage(JSON.parse(raw));
      if (!parsed || parsed.type === "auth" || parsed.type === "share_request" ||
        parsed.type === "share_request_cancel" || parsed.type === "share_request_decision" ||
        parsed.type === "create_session" || parsed.type === "answer") {
        throw new Error("signaling message is invalid or not allowed");
      }
      const transport = dependencies.getTransport();
      if (!transport) throw new Error("owner signaling transport is unavailable");
      const payload = JSON.stringify(parsed);
      if (parsed.type === "offer" || parsed.type === "ice_candidate") {
        if (typeof registrationId !== "string") {
          throw new Error("signaling peer registration is unavailable");
        }
        await dependencies.peerGeneration.forward(
          connectionGeneration,
          registrationId,
          parsed.session_id,
          transport,
          () => {
            if (dependencies.getTransport() !== transport ||
              transport.connectionGeneration !== connectionGeneration ||
              transport.activeSessionId !== parsed.session_id ||
              !dependencies.isSharingActive() ||
              dependencies.isStopping()) {
              throw new Error("owner signaling transport was superseded");
            }
            transport.send(payload, connectionGeneration);
          },
        );
      } else {
        if (registrationId !== undefined) {
          throw new Error("peer registration is only valid for WebRTC signaling");
        }
        transport.send(payload, connectionGeneration);
        if (parsed.type === "sharing_state" && !parsed.screen) {
          dependencies.peerGeneration.invalidate();
        }
      }
    } catch (error) {
      dependencies.onSendRejected?.(raw, error);
      throw error;
    }
  });

  ipc.on("signaling:close", (event, connectionGeneration, ...extra) => {
    if (!dependencies.isSenderAllowed(event) ||
      extra.length > 0 ||
      typeof connectionGeneration !== "number" ||
      !Number.isSafeInteger(connectionGeneration) ||
      connectionGeneration < 0) return;
    const transport = dependencies.getTransport();
    const matchedActiveConnection = transport?.close(connectionGeneration, "renderer_ipc") ?? false;
    if (matchedActiveConnection && transport) {
      dependencies.peerGeneration.clearConnection(connectionGeneration, transport);
    }
    dependencies.onClose?.(connectionGeneration, matchedActiveConnection);
  });
}
