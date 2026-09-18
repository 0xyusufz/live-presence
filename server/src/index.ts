import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

async function start(): Promise<void> {
  const config = loadConfig();
  const app = buildApp();

  try {
    await app.listen({
      host: config.host,
      port: config.port,
    });
  } catch (error) {
    app.log.error(error, "Server failed to start");
    await app.close();
    process.exitCode = 1;
  }
}

void start().catch((error: unknown) => {
  console.error("Server configuration failed", error);
  process.exitCode = 1;
});
