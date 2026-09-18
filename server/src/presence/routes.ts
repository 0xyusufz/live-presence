import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { WebSocket, WebSocketServer } from "ws";
import type { AuthService } from "../auth/service.js";
import { DeviceAuthError, DeviceService } from "../devices/service.js";
import { PresenceService } from "./service.js";

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
  let serverClosing = false;

  const closeConnection = (connectionId: string): void => {
    const socket = sockets.get(connectionId);
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close(1008, "device revoked");
    }
  };

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
      let message: unknown;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        socket.close(1008, "invalid message");
        return;
      }

      if (!authenticated) {
        if (
          !message ||
          typeof message !== "object" ||
          (message as { type?: unknown }).type !== "auth" ||
          typeof (message as { token?: unknown }).token !== "string"
        ) {
          socket.close(1008, "authentication required");
          return;
        }

        try {
          const device = devices.authenticateDevice(
            (message as { token: string }).token,
          );
          const record = presence.connect(device.userId, device.deviceId);
          connectionId = record.connectionId;
          sockets.set(connectionId, socket);
          authenticated = true;
          clearTimeout(authTimer);
          socket.send(JSON.stringify({ type: "authenticated" }));
        } catch (error) {
          if (error instanceof DeviceAuthError) {
            socket.close(1008, "authentication failed");
            return;
          }
          socket.close(1011, "authentication unavailable");
        }
        return;
      }

      if (
        message &&
        typeof message === "object" &&
        (message as { type?: unknown }).type === "heartbeat" &&
        connectionId
      ) {
        try {
          presence.heartbeat(connectionId);
        } catch {
          socket.close(1008, "connection expired");
        }
      }
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      if (connectionId) {
        sockets.delete(connectionId);
        presence.disconnect(connectionId);
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
