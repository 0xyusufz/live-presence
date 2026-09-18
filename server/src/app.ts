import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { createDatabase } from "./db/index.js";
import { registerAuthRoutes } from "./auth/routes.js";
import {
  AuthService,
  DevelopmentLoginLinkDelivery,
  type LoginLinkDelivery,
} from "./auth/service.js";
import type { ServerConfig } from "./config.js";
import { registerDeviceRoutes } from "./devices/routes.js";
import { DeviceService } from "./devices/service.js";
import { registerPresenceRoutes } from "./presence/routes.js";
import { PresenceService } from "./presence/service.js";
import { ViewerAuthorizationService } from "./authorization/service.js";

export async function buildApp(
  databasePath = ":memory:",
  sessionTtlSeconds = 30 * 24 * 60 * 60,
  nodeEnv: ServerConfig["nodeEnv"] = "test",
  delivery?: LoginLinkDelivery,
  enrollmentCodeTtlSeconds = 600,
  presenceStaleThresholdSeconds = 45,
  webOrigin = "http://localhost:5173",
): Promise<{
  app: FastifyInstance;
  authorization: ViewerAuthorizationService;
  close: () => void;
}> {
  if (nodeEnv === "production" && !delivery) {
    throw new Error("Production login-link delivery is not configured");
  }

  const app = Fastify({
    logger: false,
  });
  const database = createDatabase(databasePath);
  const auth = new AuthService(database.db, {
    delivery: delivery ?? new DevelopmentLoginLinkDelivery(),
    sessionTtlSeconds,
  });
  const presenceService = new PresenceService({
    staleThresholdSeconds: presenceStaleThresholdSeconds,
  });
  const authorization = new ViewerAuthorizationService(database.db);
  const deviceService = new DeviceService(database.db, {
    enrollmentCodeTtlSeconds,
    onDeviceRevoked: (deviceId) => presenceService.revokeDevice(deviceId),
    onDeviceFamilyRevoked: (deviceId) => presenceService.revokeDevice(deviceId),
  });

  await app.register(cookie);

  app.get("/healthz", async () => ({
    status: "ok",
  }));
  await registerAuthRoutes(
    app,
    auth,
    {
      databasePath,
      enrollmentCodeTtlSeconds,
      host: "127.0.0.1",
      nodeEnv,
      port: 0,
      presenceStaleThresholdSeconds,
      sessionTtlSeconds,
      webOrigin,
    },
  );
  await registerDeviceRoutes(
    app,
    auth,
    deviceService,
    {
      databasePath,
      enrollmentCodeTtlSeconds,
      host: "127.0.0.1",
      nodeEnv,
      port: 0,
      presenceStaleThresholdSeconds,
      sessionTtlSeconds,
      webOrigin,
    },
  );
  await registerPresenceRoutes(
    app,
    auth,
    deviceService,
    presenceService,
    authorization,
    webOrigin,
  );

  return {
    app,
    authorization,
    close: database.close,
  };
}
