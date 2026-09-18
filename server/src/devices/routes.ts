import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthService } from "../auth/service.js";
import type { ServerConfig } from "../config.js";
import { DeviceAuthError, DeviceService } from "./service.js";

type EnrollBody = {
  code?: unknown;
  name?: unknown;
  platform?: unknown;
};

type RefreshBody = {
  refreshToken?: unknown;
};

function noStore(reply: FastifyReply): void {
  reply.header("cache-control", "no-store");
  reply.header("referrer-policy", "no-referrer");
}

function browserSession(request: FastifyRequest, auth: AuthService) {
  const token = request.cookies.live_presence_session;
  return token ? auth.getSession(token) : null;
}

export async function registerDeviceRoutes(
  app: FastifyInstance,
  auth: AuthService,
  devices: DeviceService,
  config: ServerConfig,
): Promise<void> {
  app.post("/devices/enrollment-code", async (request, reply) => {
    noStore(reply);
    const user = browserSession(request, auth);
    if (!user) {
      return reply.code(401).send({ error: "not authenticated" });
    }

    const enrollment = devices.createEnrollmentCode(user.id);
    return reply.code(201).send({
      code: enrollment.code,
      expiresInSeconds: config.enrollmentCodeTtlSeconds,
    });
  });

  app.post<{ Body: EnrollBody }>(
    "/devices/enroll",
    async (request, reply) => {
      noStore(reply);
      const { code, name, platform } = request.body ?? {};
      if (
        typeof code !== "string" ||
        typeof name !== "string" ||
        typeof platform !== "string"
      ) {
        return reply.code(401).send({ error: "invalid enrollment" });
      }

      try {
        return reply.code(201).send(
          devices.enrollDevice(code, name, platform),
        );
      } catch (error) {
        if (error instanceof DeviceAuthError) {
          return reply.code(401).send({ error: "invalid enrollment" });
        }
        return reply.code(500).send({ error: "enrollment unavailable" });
      }
    },
  );

  app.post<{ Body: RefreshBody }>(
    "/devices/refresh",
    async (request, reply) => {
      noStore(reply);
      const refreshToken = request.body?.refreshToken;
      if (typeof refreshToken !== "string") {
        return reply.code(401).send({ error: "invalid device credential" });
      }

      try {
        return reply.send(devices.refreshDevice(refreshToken));
      } catch (error) {
        if (error instanceof DeviceAuthError) {
          return reply.code(401).send({ error: "invalid device credential" });
        }
        return reply.code(500).send({ error: "device authentication unavailable" });
      }
    },
  );

  app.delete<{ Params: { deviceId?: string } }>(
    "/devices/:deviceId",
    async (request, reply) => {
      noStore(reply);
      const user = browserSession(request, auth);
      if (!user || !request.params.deviceId) {
        return reply.code(401).send({ error: "invalid device" });
      }

      try {
        devices.revokeDevice(user.id, request.params.deviceId);
        return reply.code(204).send();
      } catch (error) {
        if (error instanceof DeviceAuthError) {
          return reply.code(401).send({ error: "invalid device" });
        }
        return reply.code(500).send({ error: "device revocation unavailable" });
      }
    },
  );
}
