import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthService } from "../auth/service.js";
import type { DeviceService } from "../devices/service.js";
import { DeviceAuthError } from "../devices/service.js";
import { TurnService } from "./service.js";

function noStore(reply: FastifyReply): void {
  reply.header("cache-control", "no-store");
  reply.header("referrer-policy", "no-referrer");
}

export async function registerTurnRoutes(
  app: FastifyInstance,
  auth: AuthService,
  devices: DeviceService,
  turn: TurnService,
): Promise<void> {
  app.get("/webrtc/ice-servers", async (request: FastifyRequest, reply) => {
    noStore(reply);
    const browserToken = request.cookies.live_presence_session;
    const authorization = request.headers.authorization;
    const bearer = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : undefined;
    const browserUser = browserToken ? auth.getSession(browserToken) : null;
    let userId = browserUser?.id;
    if (!userId && bearer) {
      try {
        userId = devices.authenticateDevice(bearer).userId;
      } catch (error) {
        if (!(error instanceof DeviceAuthError)) {
          return reply.code(500).send({ error: "TURN configuration unavailable" });
        }
      }
    }
    if (!userId) return reply.code(401).send({ error: "not authenticated" });
    return reply.send(turn.issue(userId));
  });
}
