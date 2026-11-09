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

  assert.equal(config.stunUrls[0], "stun:stun.l.google.com:19302");
  assert.equal(config.cloudflareTurnKeyId, "development-turn-key-id");
  assert.equal(config.cloudflareTurnApiToken, "development-turn-api-token");
  assert.equal(config.turnCredentialTtlSeconds, 86_400);
  assert.equal(config.sessionTtlSeconds, 3600);
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
  assert.throws(
    () => loadConfig({ STUN_URLS: "https://example.test" }),
    /STUN_URLS contains an invalid URL/,
  );
  assert.throws(
    () => loadConfig({ STUN_URLS: "stun:example.test?secret=1" }),
    /STUN_URLS contains an invalid URL/,
  );
});

test("loadConfig supports STUN and TURN overrides", () => {
  const config = loadConfig({
    NODE_ENV: "test",
    STUN_URLS: "stun:one.test:3478, stuns:two.test:5349",
    CLOUDFLARE_TURN_KEY_ID: "key-id",
    CLOUDFLARE_TURN_API_TOKEN: "api-token",
    TURN_CREDENTIAL_TTL_SECONDS: "7200",
  });
  assert.deepEqual(config.stunUrls, ["stun:one.test:3478", "stuns:two.test:5349"]);
  assert.equal(config.cloudflareTurnKeyId, "key-id");
  assert.equal(config.cloudflareTurnApiToken, "api-token");
  assert.equal(config.turnCredentialTtlSeconds, 7200);
});

test("loadConfig requires Cloudflare TURN credentials in production", () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: "production" }),
    /CLOUDFLARE_TURN_KEY_ID must be a non-empty string/,
  );
  assert.throws(
    () => loadConfig({
      NODE_ENV: "production",
      CLOUDFLARE_TURN_KEY_ID: "key-id",
    }),
    /CLOUDFLARE_TURN_API_TOKEN must be a non-empty string/,
  );
});
