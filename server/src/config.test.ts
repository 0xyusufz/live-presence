import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "./config.js";

test("loadConfig accepts valid environment values", () => {
  const config = loadConfig({
    DATABASE_PATH: ":memory:",
    HOST: "127.0.0.1",
    NODE_ENV: "test",
    PORT: "4317",
    SESSION_TTL_SECONDS: "3600",
  });

  assert.deepEqual(config, {
    databasePath: ":memory:",
    host: "127.0.0.1",
    nodeEnv: "test",
    port: 4317,
    enrollmentCodeTtlSeconds: 600,
    presenceStaleThresholdSeconds: 45,
    sessionTtlSeconds: 3600,
    webOrigin: "http://localhost:5173",
  });
});

test("loadConfig rejects invalid environment values", () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: "invalid" }),
    /NODE_ENV must be development, test, or production/,
  );
  assert.throws(
    () => loadConfig({ PORT: "0" }),
    /PORT must be an integer between 1 and 65535/,
  );
  assert.throws(
    () => loadConfig({ SESSION_TTL_SECONDS: "0" }),
    /SESSION_TTL_SECONDS must be a positive integer/,
  );
  assert.throws(
    () => loadConfig({ ENROLLMENT_CODE_TTL_SECONDS: "0" }),
    /ENROLLMENT_CODE_TTL_SECONDS must be a positive integer/,
  );
  assert.throws(
    () => loadConfig({ PRESENCE_STALE_THRESHOLD_SECONDS: "0" }),
    /PRESENCE_STALE_THRESHOLD_SECONDS must be a positive integer/,
  );
  assert.throws(
    () => loadConfig({ HOST: " " }),
    /HOST must be a non-empty string/,
  );
});
