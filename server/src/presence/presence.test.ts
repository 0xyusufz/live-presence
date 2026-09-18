import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocket } from "ws";
import { buildApp } from "../app.js";
import { PresenceService } from "./service.js";

function cookieValue(value: string | string[] | undefined): string {
  assert.ok(value);
  return (Array.isArray(value) ? value[0] : value).split(";")[0]!;
}

function waitForClose(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    socket.once("close", (code) => resolve(code));
    socket.once("error", () => undefined);
  });
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once("message", (raw) => resolve(JSON.parse(raw.toString()) as Record<string, unknown>));
    socket.once("error", reject);
  });
}

async function createDevice(
  server: Awaited<ReturnType<typeof buildApp>>,
): Promise<{ deviceId: string; refreshToken: string; cookie: string }> {
  const login = await server.app.inject({
    method: "POST",
    url: "/auth/request-login",
    payload: { email: `presence-${Date.now()}@example.com` },
  });
  const { developmentToken } = login.json<{ developmentToken: string }>();
  const verification = await server.app.inject({
    method: "POST",
    url: "/auth/verify-login",
    payload: { token: developmentToken },
  });
  const cookie = cookieValue(verification.headers["set-cookie"]);
  const codeResponse = await server.app.inject({
    method: "POST",
    url: "/devices/enrollment-code",
    headers: { cookie },
  });
  const { code } = codeResponse.json<{ code: string }>();
  const enrolled = await server.app.inject({
    method: "POST",
    url: "/devices/enroll",
    payload: { code, name: "Presence laptop", platform: "macOS" },
  });
  return { ...enrolled.json(), cookie };
}

test("presence service distinguishes connections and expires at the threshold", () => {
  let now = 1_700_000_000_000;
  const presence = new PresenceService({
    now: () => now,
    staleThresholdSeconds: 10,
  });

  const first = presence.connect("user-a", "device-a");
  const second = presence.connect("user-a", "device-a");
  assert.equal(presence.getUserPresence("user-a").length, 1);
  presence.disconnect(first.connectionId);
  assert.equal(presence.getUserPresence("user-a").length, 1);
  presence.disconnect(second.connectionId);
  assert.deepEqual(presence.getUserPresence("user-a"), []);

  const deviceA = presence.connect("user-a", "device-a");
  const deviceB = presence.connect("user-a", "device-b");
  assert.equal(presence.getUserPresence("user-a").length, 2);
  presence.disconnect(deviceA.connectionId);
  assert.equal(presence.getUserPresence("user-a").length, 1);
  assert.equal(presence.getUserPresence("user-a")[0]!.deviceId, "device-b");

  now += 10_000;
  assert.deepEqual(presence.getUserPresence("user-a"), []);
  presence.close();
});

test("presence service removes every connection for a revoked device", () => {
  const closed: string[] = [];
  const presence = new PresenceService({
    closeConnection: (connectionId) => closed.push(connectionId),
    staleThresholdSeconds: 45,
  });
  const first = presence.connect("user-a", "device-a");
  const second = presence.connect("user-a", "device-a");
  presence.connect("user-a", "device-b");

  presence.revokeDevice("device-a");

  assert.deepEqual(closed.sort(), [first.connectionId, second.connectionId].sort());
  assert.deepEqual(
    presence.getUserPresence("user-a").map((record) => record.deviceId),
    ["device-b"],
  );
  presence.close();
});

test("websocket requires origin and first-frame device authentication", async () => {
  const server = await buildApp(":memory:", 3600, "test", undefined, 600, 45);
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  const address = server.app.server.address();
  assert.ok(address && typeof address !== "string");
  const url = `ws://127.0.0.1:${address.port}/ws`;

  try {
    const wrongOrigin = new WebSocket(url, { origin: "https://wrong.example" });
    assert.equal(await waitForClose(wrongOrigin), 1006);

    const socket = new WebSocket(url, { origin: "http://localhost:5173" });
    await waitForOpen(socket);
    socket.send(JSON.stringify({ type: "auth", token: "invalid-token" }));
    assert.equal(await waitForClose(socket), 1008);

    const queryToken = new WebSocket(
      `${url}?token=raw-token`,
      { origin: "http://localhost:5173" },
    );
    assert.equal(await waitForClose(queryToken), 1006);

    const noAuth = new WebSocket(url, { origin: "http://localhost:5173" });
    await waitForOpen(noAuth);
    assert.equal(await waitForClose(noAuth), 1008);
  } finally {
    await server.app.close();
    server.close();
  }
});

test("valid websocket authentication registers and close removes presence", async () => {
  const server = await buildApp(":memory:", 3600, "test", undefined, 600, 45);
  const device = await createDevice(server);
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  const address = server.app.server.address();
  assert.ok(address && typeof address !== "string");
  const socket = new WebSocket(
    `ws://127.0.0.1:${address.port}/ws`,
    { origin: "http://localhost:5173" },
  );

  try {
    await waitForOpen(socket);
    socket.send(
      JSON.stringify({
        type: "auth",
        token: device.refreshToken,
        userId: "attacker",
        deviceId: "attacker-device",
      }),
    );
    await new Promise<void>((resolve) =>
      socket.once("message", () => resolve()),
    );
    const online = await server.app.inject({
      method: "GET",
      url: "/presence",
      headers: { cookie: device.cookie },
    });
    assert.equal(online.json<{ online: boolean }>().online, true);
    assert.equal(
      online.json<{ devices: Array<{ deviceId: string }> }>().devices[0]!
        .deviceId,
      device.deviceId,
    );
    const closed = waitForClose(socket);
    socket.close();
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const offline = await server.app.inject({
      method: "GET",
      url: "/presence",
      headers: { cookie: device.cookie },
    });
    assert.equal(offline.json<{ online: boolean }>().online, false);
  } finally {
    socket.close();
    await server.app.close();
    server.close();
  }
});

test("device revocation closes active websocket presence", async () => {
  const server = await buildApp(":memory:", 3600, "test", undefined, 600, 45);
  const device = await createDevice(server);
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  const address = server.app.server.address();
  assert.ok(address && typeof address !== "string");
  const socket = new WebSocket(
    `ws://127.0.0.1:${address.port}/ws`,
    { origin: "http://localhost:5173" },
  );

  try {
    await waitForOpen(socket);
    socket.send(JSON.stringify({ type: "auth", token: device.refreshToken }));
    await new Promise<void>((resolve) =>
      socket.once("message", () => resolve()),
    );
    const closed = waitForClose(socket);
    const revoked = await server.app.inject({
      method: "DELETE",
      url: `/devices/${device.deviceId}`,
      headers: { cookie: device.cookie },
    });

    assert.equal(revoked.statusCode, 204);
    assert.equal(await closed, 1008);

    const offline = await server.app.inject({
      method: "GET",
      url: "/presence",
      headers: { cookie: device.cookie },
    });
    assert.equal(offline.json<{ online: boolean }>().online, false);

    const reconnect = new WebSocket(
      `ws://127.0.0.1:${address.port}/ws`,
      { origin: "http://localhost:5173" },
    );
    await waitForOpen(reconnect);
    reconnect.send(JSON.stringify({ type: "auth", token: device.refreshToken }));
    assert.equal(await waitForClose(reconnect), 1008);
  } finally {
    socket.close();
    await server.app.close();
    server.close();
  }
});

test("signaling enforces offer/answer direction and routes valid messages", async () => {
  const server = await buildApp(":memory:", 3600, "test", undefined, 600, 45);
  const device = await createDevice(server);
  const viewerLogin = await server.app.inject({
    method: "POST",
    url: "/auth/request-login",
    payload: { email: `viewer-${Date.now()}@example.com` },
  });
  const viewerToken = viewerLogin.json<{ developmentToken: string }>().developmentToken;
  const viewerVerification = await server.app.inject({
    method: "POST",
    url: "/auth/verify-login",
    payload: { token: viewerToken },
  });
  const viewerCookie = cookieValue(viewerVerification.headers["set-cookie"]);
  const ownerSession = await server.app.inject({
    method: "GET",
    url: "/auth/session",
    headers: { cookie: device.cookie },
  });
  const viewerSession = await server.app.inject({
    method: "GET",
    url: "/auth/session",
    headers: { cookie: viewerCookie },
  });
  server.authorization.grant(
    ownerSession.json<{ user: { id: string } }>().user.id,
    viewerSession.json<{ user: { id: string } }>().user.id,
  );
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  const address = server.app.server.address();
  assert.ok(address && typeof address !== "string");
  const wsUrl = `ws://127.0.0.1:${address.port}/ws`;
  const owner = new WebSocket(wsUrl, { origin: "http://localhost:5173" });
  const viewer = new WebSocket(wsUrl, { origin: "http://localhost:5173" });

  try {
    await Promise.all([waitForOpen(owner), waitForOpen(viewer)]);
    owner.send(JSON.stringify({ type: "auth", token: device.refreshToken }));
    viewer.send(JSON.stringify({
      type: "auth",
      token: viewerCookie.split("=", 2)[1]!,
    }));
    await Promise.all([nextMessage(owner), nextMessage(viewer)]);
    viewer.send(JSON.stringify({ type: "create_session", device_id: device.deviceId }));
    const created = await nextMessage(viewer);
    const sessionId = created.session_id as string;
    await nextMessage(owner);

    owner.send(JSON.stringify({ type: "offer", session_id: sessionId, sdp: "v=0" }));
    assert.equal((await nextMessage(viewer)).type, "offer");
    viewer.send(JSON.stringify({ type: "offer", session_id: sessionId, sdp: "v=0" }));
    assert.equal((await nextMessage(viewer)).code, "WRONG_ROLE");
    viewer.send(JSON.stringify({ type: "answer", session_id: sessionId, sdp: "v=0" }));
    assert.equal((await nextMessage(owner)).type, "answer");
    owner.send(JSON.stringify({ type: "answer", session_id: sessionId, sdp: "v=0" }));
    assert.equal((await nextMessage(owner)).code, "WRONG_ROLE");
    owner.send(JSON.stringify({
      type: "ice_candidate",
      session_id: sessionId,
      candidate: { candidate: "owner" },
    }));
    assert.equal((await nextMessage(viewer)).type, "ice_candidate");
    viewer.send(JSON.stringify({
      type: "ice_candidate",
      session_id: sessionId,
      candidate: { candidate: "viewer" },
    }));
    assert.equal((await nextMessage(owner)).type, "ice_candidate");

    const rotated = await server.app.inject({
      method: "POST",
      url: "/devices/refresh",
      payload: { refreshToken: device.refreshToken },
    });
    assert.equal(rotated.statusCode, 200);
    assert.equal(owner.readyState, WebSocket.OPEN);
    const ownerClosed = waitForClose(owner);
    const viewerLeft = nextMessage(viewer);
    const reused = await server.app.inject({
      method: "POST",
      url: "/devices/refresh",
      payload: { refreshToken: device.refreshToken },
    });
    assert.equal(reused.statusCode, 401);
    assert.equal((await viewerLeft).type, "viewer_left");
    assert.equal(await ownerClosed, 1008);
  } finally {
    owner.close();
    viewer.close();
    await server.app.close();
    server.close();
  }
});
