import assert from "node:assert/strict";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { test } from "node:test";
import { registerTurnRoutes } from "./routes.js";
import { TurnProviderError, type TurnService } from "./service.js";

function fakeAuth(sessionUserId?: string) {
  return { getSession: () => sessionUserId ? { id: sessionUserId } : null } as never;
}

function fakeDevices(deviceUserId?: string) {
  return {
    authenticateDevice: () => {
      if (!deviceUserId) throw new Error("invalid");
      return { userId: deviceUserId };
    },
  } as never;
}

function fakeTurn() {
  return {
    issue: async () => ({
      iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }],
      expiresAt: 1_700_000_060,
    }),
  } as unknown as TurnService;
}

test("TURN route supports browser sessions and device bearer authentication", async () => {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await registerTurnRoutes(app, fakeAuth("browser-user"), fakeDevices("device-user"), fakeTurn());

  const browser = await app.inject({
    method: "GET",
    url: "/webrtc/ice-servers",
    headers: { cookie: "live_presence_session=session" },
  });
  assert.equal(browser.statusCode, 200);
  assert.equal(browser.headers["cache-control"], "no-store");
  assert.equal(browser.headers["referrer-policy"], "no-referrer");

  const device = await app.inject({
    method: "GET",
    url: "/webrtc/ice-servers",
    headers: { authorization: "Bearer refresh-token" },
  });
  assert.equal(device.statusCode, 200);
  await app.close();
});

test("TURN route rejects unauthenticated requests and hides provider failures", async () => {
  const app = Fastify({ logger: false });
  await app.register(cookie);
  await registerTurnRoutes(app, fakeAuth(), fakeDevices(), {
    issue: async () => { throw new TurnProviderError(); },
  } as unknown as TurnService);

  const unauthenticated = await app.inject({
    method: "GET",
    url: "/webrtc/ice-servers",
  });
  assert.equal(unauthenticated.statusCode, 401);
  await app.close();

  const unavailableApp = Fastify({ logger: false });
  await unavailableApp.register(cookie);
  await registerTurnRoutes(unavailableApp, fakeAuth("browser-user"), fakeDevices(), {
    issue: async () => { throw new TurnProviderError(); },
  } as unknown as TurnService);
  const unavailable = await unavailableApp.inject({
    method: "GET",
    url: "/webrtc/ice-servers",
    headers: { cookie: "live_presence_session=session" },
  });
  assert.equal(unavailable.statusCode, 503);
  assert.deepEqual(unavailable.json(), { error: "TURN service unavailable" });
  await unavailableApp.close();
});
