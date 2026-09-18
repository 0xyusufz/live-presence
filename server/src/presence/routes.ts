import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { WebSocket, WebSocketServer } from "ws";
import type { AuthService } from "../auth/service.js";
import { DeviceAuthError, DeviceService } from "../devices/service.js";
import { PresenceService } from "./service.js";
import { ViewerAuthorizationService } from "../authorization/service.js";
import {
  parseClientMessage,
  type ClientMessage,
  type ServerMessage,
} from "../../../shared/src/protocol.js";

const AUTH_TIMEOUT_MS = 5_000;

function noStore(reply: FastifyReply): void {
  reply.header("cache-control", "no-store");
  reply.header("referrer-policy", "no-referrer");
}

function browserUser(request: FastifyRequest, auth: AuthService) {
  const token = request.cookies.live_presence_session;
  return token ? auth.getSession(token) : null;
}

function originAllowed(request: IncomingMessage, allowedOrigin: string): boolean {
  return request.headers.origin === allowedOrigin;
}

export async function registerPresenceRoutes(
  app: FastifyInstance,
  auth: AuthService,
  devices: DeviceService,
  presence: PresenceService,
  authorization: ViewerAuthorizationService,
  allowedOrigin: string,
): Promise<void> {
  app.get("/presence", async (request, reply) => {
    noStore(reply);
    const user = browserUser(request, auth);
    if (!user) {
      return reply.code(401).send({ error: "not authenticated" });
    }

    const devices = presence.getUserPresence(user.id);
    return reply.send({
      devices,
      online: devices.length > 0,
    });
  });

  const webSocketServer = new WebSocketServer({ noServer: true });
  const sockets = new Map<string, WebSocket>();
  type Connection = { socket: WebSocket; userId: string; deviceId?: string; presenceId?: string; role: "owner" | "viewer" };
  type Session = { id: string; owner: Connection; viewer: Connection; deviceId: string; viewerUserId: string; requests: Map<string, "screen" | "camera"> };
  const connections = new Map<WebSocket, Connection>();
  const sessions = new Map<string, Session>();
  const sessionByDevice = new Map<string, string>();
  let serverClosing = false;

  const closeConnection = (connectionId: string): void => {
    const socket = sockets.get(connectionId);
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close(1008, "device revoked");
    }
  };

  const send = (socket: WebSocket, message: ServerMessage | ClientMessage): void => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  const endSession = (sessionId: string, reason: string): void => {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    if (sessionByDevice.get(session.deviceId) === sessionId) sessionByDevice.delete(session.deviceId);
    const left = { type: "viewer_left" as const, session_id: sessionId, viewer_user_id: session.viewerUserId, reason };
    send(session.owner.socket, left);
    send(session.viewer.socket, left);
  };
  authorization.setRevocationHandler((ownerUserId, viewerUserId) => {
    for (const [id, session] of sessions) {
      if (session.owner.userId === ownerUserId && session.viewerUserId === viewerUserId) {
        endSession(id, "authorization_revoked");
      }
    }
  });

  const upgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    const requestUrl = new URL(
      request.url ?? "",
      `http://${request.headers.host ?? "localhost"}`,
    );
    if (
      requestUrl.pathname !== "/ws" ||
      requestUrl.search.length > 0 ||
      !originAllowed(request, allowedOrigin)
    ) {
      socket.destroy();
      return;
    }

    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      webSocketServer.emit("connection", client, request);
    });
  };

  const onConnection = (socket: WebSocket): void => {
    let connectionId: string | undefined;
    let authenticated = false;
    const authTimer = setTimeout(() => {
      if (!authenticated) {
        socket.close(1008, "authentication required");
      }
    }, AUTH_TIMEOUT_MS);

    socket.on("message", (raw) => {
      if (raw.toString().length > 128 * 1024) {
        socket.close(1009, "message too large");
        return;
      }
      let message: ClientMessage | null;
      try {
        message = parseClientMessage(JSON.parse(raw.toString()));
      } catch {
        socket.close(1008, "invalid message");
        return;
      }

      if (!message) {
        socket.close(1008, "invalid message");
        return;
      }
      if (!authenticated) {
        if (
          !message ||
          typeof message !== "object" ||
          message.type !== "auth"
        ) {
          socket.close(1008, "authentication required");
          return;
        }

        try {
          const token = message.token;
          let connection: Connection;
          try {
            const device = devices.authenticateDevice(token);
            const record = presence.connect(device.userId, device.deviceId);
            connectionId = record.connectionId;
            sockets.set(connectionId, socket);
            connection = { socket, userId: device.userId, deviceId: device.deviceId, presenceId: connectionId, role: "owner" };
          } catch (error) {
              const user = auth.getSession(token);
              if (!user) throw new DeviceAuthError("authentication failed");
            connection = { socket, userId: user.id, role: "viewer" };
          }
          connections.set(socket, connection);
          authenticated = true;
          clearTimeout(authTimer);
          send(socket, { type: "authenticated", role: connection.role, ...(connection.deviceId ? { device_id: connection.deviceId } : {}) });
        } catch (error) {
          if (error instanceof DeviceAuthError) {
            socket.close(1008, "authentication failed");
            return;
          }
          socket.close(1011, "authentication unavailable");
        }
        return;
      }

      const connection = connections.get(socket);
      if (!connection || !message || typeof message !== "object") return;
      const type = message.type;
      if (type === "heartbeat" && connection.presenceId) {
        try {
          presence.heartbeat(connection.presenceId);
        } catch {
          socket.close(1008, "connection expired");
        }
      } else if (type === "create_session" && connection.role === "viewer") {
          const deviceId = message.device_id;
          const ownerPresence = presence.getDevicePresence(deviceId);
          if (!ownerPresence || !authorization.canAccess(ownerPresence.userId, connection.userId)) {
            send(socket, { type: "error", code: "NOT_AUTHORIZED" }); return;
          }
          if (sessionByDevice.has(deviceId)) {
            send(socket, { type: "error", code: "DEVICE_BUSY" }); return;
          }
          const owner = [...connections.values()].find((candidate) => candidate.role === "owner" && candidate.deviceId === deviceId);
          if (!owner) { send(socket, { type: "error", code: "DEVICE_OFFLINE" }); return; }
          const sessionId = randomUUID();
          const session = { id: sessionId, owner, viewer: connection, deviceId, viewerUserId: connection.userId, requests: new Map<string, "screen" | "camera">() };
          sessions.set(sessionId, session); sessionByDevice.set(deviceId, sessionId);
          send(socket, { type: "session_created", session_id: sessionId, device_id: deviceId });
          send(owner.socket, { type: "viewer_joined", session_id: sessionId, viewer_user_id: connection.userId });
        } else if (type === "create_session") {
          send(socket, { type: "error", code: "WRONG_ROLE" });
        } else if (type === "leave_session" || type === "offer" || type === "answer" || type === "ice_candidate" || type === "share_request" || type === "share_request_cancel" || type === "share_request_decision") {
          const sessionId = message.session_id;
          const session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
          if (!session || (session.owner.socket !== socket && session.viewer.socket !== socket)) {
            send(socket, { type: "error", code: "NOT_AUTHORIZED" }); return;
          }
          if (!authorization.canAccess(session.owner.userId, session.viewer.userId)) {
            endSession(session.id, "authorization_revoked");
            send(socket, { type: "error", code: "NOT_AUTHORIZED" });
            return;
          }
          if (type === "leave_session") { endSession(session.id, "closed"); return; }
          if (type === "offer" || type === "answer" || type === "ice_candidate") {
            const permitted =
              type === "ice_candidate" ||
              (type === "offer" && session.owner.socket === socket) ||
              (type === "answer" && session.viewer.socket === socket);
            if (!permitted) {
              send(socket, { type: "error", code: "WRONG_ROLE" });
              return;
            }
            const peer = session.owner.socket === socket ? session.viewer.socket : session.owner.socket;
            send(peer, message);
          } else if (type === "share_request" && session.viewer.socket === socket) {
            if (session.requests.has(message.request_id)) {
              send(socket, { type: "error", code: "REQUEST_EXISTS" }); return;
            }
            session.requests.set(message.request_id, message.kind);
            send(session.owner.socket, { type: "share_request", session_id: sessionId, request_id: message.request_id, kind: message.kind, viewer_user_id: connection.userId });
          } else if (type === "share_request_cancel" && session.viewer.socket === socket) {
            send(session.owner.socket, message);
            const kind = session.requests.get(message.request_id);
            session.requests.delete(message.request_id);
            if (kind) send(session.viewer.socket, { type: "share_request_state", session_id: sessionId, request_id: message.request_id, kind, state: "CANCELLED" });
          } else if (type === "share_request_decision" && session.owner.socket === socket) {
            const kind = session.requests.get(message.request_id);
            if (!kind) { send(socket, { type: "error", code: "REQUEST_NOT_FOUND" }); return; }
            session.requests.delete(message.request_id);
            send(session.viewer.socket, { type: "share_request_state", session_id: sessionId, request_id: message.request_id, kind, state: message.decision === "allow" ? "ALLOWED" : "DENIED" });
          }
      }
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      if (connectionId) {
        sockets.delete(connectionId);
        presence.disconnect(connectionId);
      }
      const connection = connections.get(socket);
      if (connection) {
        for (const [id, session] of sessions) {
          if (session.owner.socket === socket || session.viewer.socket === socket) endSession(id, "closed");
        }
        connections.delete(socket);
      }
    });
    socket.on("error", () => {
      socket.close();
    });
  };

  presence.setConnectionCloser(closeConnection);
  webSocketServer.on("connection", onConnection);
  app.server.on("upgrade", upgrade);
  webSocketServer.on("close", () => {
    serverClosing = true;
  });
  app.addHook("onClose", async () => {
    if (serverClosing) {
      return;
    }
    serverClosing = true;
    app.server.off("upgrade", upgrade);
    for (const socket of sockets.values()) {
      socket.close(1001, "server shutting down");
    }
    webSocketServer.close();
    presence.close();
  });
}
