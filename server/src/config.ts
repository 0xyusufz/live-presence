export type ServerConfig = {
  databasePath: string;
  host: string;
  nodeEnv: "development" | "test" | "production";
  port: number;
  enrollmentCodeTtlSeconds: number;
  presenceStaleThresholdSeconds: number;
  sessionTtlSeconds: number;
  webOrigin: string;
  cloudflareTurnKeyId: string;
  cloudflareTurnApiToken: string;
  stunUrls: string[];
  turnCredentialTtlSeconds: number;
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

function positiveInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: string,
): number {
  const value = Number(environment[name] ?? fallback);

  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
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

const DEFAULT_STUN_URLS = ["stun:stun.l.google.com:19302"];

function iceUrls(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: string[],
  allowedSchemes: readonly string[],
): string[] {
  const values = (environment[name] ?? fallback.join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) throw new Error(`${name} must contain at least one URL`);
  for (const value of values) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error(`${name} contains an invalid URL`);
    }
    if (!allowedSchemes.includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error(`${name} contains an invalid URL`);
    }
  }
  return values;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const nodeEnv = nodeEnvironment(environment);
  const stunUrls = iceUrls(environment, "STUN_URLS", DEFAULT_STUN_URLS, ["stun:", "stuns:"]);
  const cloudflareTurnKeyId = requiredString(
    environment,
    "CLOUDFLARE_TURN_KEY_ID",
    nodeEnv === "production" ? undefined : "development-turn-key-id",
  );
  const cloudflareTurnApiToken = requiredString(
    environment,
    "CLOUDFLARE_TURN_API_TOKEN",
    nodeEnv === "production" ? undefined : "development-turn-api-token",
  );
  return {
    databasePath: requiredString(
      environment,
      "DATABASE_PATH",
      "./data/live-presence.db",
    ),
    host: requiredString(environment, "HOST", "127.0.0.1"),
    nodeEnv,
    port: portValue(environment),
    enrollmentCodeTtlSeconds: positiveInteger(
      environment,
      "ENROLLMENT_CODE_TTL_SECONDS",
      "600",
    ),
    presenceStaleThresholdSeconds: positiveInteger(
      environment,
      "PRESENCE_STALE_THRESHOLD_SECONDS",
      "45",
    ),
    sessionTtlSeconds: positiveInteger(
      environment,
      "SESSION_TTL_SECONDS",
      String(30 * 24 * 60 * 60),
    ),
    webOrigin: requiredString(
      environment,
      "WEB_ORIGIN",
      "http://localhost:5173",
    ),
    cloudflareTurnKeyId,
    cloudflareTurnApiToken,
    stunUrls,
    turnCredentialTtlSeconds: positiveInteger(
      environment,
      "TURN_CREDENTIAL_TTL_SECONDS",
      "86400",
    ),
  };
}
