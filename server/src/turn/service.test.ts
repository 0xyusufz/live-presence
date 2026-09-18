import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { TurnService } from "./service.js";

test("TURN credentials are ephemeral HMAC credentials and do not expose the secret", () => {
  const service = new TurnService({
    sharedSecret: "secret",
    urls: ["turn:example.test:3478"],
    ttlSeconds: 600,
    now: () => 1_700_000_000_000,
  });
  const result = service.issue("user-id");
  const username = "1700000600:user-id";
  assert.equal(result.expiresAt, 1_700_000_600);
  assert.equal(result.iceServers[0]?.username, username);
  assert.equal(
    result.iceServers[0]?.credential,
    createHmac("sha1", "secret").update(username).digest("base64"),
  );
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("TURN credential expiry is based on issuance time", () => {
  const service = new TurnService({
    sharedSecret: "secret",
    urls: ["turn:example.test:3478"],
    ttlSeconds: 60,
    now: () => 1_700_000_001_999,
  });
  assert.equal(service.issue("user-id").expiresAt, 1_700_000_061);
});
