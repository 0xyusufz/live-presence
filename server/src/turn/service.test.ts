import assert from "node:assert/strict";
import { test } from "node:test";
import { TurnProviderError, TurnService } from "./service.js";

const response = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 201,
    headers: { "content-type": "application/json" },
    ...init,
  });

test("Cloudflare credentials use the documented endpoint, headers, and TTL", async () => {
  let request: Request | undefined;
  const service = new TurnService({
    keyId: "turn-key",
    apiToken: "api-token",
    ttlSeconds: 86_400,
    now: () => 1_700_000_000_000,
    fetch: async (input, init) => {
      request = new Request(input, init);
      return response({
        iceServers: [
          { urls: ["stun:stun.cloudflare.com:3478"] },
          {
            urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
            username: "temporary-user",
            credential: "temporary-credential",
          },
        ],
      });
    },
  });

  const result = await service.issue();
  assert.equal(request?.url, "https://rtc.live.cloudflare.com/v1/turn/keys/turn-key/credentials/generate-ice-servers");
  assert.equal(request?.method, "POST");
  assert.equal(request?.headers.get("authorization"), "Bearer api-token");
  assert.equal(request?.headers.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(await request!.text()), { ttl: 86_400 });
  assert.equal(result.expiresAt, 1_700_086_400);
  assert.equal(result.iceServers[1]?.credential, "temporary-credential");
  assert.equal(JSON.stringify(result).includes("api-token"), false);
});

test("Cloudflare HTTP failures, network failures, timeouts, and malformed responses are redacted", async () => {
  const cases: Array<typeof fetch> = [
    async () => response({ secret: "upstream-body" }, { status: 500 }),
    async () => { throw new Error("network secret"); },
    async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
    async () => response({ iceServers: [{ urls: ["https://unexpected.example"] }] }),
  ];

  for (const fetch of cases) {
    const service = new TurnService({
      keyId: "key",
      apiToken: "permanent-secret",
      ttlSeconds: 60,
      timeoutMs: 5,
      fetch,
    });
    await assert.rejects(() => service.issue(), (error: unknown) => {
      assert.equal(error instanceof TurnProviderError, true);
      assert.equal((error as Error).message, "TURN provider unavailable");
      assert.equal((error as Error).message.includes("secret"), false);
      return true;
    });
  }
});

test("TURN entries require temporary credentials and valid server URLs", async () => {
  const service = new TurnService({
    keyId: "key",
    apiToken: "token",
    ttlSeconds: 60,
    fetch: async () => response({
      iceServers: [{ urls: ["turn:turn.cloudflare.com:3478"] }],
    }),
  });
  await assert.rejects(() => service.issue(), TurnProviderError);
});
