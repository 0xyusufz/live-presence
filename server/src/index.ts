import { buildApp } from "./app.js";
import { loadConfig, resolveDatabasePath } from "./config.js";

async function start(): Promise<void> {
  const config = loadConfig();
  const server = await buildApp(
    resolveDatabasePath(config.databasePath),
    config.sessionTtlSeconds,
    config.nodeEnv,
    undefined,
    config.enrollmentCodeTtlSeconds,
    config.presenceStaleThresholdSeconds,
    config.webOrigin,
    config.cloudflareTurnKeyId,
    config.cloudflareTurnApiToken,
    config.stunUrls,
    config.turnCredentialTtlSeconds,
    undefined,
    config.networkRecoveryGraceMs,
  );

  try {
    await server.app.listen({
      host: config.host,
      port: config.port,
    });
  } catch (error) {
    server.app.log.error(error, "Server failed to start");
    await server.app.close();
    server.close();
    process.exitCode = 1;
  }
}

void start().catch((error: unknown) => {
  console.error("Server configuration failed", error);
  process.exitCode = 1;
});
