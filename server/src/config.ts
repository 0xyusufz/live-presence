export type ServerConfig = {
  host: string;
  nodeEnv: "development" | "test" | "production";
  port: number;
};

const nodeEnvironments = new Set<ServerConfig["nodeEnv"]>([
  "development",
  "test",
  "production",
]);

function requiredString(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback?: string,
): string {
  const value = environment[name] ?? fallback;

  if (!value || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }

  return value.trim();
}

function portValue(environment: NodeJS.ProcessEnv): number {
  const rawPort = environment.PORT ?? "3000";
  const port = Number(rawPort);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  return port;
}

function nodeEnvironment(
  environment: NodeJS.ProcessEnv,
): ServerConfig["nodeEnv"] {
  const value = environment.NODE_ENV ?? "development";

  if (!nodeEnvironments.has(value as ServerConfig["nodeEnv"])) {
    throw new Error("NODE_ENV must be development, test, or production");
  }

  return value as ServerConfig["nodeEnv"];
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  return {
    host: requiredString(environment, "HOST", "127.0.0.1"),
    nodeEnv: nodeEnvironment(environment),
    port: portValue(environment),
  };
}
