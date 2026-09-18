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

export async function buildApp(
  databasePath = ":memory:",
  sessionTtlSeconds = 30 * 24 * 60 * 60,
  nodeEnv: ServerConfig["nodeEnv"] = "test",
  delivery?: LoginLinkDelivery,
): Promise<{ app: FastifyInstance; close: () => void }> {
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

  await app.register(cookie);

  app.get("/healthz", async () => ({
    status: "ok",
  }));
  await registerAuthRoutes(
    app,
    auth,
    {
      databasePath,
      host: "127.0.0.1",
      nodeEnv,
      port: 0,
      sessionTtlSeconds,
    },
  );

  return {
    app,
    close: database.close,
  };
}
