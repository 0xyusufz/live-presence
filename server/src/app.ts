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
import { TurnService } from "./turn/service.js";
import { registerTurnRoutes } from "./turn/routes.js";

export async function buildApp(
  databasePath = ":memory:",
  sessionTtlSeconds = 30 * 24 * 60 * 60,
  nodeEnv: ServerConfig["nodeEnv"] = "test",
  delivery?: LoginLinkDelivery,
  enrollmentCodeTtlSeconds = 600,
  presenceStaleThresholdSeconds = 45,
  webOrigin = "http://localhost:5173",
  cloudflareTurnKeyId = "development-turn-key-id",
  cloudflareTurnApiToken = "development-turn-api-token",
  stunUrls = [] as string[],
  turnCredentialTtlSeconds = 86_400,
  turnFetch?: typeof fetch,
  networkRecoveryGraceMs = 180_000,
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
  const turn = new TurnService({
    keyId: cloudflareTurnKeyId,
    apiToken: cloudflareTurnApiToken,
    ttlSeconds: turnCredentialTtlSeconds,
    fetch: turnFetch,
  });
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
      cloudflareTurnKeyId,
      cloudflareTurnApiToken,
      stunUrls,
      turnCredentialTtlSeconds,
      networkRecoveryGraceMs,
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
      cloudflareTurnKeyId,
      cloudflareTurnApiToken,
      stunUrls,
      turnCredentialTtlSeconds,
      networkRecoveryGraceMs,
    },
  );
  await registerPresenceRoutes(
    app,
    auth,
    deviceService,
    presenceService,
    authorization,
    webOrigin,
    networkRecoveryGraceMs,
  );
  await registerTurnRoutes(app, auth, deviceService, turn);

  return {
    app,
    authorization,
    close: database.close,
  };
}
