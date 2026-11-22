import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocket, type RawData } from "ws";
import { buildApp } from "../app.js";
import { executeAccessCommand } from "../cli/access.js";
import {
  closeExpiredPresenceSocket,
  isLatestOwnerSocket,
  PRESENCE_EXPIRED_CLOSE_CODE,
} from "./routes.js";
import { PresenceService } from "./service.js";

test("superseded owner screen-off is ignored while current owner updates remain valid", () => {
  const deviceId = "device";
  const oldOwner = {};
  const newOwner = {};
  const latestOwnerSockets = new Map<string, object>([[deviceId, oldOwner]]);
  let sharingState = { screen: false, camera: false };
  const updateSharingState = (socket: object, next: typeof sharingState): boolean => {
    if (!isLatestOwnerSocket(deviceId, socket, latestOwnerSockets)) return false;
    sharingState = next;
    return true;
  };

  assert.equal(updateSharingState(oldOwner, { screen: true, camera: true }), true);
  assert.deepEqual(sharingState, { screen: true, camera: true });
  latestOwnerSockets.set(deviceId, newOwner);
  assert.equal(updateSharingState(oldOwner, { screen: false, camera: false }), false);
  assert.deepEqual(sharingState, { screen: true, camera: true });
  assert.equal(updateSharingState(newOwner, { screen: false, camera: false }), true);
  assert.deepEqual(sharingState, { screen: false, camera: false });
});

test("an old owner screen-off after replacement cannot clear the active session", async () => {
  const server = await buildApp(":memory:", 3600, "test");
  const device = await createDevice(server);
  const ownerSession = await server.app.inject({
    method: "GET",
    url: "/auth/session",
    headers: { cookie: device.cookie },
  });
  const viewerLogin = await server.app.inject({
    method: "POST",
    url: "/auth/request-login",
    payload: { email: `owner-replacement-${Date.now()}@example.com` },
  });
  const viewerVerification = await server.app.inject({
    method: "POST",
    url: "/auth/verify-login",
    payload: { token: viewerLogin.json<{ developmentToken: string }>().developmentToken },
  });
  const viewerCookie = cookieValue(viewerVerification.headers["set-cookie"]);
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
  const oldOwner = new WebSocket(wsUrl, { origin: "http://localhost:5173" });
  const viewer = new WebSocket(wsUrl, {
    origin: "http://localhost:5173",
    headers: { cookie: viewerCookie },
  });
  const viewerAuth = nextMessage(viewer);
  const sockets = [oldOwner, viewer];
  const originalClose = WebSocket.prototype.close;
  WebSocket.prototype.close = function (
    this: WebSocket,
    code?: number,
    reason?: string | Buffer,
  ): void {
    if (code === 1008 && reason?.toString() === "owner connection replaced") return;
    originalClose.call(this, code, reason);
  };

  try {
    await Promise.all([waitForOpen(oldOwner), waitForOpen(viewer)]);
    const oldOwnerAuth = nextMessage(oldOwner);
    oldOwner.send(JSON.stringify({ type: "auth", token: device.refreshToken }));
    assert.equal((await oldOwnerAuth).role, "owner");
    assert.equal((await viewerAuth).role, "viewer");

    const sharingAck = nextMessage(oldOwner);
    const viewerSharing = nextMessage(viewer);
    oldOwner.send(JSON.stringify({ type: "sharing_state", screen: true, camera: true }));
    await Promise.all([sharingAck, viewerSharing]);
    const createSessionMessages = nextMessages(viewer, 2);
    viewer.send(JSON.stringify({ type: "create_session", device_id: device.deviceId }));
    const [, created] = await createSessionMessages;
    assert.equal(created?.type, "session_created");
    const originalSessionId = created?.session_id;
    assert.equal((await nextMessage(oldOwner)).type, "viewer_joined");

    const replacementOwner = new WebSocket(wsUrl, { origin: "http://localhost:5173" });
    sockets.push(replacementOwner);
    await waitForOpen(replacementOwner);
    const replacementMessages = nextMessages(replacementOwner, 2);
    const viewerRecovery = nextMessage(viewer);
    replacementOwner.send(JSON.stringify({ type: "auth", token: device.refreshToken }));
    const [authenticated, recovery] = await replacementMessages;
    assert.equal(authenticated?.type, "authenticated");
    assert.equal(recovery?.type, "session_recovery");
    assert.equal(recovery?.session_id, originalSessionId);
    assert.deepEqual(await viewerRecovery, recovery);

    oldOwner.send(JSON.stringify({ type: "sharing_state", screen: false, camera: false }));
    await assertNoMessage(oldOwner);
    const stillSharing = await server.app.inject({
      method: "GET",
      url: "/presence",
      headers: { cookie: device.cookie },
    });
    assert.deepEqual(
      stillSharing.json<{ devices: Array<{ screen: boolean; camera: boolean }> }>()
        .devices.map(({ screen, camera }) => ({ screen, camera }))[0],
      { screen: true, camera: true },
    );

    const replacementAck = nextMessage(replacementOwner);
    replacementOwner.send(JSON.stringify({ type: "sharing_state", screen: false, camera: false }));
    assert.equal((await replacementAck).type, "sharing_state_updated");
    const stopped = await server.app.inject({
      method: "GET",
      url: "/presence",
      headers: { cookie: device.cookie },
    });
    assert.deepEqual(
      stopped.json<{ devices: Array<{ screen: boolean; camera: boolean }> }>()
        .devices.map(({ screen, camera }) => ({ screen, camera }))[0],
      { screen: false, camera: false },
    );
  } finally {
    WebSocket.prototype.close = originalClose;
    await Promise.all(sockets.map(terminateSocket));
    await server.app.close();
    server.close();
  }
});

test("viewer create_session uses the latest authenticated owner socket while replacement overlaps", async () => {
  const server = await buildApp(":memory:", 3600, "test");
  const device = await createDevice(server);
  const ownerSession = await server.app.inject({
    method: "GET",
    url: "/auth/session",
    headers: { cookie: device.cookie },
  });
  const viewerLogin = await server.app.inject({
    method: "POST",
    url: "/auth/request-login",
    payload: { email: `latest-owner-${Date.now()}@example.com` },
  });
  const viewerVerification = await server.app.inject({
    method: "POST",
    url: "/auth/verify-login",
    payload: { token: viewerLogin.json<{ developmentToken: string }>().developmentToken },
  });
  const viewerCookie = cookieValue(viewerVerification.headers["set-cookie"]);
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
  const oldOwner = new WebSocket(wsUrl, { origin: "http://localhost:5173" });
  const replacementOwner = new WebSocket(wsUrl, { origin: "http://localhost:5173" });
  const viewer = new WebSocket(wsUrl, {
    origin: "http://localhost:5173",
    headers: { cookie: viewerCookie },
  });
  const sockets = [oldOwner, replacementOwner, viewer];
  const viewerAuth = nextMessage(viewer);
  const originalClose = WebSocket.prototype.close;
  WebSocket.prototype.close = function (
    this: WebSocket,
    code?: number,
    reason?: string | Buffer,
  ): void {
    if (code === 1008 && reason?.toString() === "owner connection replaced") return;
    originalClose.call(this, code, reason);
  };

  try {
    await Promise.all([
      waitForOpen(oldOwner),
      waitForOpen(replacementOwner),
      waitForOpen(viewer),
    ]);
    const oldAuth = nextMessage(oldOwner);
    oldOwner.send(JSON.stringify({ type: "auth", token: device.refreshToken }));
    assert.equal((await oldAuth).role, "owner");
    assert.equal((await viewerAuth).role, "viewer");

    const replacementAuth = nextMessage(replacementOwner);
    replacementOwner.send(JSON.stringify({ type: "auth", token: device.refreshToken }));
    const authenticated = await replacementAuth;
    assert.equal(authenticated.type, "authenticated");
    assert.equal(authenticated.role, "owner");

    const replacementAck = nextMessage(replacementOwner);
    replacementOwner.send(JSON.stringify({ type: "sharing_state", screen: true, camera: true }));
    assert.equal((await replacementAck).type, "sharing_state_updated");

    const viewerMessages = nextMessages(viewer, 2);
    const replacementJoined = nextMessage(replacementOwner);
    viewer.send(JSON.stringify({ type: "create_session", device_id: device.deviceId }));
    const [, created] = await viewerMessages;
    assert.equal(created?.type, "session_created");
    const sessionId = created?.session_id;

    assert.deepEqual(await replacementJoined, {
      type: "viewer_joined",
      session_id: sessionId,
      viewer_user_id: viewerSession.json<{ user: { id: string } }>().user.id,
    });

    oldOwner.send(JSON.stringify({ type: "sharing_state", screen: false, camera: false }));
    await assertNoMessage(oldOwner);
    const oldOwnerClosed = waitForClose(oldOwner);
    oldOwner.close();
    assert.equal((await oldOwnerClosed), 1005);

    const presence = await server.app.inject({
      method: "GET",
      url: "/presence",
      headers: { cookie: device.cookie },
    });
    assert.deepEqual(
      presence.json<{ devices: Array<{ screen: boolean; camera: boolean }> }>()
        .devices.map(({ screen, camera }) => ({ screen, camera }))[0],
      { screen: true, camera: true },
    );

    const replacementAckStillOpen = nextMessage(replacementOwner);
    replacementOwner.send(JSON.stringify({ type: "sharing_state", screen: true, camera: false }));
    assert.equal((await replacementAckStillOpen).type, "sharing_state_updated");
  } finally {
    WebSocket.prototype.close = originalClose;
    await Promise.all(sockets.map(terminateSocket));
    await server.app.close();
    server.close();
  }
});

function cookieValue(value: string | string[] | undefined): string {
  assert.ok(value);
  return (Array.isArray(value) ? value[0] : value).split(";")[0]!;
}

function waitForClose(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off("close", onClose);
      socket.off("error", onError);
      resolve(-1);
    }, 10_000);
    const onClose = (code: number) => {
      clearTimeout(timer);
      socket.off("error", onError);
      resolve(code);
    };
    const onError = () => undefined;
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => onError(new Error("Timed out waiting for a WebSocket connection")),
      5_000,
    );
    const onOpen = () => {
      clearTimeout(timer);
      socket.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      clearTimeout(timer);
      socket.off("open", onOpen);
      reject(error);
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
  });
}

function nextMessage(socket: WebSocket, timeoutMs = 5_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      finish(() => reject(new Error("Timed out waiting for a WebSocket message")));
    }, timeoutMs);
    const finish = (action: () => void) => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("error", onError);
      action();
    };
    const onMessage = (raw: Buffer) => {
      try {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        finish(() => resolve(message));
      } catch (error) {
        finish(() => reject(error));
      }
    };
    const onError = (error: Error) => finish(() => reject(error));
    socket.once("message", onMessage);
    socket.once("error", onError);
  });
}

function nextMessages(socket: WebSocket, count: number): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const messages: Record<string, unknown>[] = [];
    const timer = setTimeout(() => {
      finish(() => reject(new Error("Timed out waiting for WebSocket messages")));
    }, 5_000);
    const finish = (action: () => void) => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("error", onError);
      action();
    };
    const onMessage = (raw: Buffer) => {
      try {
        messages.push(JSON.parse(raw.toString()) as Record<string, unknown>);
      } catch (error) {
        finish(() => reject(error));
        return;
      }
      if (messages.length === count) {
        finish(() => resolve(messages));
      }
    };
    const onError = (error: Error) => finish(() => reject(error));
    socket.on("message", onMessage);
    socket.once("error", onError);
  });
}

async function assertNoMessage(socket: WebSocket): Promise<void> {
  const received = await new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => {
      finish(() => resolve(false));
    }, 30);
    const finish = (action: () => void) => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("error", onError);
      action();
    };
    const onMessage = () => {
      finish(() => resolve(true));
    };
    const onError = (error: Error) => finish(() => reject(error));
    socket.once("message", onMessage);
    socket.once("error", onError);
  });
  assert.equal(received, false, "unexpected message was delivered");
}

function terminateSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout;
    const finish = () => {
      clearTimeout(timer);
      socket.off("close", finish);
      socket.off("error", onError);
      resolve();
    };
    const onError = () => undefined;
    timer = setTimeout(finish, 1_000);
    socket.once("close", finish);
    socket.on("error", onError);
    socket.terminate();
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

async function createAdditionalDevice(
  server: Awaited<ReturnType<typeof buildApp>>,
  cookie: string,
): Promise<{ deviceId: string; refreshToken: string }> {
  const codeResponse = await server.app.inject({
    method: "POST",
    url: "/devices/enrollment-code",
    headers: { cookie },
  });
  const { code } = codeResponse.json<{ code: string }>();
  const enrolled = await server.app.inject({
    method: "POST",
    url: "/devices/enroll",
    payload: { code, name: "Second laptop", platform: "macOS" },
  });
  return enrolled.json();
}

async function createViewer(
  server: Awaited<ReturnType<typeof buildApp>>,
  email: string,
): Promise<{ cookie: string; userId: string }> {
  const login = await server.app.inject({
    method: "POST",
    url: "/auth/request-login",
    payload: { email },
  });
  const verification = await server.app.inject({
    method: "POST",
    url: "/auth/verify-login",
    payload: { token: login.json<{ developmentToken: string }>().developmentToken },
  });
  const cookie = cookieValue(verification.headers["set-cookie"]);
  const session = await server.app.inject({
    method: "GET",
    url: "/auth/session",
    headers: { cookie },
  });
  return { cookie, userId: session.json<{ user: { id: string } }>().user.id };
}

async function createViewerDiscoveryFixture() {
  const server = await buildApp(":memory:", 3600, "test", undefined, 600, 45);
  const device = await createDevice(server);
  const ownerSession = await server.app.inject({
    method: "GET",
    url: "/auth/session",
    headers: { cookie: device.cookie },
  });
  const ownerUserId = ownerSession.json<{ user: { id: string } }>().user.id;
  const authorized = await createViewer(server, `discovery-allowed-${Date.now()}@example.com`);
  const unauthorized = await createViewer(server, `discovery-denied-${Date.now()}@example.com`);
  server.authorization.grant(ownerUserId, authorized.userId);
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  const address = server.app.server.address();
  assert.ok(address && typeof address !== "string");
  const wsUrl = `ws://127.0.0.1:${address.port}/ws`;
  const sockets: WebSocket[] = [];
  const openOwner = (): WebSocket => {
    const socket = new WebSocket(wsUrl, { origin: "http://localhost:5173" });
    sockets.push(socket);
    return socket;
  };
  const openViewer = (authorizedViewer = true): WebSocket => {
    const cookie = authorizedViewer ? authorized.cookie : unauthorized.cookie;
    const socket = new WebSocket(wsUrl, {
      origin: "http://localhost:5173",
      headers: { cookie },
    });
    sockets.push(socket);
    return socket;
  };
  return {
    server,
    device,
    openOwner,
    openViewer,
    async close(): Promise<void> {
      await Promise.all(sockets.map(terminateSocket));
      await server.app.close();
      server.close();
    },
  };
}

test("presence service distinguishes connections and expires at the threshold", () => {
  let now = 1_700_000_000_000;
  const closed: Array<{ connectionId: string; cause: string }> = [];
  const presence = new PresenceService({
    now: () => now,
    staleThresholdSeconds: 10,
    closeConnection: (connectionId, cause) => closed.push({ connectionId, cause }),
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
  assert.deepEqual(closed, [{ connectionId: deviceB.connectionId, cause: "stale" }]);
  presence.close();
});

test("presence service removes every connection for a revoked device", () => {
  const closed: Array<{ connectionId: string; cause: string }> = [];
  const presence = new PresenceService({
    closeConnection: (connectionId, cause) => closed.push({ connectionId, cause }),
    staleThresholdSeconds: 45,
  });
  const first = presence.connect("user-a", "device-a");
  const second = presence.connect("user-a", "device-a");
  presence.connect("user-a", "device-b");

  presence.revokeDevice("device-a");

  assert.deepEqual(
    closed.sort((left, right) => left.connectionId.localeCompare(right.connectionId)),
    [
      { connectionId: first.connectionId, cause: "revoked" },
      { connectionId: second.connectionId, cause: "revoked" },
    ].sort((left, right) => left.connectionId.localeCompare(right.connectionId)),
  );
  assert.deepEqual(
    presence.getUserPresence("user-a").map((record) => record.deviceId),
    ["device-b"],
  );
  presence.close();
});

test("stale-presence and heartbeat close intents are diagnosed without sensitive payloads", () => {
  const logs: string[] = [];
  const originalInfo = console.info;
  console.info = (...values: unknown[]) => {
    for (const value of values) if (typeof value === "string") logs.push(value);
  };
  const closes: Array<{ code?: number; reason?: string }> = [];
  const socket = {
    readyState: WebSocket.OPEN,
    close: (code?: number, reason?: string) => closes.push({ code, reason }),
  };

  try {
    closeExpiredPresenceSocket(socket, "stale-presence-expiry", {
      deviceId: "device-safe-id",
      socketConnectionGeneration: 7,
    });
    closeExpiredPresenceSocket(socket, "heartbeat-expiry", {
      deviceId: "device-safe-id",
      socketConnectionGeneration: 8,
    });
  } finally {
    console.info = originalInfo;
  }

  assert.deepEqual(closes, [
    { code: PRESENCE_EXPIRED_CLOSE_CODE, reason: "presence expired" },
    { code: PRESENCE_EXPIRED_CLOSE_CODE, reason: "presence expired" },
  ]);
  const diagnostics = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.event), [
    "stale_presence_close_intent",
    "heartbeat_expiry_close_intent",
  ]);
  assert.deepEqual(
    diagnostics.map((diagnostic) => ({
      closeCode: diagnostic.closeCode,
      closeReasonCategory: diagnostic.closeReasonCategory,
      closeAttempted: diagnostic.closeAttempted,
    })),
    [
      {
        closeCode: 1013,
        closeReasonCategory: "stale_presence_retryable",
        closeAttempted: true,
      },
      {
        closeCode: 1013,
        closeReasonCategory: "heartbeat_expired_retryable",
        closeAttempted: true,
      },
    ],
  );
  assert.ok(diagnostics.every((diagnostic) => typeof diagnostic.timestamp === "string"));
  const serialized = logs.join("\n");
  assert.equal(serialized.includes("credential"), false);
  assert.equal(serialized.includes("candidate:"), false);
  assert.equal(serialized.includes("192.0.2."), false);
  assert.equal(serialized.includes("v=0"), false);
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

test("sharing activation is acknowledged, authorizes viewers only while active, and clears on stop or disconnect", async () => {
  const server = await buildApp(":memory:", 3600, "test", undefined, 600, 45);
  const device = await createDevice(server);

  async function createViewer(email: string): Promise<{ cookie: string; userId: string }> {
    const login = await server.app.inject({
      method: "POST",
      url: "/auth/request-login",
      payload: { email },
    });
    const { developmentToken } = login.json<{ developmentToken: string }>();
    const verified = await server.app.inject({
      method: "POST",
      url: "/auth/verify-login",
      payload: { token: developmentToken },
    });
    const cookie = cookieValue(verified.headers["set-cookie"]);
    const session = await server.app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { cookie },
    });
    return { cookie, userId: session.json<{ user: { id: string } }>().user.id };
  }

  const ownerSession = await server.app.inject({
    method: "GET",
    url: "/auth/session",
    headers: { cookie: device.cookie },
  });
  const ownerUserId = ownerSession.json<{ user: { id: string } }>().user.id;
  const authorizedViewer = await createViewer(`allowed-${Date.now()}@example.com`);
  const unauthorizedViewer = await createViewer(`denied-${Date.now()}@example.com`);
  server.authorization.grant(ownerUserId, authorizedViewer.userId);

  await server.app.listen({ host: "127.0.0.1", port: 0 });
  const address = server.app.server.address();
  assert.ok(address && typeof address !== "string");
  const wsUrl = `ws://127.0.0.1:${address.port}/ws`;
  const owner = new WebSocket(wsUrl, { origin: "http://localhost:5173" });
  const authorized = new WebSocket(wsUrl, {
    origin: "http://localhost:5173",
    headers: { cookie: authorizedViewer.cookie },
  });
  const unauthorized = new WebSocket(wsUrl, {
    origin: "http://localhost:5173",
    headers: { cookie: unauthorizedViewer.cookie },
  });
  const ownerAuthenticated = nextMessage(owner);
  const authorizedAuthenticated = nextMessage(authorized);
  const unauthorizedAuthenticated = nextMessage(unauthorized);

  try {
    await Promise.all([waitForOpen(owner), waitForOpen(authorized), waitForOpen(unauthorized)]);
    owner.send(JSON.stringify({ type: "auth", token: device.refreshToken }));
    assert.equal((await ownerAuthenticated).role, "owner");
    assert.equal((await authorizedAuthenticated).role, "viewer");
    assert.equal((await unauthorizedAuthenticated).role, "viewer");

    const presence = await server.app.inject({
      method: "GET",
      url: "/presence",
      headers: { cookie: device.cookie },
    });
    assert.equal(presence.json<{ online: boolean }>().online, true);

    unauthorized.send(JSON.stringify({ type: "create_session", device_id: device.deviceId }));
    assert.equal((await nextMessage(unauthorized)).code, "NOT_AUTHORIZED");
    authorized.send(JSON.stringify({ type: "create_session", device_id: device.deviceId }));
    assert.deepEqual(await nextMessage(authorized), {
      type: "device_sharing_state",
      device_id: device.deviceId,
      screen: false,
      camera: false,
      online: true,
      state_revision: 0,
    });

    const heartbeatAck = nextMessage(owner);
    owner.send(JSON.stringify({ type: "heartbeat" }));
    assert.deepEqual(await heartbeatAck, { type: "heartbeat_ack" });
    const activeOwnerAck = nextMessage(owner);
    const activeViewerNotification = nextMessage(authorized);
    owner.send(JSON.stringify({ type: "sharing_state", screen: true, camera: false }));
    assert.deepEqual(await activeOwnerAck, {
      type: "sharing_state_updated",
      device_id: device.deviceId,
      screen: true,
      camera: false,
    });
    assert.deepEqual(await activeViewerNotification, {
      type: "device_sharing_state",
      device_id: device.deviceId,
      screen: true,
      camera: false,
      online: true,
      state_revision: 1,
    });
    await assertNoMessage(unauthorized);
    const activePresence = await server.app.inject({
      method: "GET",
      url: "/presence",
      headers: { cookie: device.cookie },
    });
    assert.deepEqual(
      activePresence.json<{ devices: Array<{ deviceId: string; screen: boolean; camera: boolean }> }>()
        .devices.map(({ deviceId, screen, camera }) => ({ deviceId, screen, camera })),
      [{ deviceId: device.deviceId, screen: true, camera: false }],
    );
    const activeSessionMessages = nextMessages(authorized, 2);
    authorized.send(JSON.stringify({ type: "create_session", device_id: device.deviceId }));
    const [activeSessionState, createdSession] = await activeSessionMessages;
    assert.deepEqual(activeSessionState, {
      type: "device_sharing_state",
      device_id: device.deviceId,
      screen: true,
      camera: false,
      online: true,
      state_revision: 1,
    });
    assert.equal(createdSession?.type, "session_created");
    let sessionId = createdSession?.session_id as string;
    assert.equal((await nextMessage(owner)).type, "viewer_joined");

    const cameraEnabled = nextMessage(authorized);
    const cameraEnabledOwnerAck = nextMessage(owner);
    owner.send(JSON.stringify({ type: "sharing_state", screen: true, camera: true }));
    assert.deepEqual(await cameraEnabledOwnerAck, {
      type: "sharing_state_updated",
      device_id: device.deviceId,
      screen: true,
      camera: true,
      session_id: sessionId,
    });
    assert.deepEqual(await cameraEnabled, {
      type: "device_sharing_state",
      device_id: device.deviceId,
      screen: true,
      camera: true,
      online: true,
      state_revision: 2,
    });

    const previousSessionIds = new Set([sessionId]);
    for (let reconnect = 0; reconnect < 3; reconnect += 1) {
      const ownerLeft = nextMessage(owner);
      const viewerLeft = nextMessage(authorized);
      authorized.send(JSON.stringify({ type: "leave_session", session_id: sessionId }));
      assert.deepEqual(await ownerLeft, {
        type: "viewer_left",
        session_id: sessionId,
        viewer_user_id: authorizedViewer.userId,
        reason: "closed",
      });
      assert.deepEqual(await viewerLeft, {
        type: "viewer_left",
        session_id: sessionId,
        viewer_user_id: authorizedViewer.userId,
        reason: "closed",
      });

      const sharing = await server.app.inject({
        method: "GET",
        url: "/presence",
        headers: { cookie: device.cookie },
      });
      assert.deepEqual(
        sharing.json<{ devices: Array<{ deviceId: string; screen: boolean; camera: boolean }> }>()
          .devices.map(({ deviceId, screen, camera }) => ({ deviceId, screen, camera })),
        [{ deviceId: device.deviceId, screen: true, camera: true }],
      );

      const reconnectMessages = nextMessages(authorized, 2);
      const ownerJoined = nextMessage(owner);
      authorized.send(JSON.stringify({ type: "create_session", device_id: device.deviceId }));
      const [reconnectedState, reconnectedSession] = await reconnectMessages;
      assert.deepEqual(reconnectedState, {
        type: "device_sharing_state",
        device_id: device.deviceId,
        screen: true,
        camera: true,
        online: true,
        state_revision: 2,
      });
      assert.equal(reconnectedSession?.type, "session_created");
      sessionId = reconnectedSession?.session_id as string;
      assert.ok(!previousSessionIds.has(sessionId), "reconnect must create a fresh session");
      previousSessionIds.add(sessionId);
      assert.deepEqual(await ownerJoined, {
        type: "viewer_joined",
        session_id: sessionId,
        viewer_user_id: authorizedViewer.userId,
      });
    }

    const cameraDisabled = nextMessage(authorized);
    const cameraDisabledOwnerAck = nextMessage(owner);
    owner.send(JSON.stringify({ type: "sharing_state", screen: true, camera: false }));
    assert.deepEqual(await cameraDisabledOwnerAck, {
      type: "sharing_state_updated",
      device_id: device.deviceId,
      screen: true,
      camera: false,
      session_id: sessionId,
    });
    assert.deepEqual(await cameraDisabled, {
      type: "device_sharing_state",
      device_id: device.deviceId,
      screen: true,
      camera: false,
      online: true,
      state_revision: 3,
    });
    await assertNoMessage(unauthorized);

    const inactiveOwnerAck = nextMessage(owner);
    const stoppedViewerMessages = nextMessages(authorized, 2);
    owner.send(JSON.stringify({ type: "sharing_state", screen: false, camera: false }));
    assert.deepEqual(await inactiveOwnerAck, {
      type: "sharing_state_updated",
      device_id: device.deviceId,
      screen: false,
      camera: false,
      session_id: sessionId,
    });
    const [inactiveViewerNotification, stoppedSession] = await stoppedViewerMessages;
    assert.deepEqual(inactiveViewerNotification, {
      type: "device_sharing_state",
      device_id: device.deviceId,
      screen: false,
      camera: false,
      online: true,
      state_revision: 4,
    });
    assert.equal(stoppedSession?.type, "viewer_left");
    const stoppedPresence = await server.app.inject({
      method: "GET",
      url: "/presence",
      headers: { cookie: device.cookie },
    });
    assert.equal(stoppedPresence.json<{ devices: Array<{ screen: boolean }> }>().devices[0]?.screen, false);
    authorized.send(JSON.stringify({ type: "create_session", device_id: device.deviceId }));
    assert.deepEqual(await nextMessage(authorized), {
      type: "device_sharing_state",
      device_id: device.deviceId,
      screen: false,
      camera: false,
      online: true,
      state_revision: 4,
    });

    const restartedOwnerAck = nextMessage(owner);
    const restartedViewerNotification = nextMessage(authorized);
    owner.send(JSON.stringify({ type: "sharing_state", screen: true, camera: false }));
    assert.deepEqual(await restartedOwnerAck, {
      type: "sharing_state_updated",
      device_id: device.deviceId,
      screen: true,
      camera: false,
    });
    assert.deepEqual(await restartedViewerNotification, {
      type: "device_sharing_state",
      device_id: device.deviceId,
      screen: true,
      camera: false,
      online: true,
      state_revision: 5,
    });
    const ownerClosed = waitForClose(owner);
    const disconnectedViewerNotification = nextMessage(authorized);
    owner.close();
    await ownerClosed;
    const reconnectingOwner = new WebSocket(wsUrl, { origin: "http://localhost:5173" });
    await waitForOpen(reconnectingOwner);
    reconnectingOwner.send(JSON.stringify({ type: "auth", token: device.refreshToken }));
    assert.equal((await nextMessage(reconnectingOwner)).type, "authenticated");
    assert.deepEqual(await disconnectedViewerNotification, {
      type: "device_sharing_state",
      device_id: device.deviceId,
      screen: false,
      camera: false,
      online: false,
      state_revision: 6,
    });
    const disconnectedPresence = await server.app.inject({
      method: "GET",
      url: "/presence",
      headers: { cookie: device.cookie },
    });
    assert.equal(disconnectedPresence.json<{ devices: Array<{ screen: boolean }> }>().devices[0]?.screen, false);
    authorized.send(JSON.stringify({ type: "create_session", device_id: device.deviceId }));
    assert.deepEqual(await nextMessage(authorized), {
      type: "device_sharing_state",
      device_id: device.deviceId,
      screen: false,
      camera: false,
      online: true,
      state_revision: 6,
    });
    const idleOwnerAck = nextMessage(reconnectingOwner);
    const idleOwnerOnline = nextMessage(authorized);
    reconnectingOwner.send(JSON.stringify({ type: "sharing_state", screen: false, camera: false }));
    assert.deepEqual(await idleOwnerAck, {
      type: "sharing_state_updated",
      device_id: device.deviceId,
      screen: false,
      camera: false,
    });
    assert.deepEqual(await idleOwnerOnline, {
      type: "device_sharing_state",
      device_id: device.deviceId,
      screen: false,
      camera: false,
      online: true,
      state_revision: 7,
    });
    const idleOwnerClosed = waitForClose(reconnectingOwner);
    const idleOwnerOffline = nextMessage(authorized);
    reconnectingOwner.close();
    await idleOwnerClosed;
    assert.deepEqual(await idleOwnerOffline, {
      type: "device_sharing_state",
      device_id: device.deviceId,
      screen: false,
      camera: false,
      online: false,
      state_revision: 8,
    });
  } finally {
    owner.close();
    authorized.close();
    unauthorized.close();
    await server.app.close();
    server.close();
  }
});

test("viewer discovery reports an already-online idle owner without a later owner update", async () => {
  const fixture = await createViewerDiscoveryFixture();
  const owner = fixture.openOwner();
  try {
    const ownerAuth = nextMessage(owner);
    await waitForOpen(owner);
    owner.send(JSON.stringify({ type: "auth", token: fixture.device.refreshToken }));
    assert.equal((await ownerAuth).role, "owner");

    const viewer = fixture.openViewer();
    const viewerAuth = nextMessage(viewer);
    await waitForOpen(viewer);
    assert.equal((await viewerAuth).role, "viewer");
    const discovery = nextMessage(viewer);
    viewer.send(JSON.stringify({ type: "create_session", device_id: fixture.device.deviceId }));
    assert.deepEqual(await discovery, {
      type: "device_sharing_state",
      device_id: fixture.device.deviceId,
      screen: false,
      camera: false,
      online: true,
      state_revision: 0,
    });
    await assertNoMessage(viewer);
  } finally {
    await fixture.close();
  }
});

test("viewer discovery reports an authorized offline owner explicitly", async () => {
  const fixture = await createViewerDiscoveryFixture();
  const viewer = fixture.openViewer();
  try {
    const viewerAuth = nextMessage(viewer);
    await waitForOpen(viewer);
    assert.equal((await viewerAuth).role, "viewer");
    const discovery = nextMessage(viewer);
    viewer.send(JSON.stringify({ type: "create_session", device_id: fixture.device.deviceId }));
    assert.deepEqual(await discovery, {
      type: "device_sharing_state",
      device_id: fixture.device.deviceId,
      screen: false,
      camera: false,
      online: false,
      state_revision: 0,
    });
    await assertNoMessage(viewer);
  } finally {
    await fixture.close();
  }
});

test("viewer discovery attaches to an owner already sharing", async () => {
  const fixture = await createViewerDiscoveryFixture();
  const owner = fixture.openOwner();
  try {
    const ownerAuth = nextMessage(owner);
    await waitForOpen(owner);
    owner.send(JSON.stringify({ type: "auth", token: fixture.device.refreshToken }));
    assert.equal((await ownerAuth).role, "owner");
    const ownerState = nextMessage(owner);
    owner.send(JSON.stringify({ type: "sharing_state", screen: true, camera: false }));
    assert.equal((await ownerState).type, "sharing_state_updated");

    const viewer = fixture.openViewer();
    const viewerAuth = nextMessage(viewer);
    await waitForOpen(viewer);
    assert.equal((await viewerAuth).role, "viewer");
    const ownerJoined = nextMessage(owner);
    const discovery = nextMessages(viewer, 2);
    viewer.send(JSON.stringify({ type: "create_session", device_id: fixture.device.deviceId }));
    const [state, session] = await discovery;
    assert.deepEqual(state, {
      type: "device_sharing_state",
      device_id: fixture.device.deviceId,
      screen: true,
      camera: false,
      online: true,
      state_revision: 1,
    });
    assert.equal(session?.type, "session_created");
    assert.equal((await ownerJoined).type, "viewer_joined");
  } finally {
    await fixture.close();
  }
});

test("owner starting after online-idle discovery notifies the viewer and permits attachment", async () => {
  const fixture = await createViewerDiscoveryFixture();
  const owner = fixture.openOwner();
  try {
    const ownerAuth = nextMessage(owner);
    await waitForOpen(owner);
    owner.send(JSON.stringify({ type: "auth", token: fixture.device.refreshToken }));
    assert.equal((await ownerAuth).role, "owner");
    const idleAck = nextMessage(owner);
    owner.send(JSON.stringify({ type: "sharing_state", screen: false, camera: false }));
    assert.equal((await idleAck).type, "sharing_state_updated");

    const viewer = fixture.openViewer();
    const viewerAuth = nextMessage(viewer);
    await waitForOpen(viewer);
    assert.equal((await viewerAuth).role, "viewer");
    const discovery = nextMessage(viewer);
    viewer.send(JSON.stringify({ type: "create_session", device_id: fixture.device.deviceId }));
    assert.deepEqual(await discovery, {
      type: "device_sharing_state",
      device_id: fixture.device.deviceId,
      screen: false,
      camera: false,
      online: true,
      state_revision: 1,
    });
    await assertNoMessage(viewer);

    const activeAck = nextMessage(owner);
    const activeNotification = nextMessage(viewer);
    owner.send(JSON.stringify({ type: "sharing_state", screen: true, camera: false }));
    assert.equal((await activeAck).type, "sharing_state_updated");
    assert.deepEqual(await activeNotification, {
      type: "device_sharing_state",
      device_id: fixture.device.deviceId,
      screen: true,
      camera: false,
      online: true,
      state_revision: 2,
    });
    const ownerJoined = nextMessage(owner);
    const attachment = nextMessages(viewer, 2);
    viewer.send(JSON.stringify({ type: "create_session", device_id: fixture.device.deviceId }));
    assert.equal((await attachment)[1]?.type, "session_created");
    assert.equal((await ownerJoined).type, "viewer_joined");
  } finally {
    await fixture.close();
  }
});

test("owner disconnect after online-idle discovery sends a newer offline state", async () => {
  const fixture = await createViewerDiscoveryFixture();
  const owner = fixture.openOwner();
  try {
    const ownerAuth = nextMessage(owner);
    await waitForOpen(owner);
    owner.send(JSON.stringify({ type: "auth", token: fixture.device.refreshToken }));
    assert.equal((await ownerAuth).role, "owner");
    const idleAck = nextMessage(owner);
    owner.send(JSON.stringify({ type: "sharing_state", screen: false, camera: false }));
    assert.equal((await idleAck).type, "sharing_state_updated");

    const viewer = fixture.openViewer();
    const viewerAuth = nextMessage(viewer);
    await waitForOpen(viewer);
    assert.equal((await viewerAuth).role, "viewer");
    const discovery = nextMessage(viewer);
    viewer.send(JSON.stringify({ type: "create_session", device_id: fixture.device.deviceId }));
    assert.deepEqual(await discovery, {
      type: "device_sharing_state",
      device_id: fixture.device.deviceId,
      screen: false,
      camera: false,
      online: true,
      state_revision: 1,
    });

    const offline = nextMessage(viewer);
    const ownerClosed = waitForClose(owner);
    owner.close();
    await ownerClosed;
    assert.deepEqual(await offline, {
      type: "device_sharing_state",
      device_id: fixture.device.deviceId,
      screen: false,
      camera: false,
      online: false,
      state_revision: 2,
    });
  } finally {
    await fixture.close();
  }
});

test("unauthorized viewer discovery does not reveal owner availability", async () => {
  const fixture = await createViewerDiscoveryFixture();
  const owner = fixture.openOwner();
  try {
    const ownerAuth = nextMessage(owner);
    await waitForOpen(owner);
    owner.send(JSON.stringify({ type: "auth", token: fixture.device.refreshToken }));
    assert.equal((await ownerAuth).role, "owner");
    const ownerState = nextMessage(owner);
    owner.send(JSON.stringify({ type: "sharing_state", screen: false, camera: false }));
    assert.equal((await ownerState).type, "sharing_state_updated");

    const viewer = fixture.openViewer(false);
    const viewerAuth = nextMessage(viewer);
    await waitForOpen(viewer);
    assert.equal((await viewerAuth).role, "viewer");
    const result = nextMessage(viewer);
    viewer.send(JSON.stringify({ type: "create_session", device_id: fixture.device.deviceId }));
    assert.deepEqual(await result, { type: "error", code: "NOT_AUTHORIZED" });
    await assertNoMessage(viewer);
  } finally {
    await fixture.close();
  }
});

test("initial discovery snapshot and later owner notification have increasing revisions", async () => {
  const fixture = await createViewerDiscoveryFixture();
  const owner = fixture.openOwner();
  try {
    const ownerAuth = nextMessage(owner);
    await waitForOpen(owner);
    owner.send(JSON.stringify({ type: "auth", token: fixture.device.refreshToken }));
    assert.equal((await ownerAuth).role, "owner");
    const idleAck = nextMessage(owner);
    owner.send(JSON.stringify({ type: "sharing_state", screen: false, camera: false }));
    assert.equal((await idleAck).type, "sharing_state_updated");

    const viewer = fixture.openViewer();
    const viewerAuth = nextMessage(viewer);
    await waitForOpen(viewer);
    assert.equal((await viewerAuth).role, "viewer");
    const snapshotPromise = nextMessage(viewer);
    viewer.send(JSON.stringify({ type: "create_session", device_id: fixture.device.deviceId }));
    const snapshot = await snapshotPromise;
    const notificationPromise = nextMessage(viewer);
    const activeAck = nextMessage(owner);
    owner.send(JSON.stringify({ type: "sharing_state", screen: true, camera: false }));
    assert.equal((await activeAck).type, "sharing_state_updated");
    const notification = await notificationPromise;

    assert.equal(snapshot.type, "device_sharing_state");
    assert.equal(snapshot.online, true);
    assert.equal(snapshot.screen, false);
    assert.equal(snapshot.state_revision, 1);
    assert.equal(notification.type, "device_sharing_state");
    assert.equal(notification.online, true);
    assert.equal(notification.screen, true);
    assert.equal(notification.state_revision, 2);
    assert.ok(
      (notification.state_revision as number) > (snapshot.state_revision as number),
    );
  } finally {
    await fixture.close();
  }
});

test("browser session cookie authenticates viewer signaling without exposing the HttpOnly token", async () => {
  const server = await buildApp(":memory:");
  const { cookie } = await createDevice(server);
  const address = await server.app.listen({ host: "127.0.0.1", port: 0 });
  const socket = new WebSocket(address.replace(/^http/, "ws") + "/ws", {
    origin: "http://localhost:5173",
    headers: { cookie },
  });
  const authenticatedMessage = nextMessage(socket);
  try {
    await waitForOpen(socket);
    assert.deepEqual(await authenticatedMessage, { type: "authenticated", role: "viewer" });
  } finally {
    const closed = waitForClose(socket);
    socket.close();
    await closed;
    await server.app.close();
    server.close();
  }
});

test("device revocation closes active websocket presence with terminal policy status", async () => {
  const server = await buildApp(":memory:", 3600, "test", undefined, 600, 45);
  const device = await createDevice(server);
  const ownerSession = await server.app.inject({
    method: "GET",
    url: "/auth/session",
    headers: { cookie: device.cookie },
  });
  const viewerLogin = await server.app.inject({
    method: "POST",
    url: "/auth/request-login",
    payload: { email: `revocation-viewer-${Date.now()}@example.com` },
  });
  const viewerVerification = await server.app.inject({
    method: "POST",
    url: "/auth/verify-login",
    payload: { token: viewerLogin.json<{ developmentToken: string }>().developmentToken },
  });
  const viewerCookie = cookieValue(viewerVerification.headers["set-cookie"]);
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
  const socket = new WebSocket(
    `ws://127.0.0.1:${address.port}/ws`,
    { origin: "http://localhost:5173" },
  );
  const viewer = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
    origin: "http://localhost:5173",
    headers: { cookie: viewerCookie },
  });
  const viewerAuth = nextMessage(viewer);

  try {
    await Promise.all([waitForOpen(socket), waitForOpen(viewer)]);
    const ownerAuth = nextMessage(socket);
    socket.send(JSON.stringify({ type: "auth", token: device.refreshToken }));
    assert.equal((await ownerAuth).role, "owner");
    assert.equal((await viewerAuth).role, "viewer");
    const ownerSharingAck = nextMessage(socket);
    const viewerSharingState = nextMessage(viewer);
    socket.send(JSON.stringify({ type: "sharing_state", screen: true, camera: true }));
    await Promise.all([ownerSharingAck, viewerSharingState]);
    const initialViewerMessages = nextMessages(viewer, 2);
    viewer.send(JSON.stringify({ type: "create_session", device_id: device.deviceId }));
    const [, sessionCreated] = await initialViewerMessages;
    assert.equal(sessionCreated?.type, "session_created");
    const sessionId = sessionCreated?.session_id;
    assert.equal((await nextMessage(socket)).type, "viewer_joined");

    const closed = waitForClose(socket);
    const viewerSessionEnded = nextMessages(viewer, 2);
    const revoked = await server.app.inject({
      method: "DELETE",
      url: `/devices/${device.deviceId}`,
      headers: { cookie: device.cookie },
    });

    assert.equal(revoked.statusCode, 204);
    assert.equal(await closed, 1008);
    const revocationMessages = await viewerSessionEnded;
    assert.ok(revocationMessages.some((message) =>
      message.type === "device_sharing_state" &&
      message.screen === false &&
      message.camera === false));
    assert.ok(revocationMessages.some((message) =>
      message.type === "viewer_left" &&
      message.session_id === sessionId &&
      message.reason === "disconnected"));

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
    viewer.close();
    await server.app.close();
    server.close();
  }
});

test("stale owner presence closes retryably and reattaches the original session for both peers", async () => {
  const server = await buildApp(":memory:", 3600, "test", undefined, 600, 2);
  const device = await createDevice(server);
  const ownerSession = await server.app.inject({
    method: "GET",
    url: "/auth/session",
    headers: { cookie: device.cookie },
  });
  const viewerLogin = await server.app.inject({
    method: "POST",
    url: "/auth/request-login",
    payload: { email: `stale-presence-viewer-${Date.now()}@example.com` },
  });
  const viewerVerification = await server.app.inject({
    method: "POST",
    url: "/auth/verify-login",
    payload: { token: viewerLogin.json<{ developmentToken: string }>().developmentToken },
  });
  const viewerCookie = cookieValue(viewerVerification.headers["set-cookie"]);
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
  const diagnosticLogs: string[] = [];
  const originalInfo = console.info;
  console.info = (...values: unknown[]) => {
    for (const value of values) if (typeof value === "string") diagnosticLogs.push(value);
  };
  const owner = new WebSocket(wsUrl, { origin: "http://localhost:5173" });
  const viewer = new WebSocket(wsUrl, {
    origin: "http://localhost:5173",
    headers: { cookie: viewerCookie },
  });
  const sockets = [owner, viewer];
  const viewerAuth = nextMessage(viewer);

  try {
    await Promise.all([waitForOpen(owner), waitForOpen(viewer)]);
    const ownerAuth = nextMessage(owner);
    owner.send(JSON.stringify({ type: "auth", token: device.refreshToken }));
    assert.equal((await ownerAuth).role, "owner");
    assert.equal((await viewerAuth).role, "viewer");

    const ownerSharingAck = nextMessage(owner);
    const viewerSharingState = nextMessage(viewer);
    owner.send(JSON.stringify({ type: "sharing_state", screen: true, camera: true }));
    await Promise.all([ownerSharingAck, viewerSharingState]);
    const initialViewerMessages = nextMessages(viewer, 2);
    viewer.send(JSON.stringify({ type: "create_session", device_id: device.deviceId }));
    const [, sessionCreated] = await initialViewerMessages;
    assert.equal(sessionCreated?.type, "session_created");
    const originalSessionId = sessionCreated?.session_id;
    assert.equal((await nextMessage(owner)).type, "viewer_joined");

    assert.equal(await waitForClose(owner), PRESENCE_EXPIRED_CLOSE_CODE);

    const replacementOwner = new WebSocket(wsUrl, { origin: "http://localhost:5173" });
    sockets.push(replacementOwner);
    await waitForOpen(replacementOwner);
    const replacementMessages = nextMessages(replacementOwner, 2);
    const viewerRecovery = nextMessage(viewer);
    replacementOwner.send(JSON.stringify({ type: "auth", token: device.refreshToken }));
    const [authenticated, recovery] = await replacementMessages;
    assert.equal(authenticated?.type, "authenticated");
    assert.equal(recovery?.type, "session_recovery");
    assert.equal(recovery?.session_id, originalSessionId);
    assert.deepEqual(await viewerRecovery, recovery);

    const diagnostics = diagnosticLogs.map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(diagnostics.some((entry) =>
      entry.event === "stale_presence_close_intent" &&
      entry.closeCode === 1013 &&
      entry.deviceId === device.deviceId));
    assert.ok(diagnostics.some((entry) =>
      entry.event === "owner-socket-disconnected" &&
      entry.closeCode === 1013 &&
      entry.sessionPreserved === true &&
      entry.replacementSocketExists === false));
    assert.ok(diagnostics.some((entry) =>
      entry.event === "owner_session_reattachment" &&
      entry.originalSessionId === originalSessionId &&
      entry.reattachmentSucceeded === true));
    assert.deepEqual(
      diagnostics
        .filter((entry) => entry.event === "session_recovery_notification_sent")
        .map((entry) => ({ role: entry.targetRole, sent: entry.sent }))
        .sort((left, right) => String(left.role).localeCompare(String(right.role))),
      [{ role: "owner", sent: true }, { role: "viewer", sent: true }],
    );
    const serializedDiagnostics = diagnosticLogs.join("\n");
    assert.equal(serializedDiagnostics.includes(device.refreshToken), false);
    assert.equal(serializedDiagnostics.includes("candidate:"), false);
    assert.equal(serializedDiagnostics.includes("192.0.2."), false);
    assert.equal(serializedDiagnostics.includes("v=0"), false);
  } finally {
    console.info = originalInfo;
    await Promise.all(sockets.map(terminateSocket));
    await server.app.close();
    server.close();
  }
});

test("expired heartbeat closes retryably through the WebSocket handler", async () => {
  let presenceNow = Date.now();
  const originalDateNow = Date.now;
  const serverPromise = (() => {
    Date.now = () => presenceNow;
    try {
      return buildApp(":memory:", 3600, "test", undefined, 600, 600);
    } finally {
      Date.now = originalDateNow;
    }
  })();
  const server = await serverPromise;
  const device = await createDevice(server);
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  const address = server.app.server.address();
  assert.ok(address && typeof address !== "string");
  const wsUrl = `ws://127.0.0.1:${address.port}/ws`;
  const diagnosticLogs: string[] = [];
  const originalInfo = console.info;
  console.info = (...values: unknown[]) => {
    for (const value of values) if (typeof value === "string") diagnosticLogs.push(value);
  };
  const owner = new WebSocket(wsUrl, { origin: "http://localhost:5173" });
  const sockets = [owner];

  try {
    await waitForOpen(owner);
    const ownerAuth = nextMessage(owner);
    owner.send(JSON.stringify({ type: "auth", token: device.refreshToken }));
    assert.equal((await ownerAuth).role, "owner");

    const ownerClosed = waitForClose(owner);
    presenceNow += 600_001;
    owner.send(JSON.stringify({ type: "heartbeat" }));
    assert.equal(await ownerClosed, PRESENCE_EXPIRED_CLOSE_CODE);

    const diagnostics = diagnosticLogs.map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(diagnostics.some((entry) =>
      entry.event === "heartbeat_expiry_close_intent" &&
      entry.closeCode === PRESENCE_EXPIRED_CLOSE_CODE &&
      entry.closeReasonCategory === "heartbeat_expired_retryable"));
  } finally {
    console.info = originalInfo;
    await Promise.all(sockets.map(terminateSocket));
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
  const diagnosticLogs: string[] = [];
  const originalInfo = console.info;
  console.info = (...values: unknown[]) => {
    for (const value of values) if (typeof value === "string") diagnosticLogs.push(value);
  };

  try {
    await Promise.all([waitForOpen(owner), waitForOpen(viewer)]);
    owner.send(JSON.stringify({ type: "auth", token: device.refreshToken }));
    viewer.send(JSON.stringify({
      type: "auth",
      token: viewerCookie.split("=", 2)[1]!,
    }));
    await Promise.all([nextMessage(owner), nextMessage(viewer)]);
    const activeViewerNotification = nextMessage(viewer);
    const activeOwnerAck = nextMessage(owner);
    owner.send(JSON.stringify({ type: "sharing_state", screen: true, camera: false }));
    assert.deepEqual(await activeOwnerAck, {
      type: "sharing_state_updated",
      device_id: device.deviceId,
      screen: true,
      camera: false,
    });
    assert.deepEqual(await activeViewerNotification, {
      type: "device_sharing_state",
      device_id: device.deviceId,
      screen: true,
      camera: false,
      online: true,
      state_revision: 1,
    });
    const activeSessionMessages = nextMessages(viewer, 2);
    viewer.send(JSON.stringify({ type: "create_session", device_id: device.deviceId }));
    const [activeState, createdSession] = await activeSessionMessages;
    assert.deepEqual(activeState, {
      type: "device_sharing_state",
      device_id: device.deviceId,
      screen: true,
      camera: false,
      online: true,
      state_revision: 1,
    });
    const sessionId = createdSession?.session_id as string;
    assert.equal((await nextMessage(owner)).type, "viewer_joined");

    owner.send(JSON.stringify({
      type: "offer",
      session_id: sessionId,
      negotiation_id: "negotiation-1",
      sdp: "v=0",
    }));
    assert.equal((await nextMessage(viewer)).type, "offer");
    viewer.send(JSON.stringify({
      type: "offer",
      session_id: sessionId,
      negotiation_id: "negotiation-1",
      sdp: "v=0",
    }));
    assert.equal((await nextMessage(viewer)).code, "WRONG_ROLE");
    viewer.send(JSON.stringify({
      type: "answer",
      session_id: sessionId,
      negotiation_id: "negotiation-1",
      sdp: "v=0",
    }));
    assert.equal((await nextMessage(owner)).type, "answer");
    owner.send(JSON.stringify({
      type: "answer",
      session_id: sessionId,
      negotiation_id: "negotiation-1",
      sdp: "v=0",
    }));
    assert.equal((await nextMessage(owner)).code, "WRONG_ROLE");
    owner.send(JSON.stringify({
      type: "ice_candidate",
      session_id: sessionId,
      negotiation_id: "negotiation-1",
      candidate: {
        candidate: "candidate:1 1 UDP 2122260223 192.0.2.44 54400 typ relay ufrag private-token",
      },
    }));
    assert.equal((await nextMessage(viewer)).type, "ice_candidate");
    viewer.send(JSON.stringify({
      type: "ice_candidate",
      session_id: sessionId,
      negotiation_id: "negotiation-1",
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
    const viewerMessages = nextMessages(viewer, 2);
    const reused = await server.app.inject({
      method: "POST",
      url: "/devices/refresh",
      payload: { refreshToken: device.refreshToken },
    });
    assert.equal(reused.statusCode, 401);
    const [sharingInactive, viewerLeft] = await viewerMessages;
    assert.equal(sharingInactive?.type, "device_sharing_state");
    assert.equal(viewerLeft?.type, "viewer_left");
    assert.equal(await ownerClosed, 1008);
    const relayLogs = diagnosticLogs.filter((line) =>
      line.includes("offer_relayed") || line.includes("answer_relayed") || line.includes("ice_candidate_relayed"));
    assert.ok(relayLogs.some((line) => line.includes('"event":"offer_relayed"')));
    assert.ok(relayLogs.some((line) => line.includes('"event":"answer_relayed"')));
    assert.ok(relayLogs.some((line) =>
      line.includes('"event":"ice_candidate_relayed"') && line.includes('"candidateType":"relay"')));
    const serializedRelayLogs = relayLogs.join("\n");
    assert.equal(serializedRelayLogs.includes("192.0.2.44"), false);
    assert.equal(serializedRelayLogs.includes("private-token"), false);
    assert.equal(serializedRelayLogs.includes("candidate:1"), false);
    assert.equal(serializedRelayLogs.includes("v=0"), false);
    const allDiagnostics = diagnosticLogs.join("\n");
    const transition = diagnosticLogs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.event === "sharing_state_transition" &&
        entry.reason === "session-ended:disconnected");
    assert.ok(transition);
    assert.equal(transition.sessionId, sessionId);
    assert.deepEqual(transition.newSharingState, { screen: false, camera: false });
    const ended = diagnosticLogs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.event === "session_ended" && entry.sessionId === sessionId);
    assert.equal(ended?.reason, "disconnected");
    assert.equal(ended?.sharingStateCleared, true);
    assert.equal(allDiagnostics.includes("private-token"), false);
    assert.equal(allDiagnostics.includes("candidate:1"), false);
    assert.equal(allDiagnostics.includes("192.0.2.44"), false);
    assert.equal(allDiagnostics.includes("v=0"), false);
  } finally {
    console.info = originalInfo;
    owner.close();
    viewer.close();
    await server.app.close();
    server.close();
  }
});

test("overlapping owner reconnect replaces the stale socket and resumes the same authorized session", async () => {
  const server = await buildApp(
    ":memory:",
    3600,
    "test",
    undefined,
    600,
    45,
    "http://localhost:5173",
    "development-turn-key-id",
    "development-turn-api-token",
    [],
    86_400,
    undefined,
    2_000,
  );
  const device = await createDevice(server);
  const ownerSession = await server.app.inject({
    method: "GET",
    url: "/auth/session",
    headers: { cookie: device.cookie },
  });
  const viewerLogin = await server.app.inject({
    method: "POST",
    url: "/auth/request-login",
    payload: { email: `recovery-viewer-${Date.now()}@example.com` },
  });
  const viewerVerification = await server.app.inject({
    method: "POST",
    url: "/auth/verify-login",
    payload: { token: viewerLogin.json<{ developmentToken: string }>().developmentToken },
  });
  const viewerCookie = cookieValue(viewerVerification.headers["set-cookie"]);
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
  const viewer = new WebSocket(wsUrl, {
    origin: "http://localhost:5173",
    headers: { cookie: viewerCookie },
  });
  const sockets = [owner, viewer];
  const viewerAuth = nextMessage(viewer);

  try {
    await Promise.all([waitForOpen(owner), waitForOpen(viewer)]);
    const ownerAuth = nextMessage(owner);
    owner.send(JSON.stringify({ type: "auth", token: device.refreshToken }));
    assert.equal((await ownerAuth).role, "owner");
    assert.equal((await viewerAuth).role, "viewer");
    const ownerAck = nextMessage(owner);
    const viewerState = nextMessage(viewer);
    owner.send(JSON.stringify({ type: "sharing_state", screen: true, camera: true }));
    await Promise.all([ownerAck, viewerState]);
    const created = nextMessages(viewer, 2);
    viewer.send(JSON.stringify({ type: "create_session", device_id: device.deviceId }));
    const initialMessages = await created;
    const sessionId = initialMessages[1]?.session_id as string;
    assert.equal(initialMessages[1]?.type, "session_created");
    assert.equal((await nextMessage(owner)).type, "viewer_joined");

    const ownerAgain = new WebSocket(wsUrl, { origin: "http://localhost:5173" });
    sockets.push(ownerAgain);
    await waitForOpen(ownerAgain);
    const ownerRecoveryMessages = nextMessages(ownerAgain, 2);
    const ownerClosed = waitForClose(owner);
    const viewerMessages: unknown[] = [];
    const collectViewerMessages = (raw: RawData) => viewerMessages.push(JSON.parse(raw.toString()));
    viewer.on("message", collectViewerMessages);
    const viewerRecovery = nextMessage(viewer);
    ownerAgain.send(JSON.stringify({ type: "auth", token: device.refreshToken }));
    const [ownerAuthenticated, ownerRecovery] = await ownerRecoveryMessages;
    assert.equal(ownerAuthenticated?.type, "authenticated");
    assert.equal((ownerRecovery as { recovery_attempt_id?: unknown })?.recovery_attempt_id !== undefined, true);
    assert.deepEqual(ownerRecovery, {
      type: "session_recovery",
      session_id: sessionId,
      recovery_attempt_id: (ownerRecovery as { recovery_attempt_id: string }).recovery_attempt_id,
    });
    assert.deepEqual(await viewerRecovery, ownerRecovery);
    assert.equal(await ownerClosed, 1008);

    const recoveredOffer = nextMessage(viewer);
    ownerAgain.send(JSON.stringify({
      type: "offer",
      session_id: sessionId,
      negotiation_id: "recovery-negotiation",
      sdp: "recovery-offer",
    }));
    assert.deepEqual(await recoveredOffer, {
      type: "offer",
      session_id: sessionId,
      negotiation_id: "recovery-negotiation",
      sdp: "recovery-offer",
    });
    await new Promise((resolve) => setImmediate(resolve));
    viewer.off("message", collectViewerMessages);
    assert.deepEqual(viewerMessages, [
      ownerRecovery,
      {
        type: "offer",
        session_id: sessionId,
        negotiation_id: "recovery-negotiation",
        sdp: "recovery-offer",
      },
    ]);

    const viewerClosed = waitForClose(viewer);
    const temporaryDisconnect = nextMessage(ownerAgain);
    viewer.close();
    await viewerClosed;
    assert.equal((await temporaryDisconnect).reason, "temporary_disconnect");
    const ownerAgainClosed = waitForClose(ownerAgain);
    ownerAgain.close();
    await ownerAgainClosed;
    await new Promise((resolve) => setImmediate(resolve));

    const viewerAgain = new WebSocket(wsUrl, {
      origin: "http://localhost:5173",
      headers: { cookie: viewerCookie },
    });
    sockets.push(viewerAgain);
    const viewerAgainAuth = nextMessage(viewerAgain);
    await waitForOpen(viewerAgain);
    assert.equal((await viewerAgainAuth).type, "authenticated");
    const viewerRecoveryMessages = nextMessages(viewerAgain, 2);
    viewerAgain.send(JSON.stringify({ type: "create_session", device_id: device.deviceId }));
    const [currentState, attachedSession] = await viewerRecoveryMessages;
    assert.equal(currentState?.type, "device_sharing_state");
    const { owner_recovery_remaining_ms, ...attachment } = attachedSession!;
    assert.deepEqual(attachment, {
      type: "session_attached",
      session_id: sessionId,
      device_id: device.deviceId,
      screen: true,
      camera: true,
    });
    assert.equal(typeof owner_recovery_remaining_ms, "number");
    assert.ok((owner_recovery_remaining_ms as number) > 0);
    const ownerFinal = new WebSocket(wsUrl, { origin: "http://localhost:5173" });
    sockets.push(ownerFinal);
    await waitForOpen(ownerFinal);
    const ownerFinalMessages = nextMessages(ownerFinal, 2);
    const viewerRecoveryAfterOwnerReconnect = (async () => {
      let message = await nextMessage(viewerAgain);
      while (message.type === "device_sharing_state") message = await nextMessage(viewerAgain);
      return message;
    })();
    ownerFinal.send(JSON.stringify({ type: "auth", token: device.refreshToken }));
    const [ownerFinalAuth, ownerFinalRecovery] = await ownerFinalMessages;
    assert.equal(ownerFinalAuth?.type, "authenticated");
    assert.equal((ownerFinalRecovery as { recovery_attempt_id?: unknown })?.recovery_attempt_id !== undefined, true);
    assert.deepEqual(await viewerRecoveryAfterOwnerReconnect, {
      type: "session_recovery",
      session_id: sessionId,
      recovery_attempt_id: (ownerFinalRecovery as { recovery_attempt_id: string }).recovery_attempt_id,
    });

    ownerFinal.send(JSON.stringify({ type: "create_session", device_id: device.deviceId }));
    assert.equal((await nextMessage(ownerFinal)).code, "WRONG_ROLE");
    const stopped = nextMessages(viewerAgain, 2);
    ownerFinal.send(JSON.stringify({ type: "sharing_state", screen: false, camera: false }));
    await nextMessage(ownerFinal);
    assert.equal((await stopped)[1]?.type, "viewer_left");
    ownerFinal.close();
    viewerAgain.close();
  } finally {
    await Promise.all(sockets.map(terminateSocket));
    await server.app.close();
    server.close();
  }
});

test("fresh authorized viewer replacement attaches to the existing session without stale-close teardown", async () => {
  const server = await buildApp(":memory:", 3600, "test", undefined, 600, 45);
  const device = await createDevice(server);
  const ownerSession = await server.app.inject({
    method: "GET",
    url: "/auth/session",
    headers: { cookie: device.cookie },
  });
  const viewerLogin = await server.app.inject({
    method: "POST",
    url: "/auth/request-login",
    payload: { email: `reattach-${Date.now()}@example.com` },
  });
  const viewerVerification = await server.app.inject({
    method: "POST",
    url: "/auth/verify-login",
    payload: { token: viewerLogin.json<{ developmentToken: string }>().developmentToken },
  });
  const viewerCookie = cookieValue(viewerVerification.headers["set-cookie"]);
  const viewerSession = await server.app.inject({
    method: "GET",
    url: "/auth/session",
    headers: { cookie: viewerCookie },
  });
  const ownerUserId = ownerSession.json<{ user: { id: string } }>().user.id;
  const viewerUserId = viewerSession.json<{ user: { id: string } }>().user.id;
  server.authorization.grant(ownerUserId, viewerUserId);
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  const address = server.app.server.address();
  assert.ok(address && typeof address !== "string");
  const wsUrl = `ws://127.0.0.1:${address.port}/ws`;
  const owner = new WebSocket(wsUrl, { origin: "http://localhost:5173" });
  const oldViewer = new WebSocket(wsUrl, {
    origin: "http://localhost:5173",
    headers: { cookie: viewerCookie },
  });
  const replacementViewer = new WebSocket(wsUrl, {
    origin: "http://localhost:5173",
    headers: { cookie: viewerCookie },
  });
  const unauthorizedLogin = await server.app.inject({
    method: "POST",
    url: "/auth/request-login",
    payload: { email: `unapproved-${Date.now()}@example.com` },
  });
  const unauthorizedVerification = await server.app.inject({
    method: "POST",
    url: "/auth/verify-login",
    payload: { token: unauthorizedLogin.json<{ developmentToken: string }>().developmentToken },
  });
  const unauthorizedViewer = new WebSocket(wsUrl, {
    origin: "http://localhost:5173",
    headers: { cookie: cookieValue(unauthorizedVerification.headers["set-cookie"]) },
  });
  const sockets = [owner, oldViewer, replacementViewer, unauthorizedViewer];

  try {
    const ownerAuth = nextMessage(owner);
    const oldViewerAuth = nextMessage(oldViewer);
    const replacementAuth = nextMessage(replacementViewer);
    const unauthorizedAuth = nextMessage(unauthorizedViewer);
    await Promise.all(sockets.map(waitForOpen));
    owner.send(JSON.stringify({ type: "auth", token: device.refreshToken }));
    assert.equal((await ownerAuth).role, "owner");
    assert.equal((await oldViewerAuth).role, "viewer");
    assert.equal((await replacementAuth).role, "viewer");
    assert.equal((await unauthorizedAuth).role, "viewer");

    const ownerAck = nextMessage(owner);
    const oldViewerState = nextMessage(oldViewer);
    const replacementState = nextMessage(replacementViewer);
    owner.send(JSON.stringify({ type: "sharing_state", screen: true, camera: true }));
    await Promise.all([ownerAck, oldViewerState, replacementState]);
    const initialViewerMessages = nextMessages(oldViewer, 2);
    oldViewer.send(JSON.stringify({ type: "create_session", device_id: device.deviceId }));
    const initial = await initialViewerMessages;
    assert.equal(initial[1]?.type, "session_created");
    const sessionId = initial[1]?.session_id as string;
    assert.equal((await nextMessage(owner)).type, "viewer_joined");

    const unauthorizedResult = nextMessage(unauthorizedViewer);
    unauthorizedViewer.send(JSON.stringify({ type: "create_session", device_id: device.deviceId }));
    assert.deepEqual(await unauthorizedResult, { type: "error", code: "NOT_AUTHORIZED" });

    const staleSessionResult = nextMessage(replacementViewer);
    replacementViewer.send(JSON.stringify({
      type: "create_session",
      device_id: device.deviceId,
      active_session_id: "00000000-0000-0000-0000-000000000099",
    }));
    assert.deepEqual(await staleSessionResult, { type: "error", code: "SESSION_NOT_FOUND" });

    const attachedMessages = nextMessages(replacementViewer, 2);
    const ownerRejoined = nextMessage(owner);
    const oldViewerClosed = waitForClose(oldViewer);
    replacementViewer.send(JSON.stringify({ type: "create_session", device_id: device.deviceId }));
    const attached = await attachedMessages;
    assert.deepEqual(attached[0], {
      type: "device_sharing_state",
      device_id: device.deviceId,
      screen: true,
      camera: true,
      online: true,
      state_revision: 1,
    });
    assert.deepEqual(attached[1], {
      type: "session_attached",
      session_id: sessionId,
      device_id: device.deviceId,
      screen: true,
      camera: true,
    });
    assert.deepEqual(await ownerRejoined, {
      type: "viewer_rejoined",
      session_id: sessionId,
      viewer_user_id: viewerUserId,
    });
    assert.equal(await oldViewerClosed, 1008);
    await assertNoMessage(owner);

    const replacementOffer = nextMessage(replacementViewer);
    owner.send(JSON.stringify({
      type: "offer",
      session_id: sessionId,
      negotiation_id: "reattach-negotiation",
      sdp: "reattach-offer",
    }));
    assert.deepEqual(await replacementOffer, {
      type: "offer",
      session_id: sessionId,
      negotiation_id: "reattach-negotiation",
      sdp: "reattach-offer",
    });
  } finally {
    await Promise.all(sockets.map(terminateSocket));
    await server.app.close();
    server.close();
  }
});

test("owner retirement preserves sharing availability and allows a fresh authorized session", async () => {
  const server = await buildApp(
    ":memory:",
    3600,
    "test",
    undefined,
    600,
    45,
    "http://localhost:5173",
    "development-turn-key-id",
    "development-turn-api-token",
    [],
    86_400,
    undefined,
    2_000,
  );
  const device = await createDevice(server);
  const ownerSession = await server.app.inject({
    method: "GET",
    url: "/auth/session",
    headers: { cookie: device.cookie },
  });
  const viewerLogin = await server.app.inject({
    method: "POST",
    url: "/auth/request-login",
    payload: { email: `retire-recovery-${Date.now()}@example.com` },
  });
  const viewerVerification = await server.app.inject({
    method: "POST",
    url: "/auth/verify-login",
    payload: { token: viewerLogin.json<{ developmentToken: string }>().developmentToken },
  });
  const viewerCookie = cookieValue(viewerVerification.headers["set-cookie"]);
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
  const viewer = new WebSocket(wsUrl, {
    origin: "http://localhost:5173",
    headers: { cookie: viewerCookie },
  });
  const sockets = [owner, viewer];
  try {
    const ownerAuth = nextMessage(owner);
    const viewerAuth = nextMessage(viewer);
    await Promise.all(sockets.map(waitForOpen));
    owner.send(JSON.stringify({ type: "auth", token: device.refreshToken }));
    assert.equal((await ownerAuth).role, "owner");
    assert.equal((await viewerAuth).role, "viewer");

    const ownerShareAck = nextMessage(owner);
    const viewerState = nextMessage(viewer);
    owner.send(JSON.stringify({ type: "sharing_state", screen: true, camera: true }));
    await Promise.all([ownerShareAck, viewerState]);

    const created = nextMessages(viewer, 2);
    const viewerJoined = nextMessage(owner);
    viewer.send(JSON.stringify({ type: "create_session", device_id: device.deviceId }));
    const [stateMessage, sessionMessage] = await created;
    assert.equal(stateMessage?.type, "device_sharing_state");
    assert.equal(sessionMessage?.type, "session_created");
    const oldSessionId = sessionMessage!.session_id as string;
    assert.equal((await viewerJoined as { session_id: string }).session_id, oldSessionId);

    const ownerLeft = nextMessage(owner);
    const viewerLeft = nextMessage(viewer);
    owner.send(JSON.stringify({ type: "retire_session", session_id: oldSessionId }));
    assert.equal((await ownerLeft).reason, "temporary_disconnect");
    assert.equal((await viewerLeft).reason, "temporary_disconnect");

    const presence = await server.app.inject({
      method: "GET",
      url: "/presence",
      headers: { cookie: device.cookie },
    });
    assert.deepEqual(
      presence.json<{ devices: Array<{ screen: boolean; camera: boolean }> }>()
        .devices.map(({ screen, camera }) => ({ screen, camera })),
      [{ screen: true, camera: true }],
    );

    const ownerClosed = waitForClose(owner);
    owner.close();
    await ownerClosed;
    const returningOwner = new WebSocket(wsUrl, { origin: "http://localhost:5173" });
    sockets.push(returningOwner);
    const returningOwnerAuth = nextMessage(returningOwner);
    await waitForOpen(returningOwner);
    returningOwner.send(JSON.stringify({ type: "auth", token: device.refreshToken }));
    assert.equal((await returningOwnerAuth).role, "owner");

    const ownerRefresh = nextMessage(returningOwner);
    const freshAvailability = nextMessage(viewer);
    returningOwner.send(JSON.stringify({ type: "sharing_state", screen: true, camera: true }));
    assert.equal((await ownerRefresh).screen, true);
    assert.deepEqual(await freshAvailability, {
      type: "device_sharing_state",
      device_id: device.deviceId,
      screen: true,
      camera: true,
      online: true,
      state_revision: 3,
    });

    const freshMessages = nextMessages(viewer, 2);
    const freshJoined = nextMessage(returningOwner);
    viewer.send(JSON.stringify({ type: "create_session", device_id: device.deviceId }));
    const [freshState, freshSession] = await freshMessages;
    assert.equal(freshState?.type, "device_sharing_state");
    assert.equal(freshSession?.type, "session_created");
    assert.notEqual(freshSession?.session_id, oldSessionId);
    assert.equal(
      (await freshJoined as { session_id: string }).session_id,
      freshSession?.session_id,
    );
    const finalOwnerLeft = nextMessage(returningOwner);
    const finalViewerLeft = nextMessage(viewer);
    viewer.send(JSON.stringify({
      type: "leave_session",
      session_id: freshSession!.session_id as string,
    }));
    assert.equal((await finalOwnerLeft).type, "viewer_left");
    assert.equal((await finalViewerLeft).type, "viewer_left");
  } finally {
    await Promise.all(sockets.map(terminateSocket));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await server.app.close();
    server.close();
  }
});

test("authorized viewers receive offline availability without revealing it to unauthorized viewers", async () => {
  const server = await buildApp(":memory:", 3600, "test", undefined, 600, 45);
  const device = await createDevice(server);
  const ownerSession = await server.app.inject({
    method: "GET",
    url: "/auth/session",
    headers: { cookie: device.cookie },
  });
  const ownerUserId = ownerSession.json<{ user: { id: string } }>().user.id;

  async function createViewer(email: string): Promise<{ cookie: string; userId: string }> {
    const login = await server.app.inject({
      method: "POST",
      url: "/auth/request-login",
      payload: { email },
    });
    const verification = await server.app.inject({
      method: "POST",
      url: "/auth/verify-login",
      payload: { token: login.json<{ developmentToken: string }>().developmentToken },
    });
    const session = await server.app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { cookie: cookieValue(verification.headers["set-cookie"]) },
    });
    return {
      cookie: cookieValue(verification.headers["set-cookie"]),
      userId: session.json<{ user: { id: string } }>().user.id,
    };
  }

  const authorizedViewer = await createViewer(`offline-allowed-${Date.now()}@example.com`);
  const unauthorizedViewer = await createViewer(`offline-denied-${Date.now()}@example.com`);
  server.authorization.grant(ownerUserId, authorizedViewer.userId);
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  const address = server.app.server.address();
  assert.ok(address && typeof address !== "string");
  const url = `ws://127.0.0.1:${address.port}/ws`;
  const allowed = new WebSocket(url, {
    origin: "http://localhost:5173",
    headers: { cookie: authorizedViewer.cookie },
  });
  const denied = new WebSocket(url, {
    origin: "http://localhost:5173",
    headers: { cookie: unauthorizedViewer.cookie },
  });

  try {
    const allowedAuth = nextMessage(allowed);
    const deniedAuth = nextMessage(denied);
    await Promise.all([waitForOpen(allowed), waitForOpen(denied)]);
    assert.equal((await allowedAuth).role, "viewer");
    assert.equal((await deniedAuth).role, "viewer");

    const offlineResult = nextMessage(allowed);
    const deniedResult = nextMessage(denied);
    allowed.send(JSON.stringify({ type: "create_session", device_id: device.deviceId }));
    denied.send(JSON.stringify({ type: "create_session", device_id: device.deviceId }));
    assert.deepEqual(await offlineResult, {
      type: "device_sharing_state",
      device_id: device.deviceId,
      screen: false,
      camera: false,
      online: false,
      state_revision: 0,
    });
    assert.deepEqual(await deniedResult, { type: "error", code: "NOT_AUTHORIZED" });
  } finally {
    await terminateSocket(allowed);
    await terminateSocket(denied);
    await server.app.close();
    server.close();
  }
});

test("CLI revocation after retirement survives server restart until durable device acknowledgement", async () => {
  const directory = mkdtempSync(join(tmpdir(), "live-presence-revocation-"));
  const databasePath = join(directory, "presence.sqlite");
  let server = await buildApp(databasePath);
  const device = await createDevice(server);
  const ownerSession = await server.app.inject({
    method: "GET",
    url: "/auth/session",
    headers: { cookie: device.cookie },
  });
  const ownerUserId = ownerSession.json<{ user: { id: string } }>().user.id;
  const viewerEmail = `durable-revoke-${Date.now()}@example.com`;
  const viewerAccount = await createViewer(server, viewerEmail);
  server.authorization.grant(ownerUserId, viewerAccount.userId);
  const sockets: WebSocket[] = [];

  try {
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    const address = server.app.server.address();
    assert.ok(address && typeof address !== "string");
    const url = `ws://127.0.0.1:${address.port}/ws`;
    const owner = new WebSocket(url, { origin: "http://localhost:5173" });
    const viewer = new WebSocket(url, {
      origin: "http://localhost:5173",
      headers: { cookie: viewerAccount.cookie },
    });
    sockets.push(owner, viewer);
    const ownerAuth = nextMessage(owner);
    const viewerAuth = nextMessage(viewer);
    await Promise.all([waitForOpen(owner), waitForOpen(viewer)]);
    owner.send(JSON.stringify({ type: "auth", token: device.refreshToken }));
    assert.equal((await ownerAuth).role, "owner");
    assert.equal((await viewerAuth).role, "viewer");

    const ownerSharingAck = nextMessage(owner);
    const viewerSharing = nextMessage(viewer);
    owner.send(JSON.stringify({ type: "sharing_state", screen: true, camera: true }));
    await Promise.all([ownerSharingAck, viewerSharing]);

    const sessionMessages = nextMessages(viewer, 2);
    const joined = nextMessage(owner);
    viewer.send(JSON.stringify({
      type: "create_session",
      device_id: device.deviceId,
      request_id: "durable-session-request",
    }));
    const [, created] = await sessionMessages;
    assert.equal(created?.type, "session_created");
    assert.equal(created?.request_id, "durable-session-request");
    const sessionId = created!.session_id as string;
    assert.equal((await joined).session_id, sessionId);

    const retirementMessages = nextMessages(owner, 2);
    owner.send(JSON.stringify({ type: "retire_session", session_id: sessionId }));
    const retirement = await retirementMessages;
    assert.ok(retirement.some((message) =>
      message.type === "session_retired" &&
      message.outcome === "retired" &&
      message.session_id === sessionId));
    const duplicateRetirement = nextMessage(owner);
    owner.send(JSON.stringify({ type: "retire_session", session_id: sessionId }));
    assert.deepEqual(await duplicateRetirement, {
      type: "session_retired",
      session_id: sessionId,
      outcome: "not_found",
    });

    const ownerClosed = waitForClose(owner);
    owner.close();
    await ownerClosed;
    await terminateSocket(viewer);
    await server.app.close();
    server.close();
    const userDatabase = new Database(databasePath);
    const ownerEmail = userDatabase
      .prepare("SELECT email FROM users WHERE id = ?")
      .pluck()
      .get(ownerUserId) as string;
    userDatabase.close();
    executeAccessCommand("revoke", [
      "--owner-email", ownerEmail,
      "--viewer-email", viewerEmail,
    ], databasePath);
    const durableDatabase = new Database(databasePath);
    durableDatabase.prepare(
      "UPDATE presence_revocation_tombstones SET created_at = ? WHERE session_id = ?",
    ).run(Date.now() - 11 * 60 * 1000, sessionId);
    durableDatabase.exec(`
      CREATE TRIGGER reject_outbox_processing
      BEFORE UPDATE OF processed_at ON presence_revocation_outbox
      BEGIN SELECT RAISE(ABORT, 'outbox temporarily unavailable'); END;
    `);
    durableDatabase.close();

    server = await buildApp(databasePath);
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    const restartedAddress = server.app.server.address();
    assert.ok(restartedAddress && typeof restartedAddress !== "string");
    const returningOwner = new WebSocket(
      `ws://127.0.0.1:${restartedAddress.port}/ws`,
      { origin: "http://localhost:5173" },
    );
    sockets.push(returningOwner);
    const returnedMessages = nextMessages(returningOwner, 2);
    await waitForOpen(returningOwner);
    returningOwner.send(JSON.stringify({ type: "auth", token: device.refreshToken }));
    const [authenticated, revocation] = await returnedMessages;
    assert.equal(authenticated?.type, "authenticated");
    assert.deepEqual(revocation, {
      type: "session_retired",
      session_id: sessionId,
      outcome: "authorization_revoked",
    });
    returningOwner.send(JSON.stringify({
      type: "retire_session_ack",
      session_id: sessionId,
      outcome: "authorization_revoked",
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const pendingDatabase = new Database(databasePath);
    assert.equal(
      pendingDatabase.prepare(
        "SELECT COUNT(*) AS count FROM presence_revocation_tombstones WHERE session_id = ?",
      ).pluck().get(sessionId) as number,
      1,
      "an acknowledgement must not clear an unprocessed revocation",
    );
    pendingDatabase.close();

    const retryNotification = nextMessage(returningOwner);
    const retryDatabase = new Database(databasePath);
    retryDatabase.exec("DROP TRIGGER reject_outbox_processing");
    retryDatabase.close();
    assert.deepEqual(await retryNotification, {
      type: "session_retired",
      session_id: sessionId,
      outcome: "authorization_revoked",
    });

    const retirementAfterAck = nextMessage(returningOwner);
    returningOwner.send(JSON.stringify({
      type: "retire_session_ack",
      session_id: sessionId,
      outcome: "authorization_revoked",
    }));
    returningOwner.send(JSON.stringify({ type: "retire_session", session_id: sessionId }));
    assert.deepEqual(await retirementAfterAck, {
      type: "session_retired",
      session_id: sessionId,
      outcome: "not_found",
    });
    returningOwner.send(JSON.stringify({
      type: "retire_session_ack",
      session_id: sessionId,
      outcome: "authorization_revoked",
    }));
    const clearedRecords = new Database(databasePath);
    assert.equal(
      clearedRecords.prepare(
        "SELECT COUNT(*) AS count FROM presence_revocation_tombstones WHERE session_id = ?",
      ).pluck().get(sessionId) as number,
      0,
    );
    assert.equal(
      clearedRecords.prepare(
        "SELECT COUNT(*) AS count FROM presence_revocation_outbox WHERE session_id = ?",
      ).pluck().get(sessionId) as number,
      0,
    );
    clearedRecords.close();

    const reauthenticated = new WebSocket(
      `ws://127.0.0.1:${restartedAddress.port}/ws`,
      { origin: "http://localhost:5173" },
    );
    sockets.push(reauthenticated);
    const authOnly = nextMessage(reauthenticated);
    await waitForOpen(reauthenticated);
    reauthenticated.send(JSON.stringify({ type: "auth", token: device.refreshToken }));
    assert.equal((await authOnly).type, "authenticated");
    await assertNoMessage(reauthenticated);
  } finally {
    await Promise.all(sockets.map(terminateSocket));
    await server.app.close();
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("revocation tombstones and acknowledgements are scoped to the owning device", async () => {
  const server = await buildApp(":memory:");
  const firstDevice = await createDevice(server);
  const ownerSession = await server.app.inject({
    method: "GET",
    url: "/auth/session",
    headers: { cookie: firstDevice.cookie },
  });
  const ownerUserId = ownerSession.json<{ user: { id: string } }>().user.id;
  const secondDevice = await createAdditionalDevice(server, firstDevice.cookie);
  const firstViewer = await createViewer(server, `device-one-${Date.now()}@example.com`);
  const secondViewer = await createViewer(server, `device-two-${Date.now()}@example.com`);
  server.authorization.grant(ownerUserId, firstViewer.userId);
  server.authorization.grant(ownerUserId, secondViewer.userId);
  const sockets: WebSocket[] = [];

  try {
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    const address = server.app.server.address();
    assert.ok(address && typeof address !== "string");
    const url = `ws://127.0.0.1:${address.port}/ws`;
    const firstOwner = new WebSocket(url, { origin: "http://localhost:5173" });
    const secondOwner = new WebSocket(url, { origin: "http://localhost:5173" });
    const firstViewerSocket = new WebSocket(url, {
      origin: "http://localhost:5173",
      headers: { cookie: firstViewer.cookie },
    });
    const secondViewerSocket = new WebSocket(url, {
      origin: "http://localhost:5173",
      headers: { cookie: secondViewer.cookie },
    });
    sockets.push(firstOwner, secondOwner, firstViewerSocket, secondViewerSocket);
    const ownerAuthentications = [nextMessage(firstOwner), nextMessage(secondOwner)];
    const viewerAuthentications = [nextMessage(firstViewerSocket), nextMessage(secondViewerSocket)];
    await Promise.all(sockets.map(waitForOpen));
    firstOwner.send(JSON.stringify({ type: "auth", token: firstDevice.refreshToken }));
    secondOwner.send(JSON.stringify({ type: "auth", token: secondDevice.refreshToken }));
    await Promise.all(ownerAuthentications);
    await Promise.all(viewerAuthentications);

    const firstOwnerSharingAck = nextMessage(firstOwner);
    const firstViewerState = nextMessage(firstViewerSocket);
    const secondViewerState = nextMessage(secondViewerSocket);
    firstOwner.send(JSON.stringify({ type: "sharing_state", screen: true, camera: true }));
    await Promise.all([firstOwnerSharingAck, firstViewerState, secondViewerState]);
    const secondOwnerSharingAck = nextMessage(secondOwner);
    const secondViewerStates = [nextMessage(firstViewerSocket), nextMessage(secondViewerSocket)];
    secondOwner.send(JSON.stringify({ type: "sharing_state", screen: true, camera: false }));
    await Promise.all([secondOwnerSharingAck, ...secondViewerStates]);

    const firstSessionResponse = nextMessages(firstViewerSocket, 2);
    const firstJoined = nextMessage(firstOwner);
    firstViewerSocket.send(JSON.stringify({
      type: "create_session",
      device_id: firstDevice.deviceId,
    }));
    const [, firstCreated] = await firstSessionResponse;
    assert.equal(firstCreated?.type, "session_created");
    const firstSessionId = firstCreated!.session_id as string;
    assert.equal((await firstJoined).session_id, firstSessionId);

    const secondSessionResponse = nextMessages(secondViewerSocket, 2);
    const secondJoined = nextMessage(secondOwner);
    secondViewerSocket.send(JSON.stringify({
      type: "create_session",
      device_id: secondDevice.deviceId,
    }));
    const [, secondCreated] = await secondSessionResponse;
    assert.equal(secondCreated?.type, "session_created");
    assert.equal((await secondJoined).session_id, secondCreated?.session_id);

    const firstRetirement = nextMessages(firstOwner, 2);
    firstOwner.send(JSON.stringify({ type: "retire_session", session_id: firstSessionId }));
    assert.ok((await firstRetirement).some((message) =>
      message.type === "session_retired" && message.outcome === "retired"));
    server.authorization.revoke(ownerUserId, firstViewer.userId);

    secondOwner.send(JSON.stringify({
      type: "retire_session_ack",
      session_id: firstSessionId,
      outcome: "authorization_revoked",
    }));
    await assertNoMessage(secondOwner);
    await assertNoMessage(secondViewerSocket);
    const secondOwnerClosed = waitForClose(secondOwner);
    secondOwner.close();
    await secondOwnerClosed;
    const secondOwnerAgain = new WebSocket(url, { origin: "http://localhost:5173" });
    sockets.push(secondOwnerAgain);
    const secondDeviceMessages = nextMessages(secondOwnerAgain, 2);
    const secondViewerRecovery = nextMessage(secondViewerSocket);
    await waitForOpen(secondOwnerAgain);
    secondOwnerAgain.send(JSON.stringify({ type: "auth", token: secondDevice.refreshToken }));
    const [secondAuthenticated, secondRecovery] = await secondDeviceMessages;
    assert.equal(secondAuthenticated?.type, "authenticated");
    assert.equal(secondRecovery?.type, "session_recovery");
    assert.equal(secondRecovery?.session_id, secondCreated?.session_id);
    assert.deepEqual(await secondViewerRecovery, secondRecovery);

    const firstOwnerClosed = waitForClose(firstOwner);
    firstOwner.close();
    await firstOwnerClosed;
    const firstOwnerAgain = new WebSocket(url, { origin: "http://localhost:5173" });
    sockets.push(firstOwnerAgain);
    const firstDeviceRevocation = nextMessages(firstOwnerAgain, 2);
    await waitForOpen(firstOwnerAgain);
    firstOwnerAgain.send(JSON.stringify({ type: "auth", token: firstDevice.refreshToken }));
    const [authenticated, revocation] = await firstDeviceRevocation;
    assert.equal(authenticated?.type, "authenticated");
    assert.deepEqual(revocation, {
      type: "session_retired",
      session_id: firstSessionId,
      outcome: "authorization_revoked",
    });

    const acknowledgedOutcome = nextMessage(firstOwnerAgain);
    firstOwnerAgain.send(JSON.stringify({
      type: "retire_session_ack",
      session_id: firstSessionId,
      outcome: "authorization_revoked",
    }));
    firstOwnerAgain.send(JSON.stringify({ type: "retire_session", session_id: firstSessionId }));
    assert.deepEqual(await acknowledgedOutcome, {
      type: "session_retired",
      session_id: firstSessionId,
      outcome: "not_found",
    });
    await assertNoMessage(secondOwner);
    await assertNoMessage(secondViewerSocket);
  } finally {
    await Promise.all(sockets.map(terminateSocket));
    await server.app.close();
    server.close();
  }
});

test("server sleep/wake lifecycle resumes the existing approved session without creating a new one", async () => {
  const server = await buildApp(":memory:");
  const device = await createDevice(server);
  const ownerSession = await server.app.inject({
    method: "GET",
    url: "/auth/session",
    headers: { cookie: device.cookie },
  });
  const ownerUserId = ownerSession.json<{ user: { id: string } }>().user.id;
  const viewerAccount = await createViewer(server, `sleep-wake-${Date.now()}@example.com`);
  server.authorization.grant(ownerUserId, viewerAccount.userId);
  const sockets: WebSocket[] = [];

  try {
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    const address = server.app.server.address();
    assert.ok(address && typeof address !== "string");
    const url = `ws://127.0.0.1:${address.port}/ws`;
    const owner = new WebSocket(url, { origin: "http://localhost:5173" });
    const viewer = new WebSocket(url, {
      origin: "http://localhost:5173",
      headers: { cookie: viewerAccount.cookie },
    });
    sockets.push(owner, viewer);
    const ownerAuth = nextMessage(owner);
    const viewerAuth = nextMessage(viewer);
    await Promise.all([waitForOpen(owner), waitForOpen(viewer)]);
    owner.send(JSON.stringify({ type: "auth", token: device.refreshToken }));
    await Promise.all([ownerAuth, viewerAuth]);

    const ownerSharingAck = nextMessage(owner);
    const viewerSharing = nextMessage(viewer);
    owner.send(JSON.stringify({ type: "sharing_state", screen: true, camera: true }));
    await Promise.all([ownerSharingAck, viewerSharing]);
    const sessionMessages = nextMessages(viewer, 2);
    const joined = nextMessage(owner);
    viewer.send(JSON.stringify({ type: "create_session", device_id: device.deviceId }));
    const [, created] = await sessionMessages;
    assert.equal(created?.type, "session_created");
    const sessionId = created!.session_id as string;
    assert.equal((await joined).session_id, sessionId);

    const ownerSleepMarker = nextMessage(owner);
    const viewerSleepMarker = nextMessage(viewer);
    owner.send(JSON.stringify({
      type: "prepare_sleep",
      session_id: sessionId,
      request_id: "00000000-0000-4000-8000-000000000001",
    }));
    const [ownerMarked, viewerMarked] = await Promise.all([
      ownerSleepMarker,
      viewerSleepMarker,
    ]);
    assert.equal(ownerMarked?.type, "sleep_marked");
    assert.equal(viewerMarked?.type, "sleep_marked");
    assert.equal(ownerMarked?.session_id, sessionId);
    assert.equal(viewerMarked?.session_id, sessionId);

    const ownerClosed = waitForClose(owner);
    const viewerClosed = waitForClose(viewer);
    owner.close();
    viewer.close();
    await Promise.all([ownerClosed, viewerClosed]);

    const wakingOwner = new WebSocket(url, { origin: "http://localhost:5173" });
    const wakingViewer = new WebSocket(url, {
      origin: "http://localhost:5173",
      headers: { cookie: viewerAccount.cookie },
    });
    sockets.push(wakingOwner, wakingViewer);
    const wakingOwnerAuth = nextMessage(wakingOwner);
    const wakingViewerAuth = nextMessage(wakingViewer);
    await Promise.all([waitForOpen(wakingOwner), waitForOpen(wakingViewer)]);
    wakingOwner.send(JSON.stringify({ type: "auth", token: device.refreshToken }));
    await Promise.all([wakingOwnerAuth, wakingViewerAuth]);

    const ownerResumeMessages = nextMessages(wakingOwner, 2);
    const viewerResumeMessages = nextMessages(wakingViewer, 2);
    wakingOwner.send(JSON.stringify({
      type: "resume_session",
      session_id: sessionId,
      epoch: ownerMarked?.epoch,
      capability: ownerMarked?.capability,
      request_id: "00000000-0000-4000-8000-000000000002",
    }));
    wakingViewer.send(JSON.stringify({
      type: "resume_session",
      session_id: sessionId,
      epoch: viewerMarked?.epoch,
      capability: viewerMarked?.capability,
      request_id: "00000000-0000-4000-8000-000000000003",
    }));
    const [ownerPending, ownerResumed] = await ownerResumeMessages;
    const [viewerPending, viewerResumed] = await viewerResumeMessages;
    assert.equal(ownerPending?.type, "resume_pending");
    assert.equal(viewerPending?.type, "resume_pending");
    assert.deepEqual(ownerResumed, {
      type: "session_resumed",
      session_id: sessionId,
      epoch: ownerMarked?.epoch,
    });
    assert.deepEqual(viewerResumed, ownerResumed);
    await assertNoMessage(wakingOwner);
    await assertNoMessage(wakingViewer);

    const completedOwnerClosed = waitForClose(wakingOwner);
    wakingOwner.close();
    await completedOwnerClosed;
    const reattachedOwner = new WebSocket(url, { origin: "http://localhost:5173" });
    sockets.push(reattachedOwner);
    const reattachedMessages = nextMessages(reattachedOwner, 2);
    await waitForOpen(reattachedOwner);
    reattachedOwner.send(JSON.stringify({ type: "auth", token: device.refreshToken }));
    const [reattachedAuth, recovery] = await reattachedMessages;
    assert.equal(reattachedAuth?.type, "authenticated");
    assert.equal(recovery?.type, "session_recovery");
    assert.equal(recovery?.session_id, sessionId);

    const statusResponse = nextMessage(reattachedOwner);
    reattachedOwner.send(JSON.stringify({
      type: "resume_status",
      session_id: sessionId,
      epoch: ownerMarked?.epoch,
      request_id: "00000000-0000-4000-8000-000000000002",
    }));
    assert.deepEqual(await statusResponse, {
      type: "resume_status",
      session_id: sessionId,
      epoch: ownerMarked?.epoch,
      request_id: "00000000-0000-4000-8000-000000000002",
      status: "completed",
    });

    const sharing = await server.app.inject({
      method: "GET",
      url: "/presence",
      headers: { cookie: device.cookie },
    });
    assert.deepEqual(
      sharing.json<{ devices: Array<{ screen: boolean; camera: boolean }> }>()
        .devices.map(({ screen, camera }) => ({ screen, camera }))[0],
      { screen: true, camera: true },
    );
  } finally {
    await Promise.all(sockets.map(terminateSocket));
    await server.app.close();
    server.close();
  }
});

test("session creation rechecks authorization atomically after a concurrent revocation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "live-presence-session-revocation-race-"));
  const databasePath = join(directory, "presence.sqlite");
  const server = await buildApp(databasePath);
  const device = await createDevice(server);
  const ownerSession = await server.app.inject({
    method: "GET",
    url: "/auth/session",
    headers: { cookie: device.cookie },
  });
  const ownerUserId = ownerSession.json<{ user: { id: string } }>().user.id;
  const viewerAccount = await createViewer(server, `binding-race-${Date.now()}@example.com`);
  server.authorization.grant(ownerUserId, viewerAccount.userId);
  const sockets: WebSocket[] = [];

  try {
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    const address = server.app.server.address();
    assert.ok(address && typeof address !== "string");
    const url = `ws://127.0.0.1:${address.port}/ws`;
    const owner = new WebSocket(url, { origin: "http://localhost:5173" });
    const viewer = new WebSocket(url, {
      origin: "http://localhost:5173",
      headers: { cookie: viewerAccount.cookie },
    });
    sockets.push(owner, viewer);
    const ownerAuth = nextMessage(owner);
    const viewerAuth = nextMessage(viewer);
    await Promise.all([waitForOpen(owner), waitForOpen(viewer)]);
    owner.send(JSON.stringify({ type: "auth", token: device.refreshToken }));
    await Promise.all([ownerAuth, viewerAuth]);

    const ownerSharingAck = nextMessage(owner);
    const viewerSharing = nextMessage(viewer);
    owner.send(JSON.stringify({ type: "sharing_state", screen: true, camera: false }));
    await Promise.all([ownerSharingAck, viewerSharing]);

    const canAccess = server.authorization.canAccess.bind(server.authorization);
    let injectedRevocation = false;
    server.authorization.canAccess = (checkedOwnerId, checkedViewerId) => {
      const active = canAccess(checkedOwnerId, checkedViewerId);
      if (
        active &&
        !injectedRevocation &&
        checkedOwnerId === ownerUserId &&
        checkedViewerId === viewerAccount.userId
      ) {
        injectedRevocation = true;
        server.authorization.revoke(ownerUserId, viewerAccount.userId);
      }
      return active;
    };

    const rejected = nextMessage(viewer);
    viewer.send(JSON.stringify({
      type: "create_session",
      device_id: device.deviceId,
    }));
    assert.deepEqual(await rejected, {
      type: "error",
      code: "NOT_AUTHORIZED",
    });
    assert.equal(injectedRevocation, true);

    const database = new Database(databasePath);
    assert.equal(
      database.prepare(
        "SELECT COUNT(*) FROM presence_authorization_bindings WHERE owner_user_id = ? AND device_id = ? AND viewer_user_id = ?",
      ).pluck().get(ownerUserId, device.deviceId, viewerAccount.userId),
      0,
    );
    assert.equal(
      database.prepare(
        "SELECT COUNT(*) FROM presence_revocation_tombstones WHERE owner_user_id = ? AND device_id = ? AND viewer_user_id = ?",
      ).pluck().get(ownerUserId, device.deviceId, viewerAccount.userId),
      0,
      "revocation before binding must not produce a session tombstone",
    );
    database.close();
    await assertNoMessage(viewer);
  } finally {
    await Promise.all(sockets.map(terminateSocket));
    await server.app.close();
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("session creation fails safely under SQLite write contention and succeeds after release", async () => {
  const directory = mkdtempSync(join(tmpdir(), "live-presence-sqlite-contention-"));
  const databasePath = join(directory, "presence.sqlite");
  const server = await buildApp(databasePath);
  const device = await createDevice(server);
  const ownerSession = await server.app.inject({
    method: "GET",
    url: "/auth/session",
    headers: { cookie: device.cookie },
  });
  const ownerUserId = ownerSession.json<{ user: { id: string } }>().user.id;
  const viewerAccount = await createViewer(server, `sqlite-contention-${Date.now()}@example.com`);
  server.authorization.grant(ownerUserId, viewerAccount.userId);
  const sockets: WebSocket[] = [];
  const lockConnection = new Database(databasePath);
  let lockHeld = false;

  try {
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    const address = server.app.server.address();
    assert.ok(address && typeof address !== "string");
    const url = `ws://127.0.0.1:${address.port}/ws`;
    const owner = new WebSocket(url, { origin: "http://localhost:5173" });
    const viewer = new WebSocket(url, {
      origin: "http://localhost:5173",
      headers: { cookie: viewerAccount.cookie },
    });
    sockets.push(owner, viewer);
    const ownerAuth = nextMessage(owner);
    const viewerAuth = nextMessage(viewer);
    await Promise.all([waitForOpen(owner), waitForOpen(viewer)]);
    owner.send(JSON.stringify({ type: "auth", token: device.refreshToken }));
    await Promise.all([ownerAuth, viewerAuth]);

    const ownerSharingAck = nextMessage(owner);
    const viewerSharing = nextMessage(viewer);
    owner.send(JSON.stringify({ type: "sharing_state", screen: true, camera: true }));
    await Promise.all([ownerSharingAck, viewerSharing]);

    lockConnection.exec("BEGIN IMMEDIATE");
    lockHeld = true;
    const rejected = nextMessage(viewer, 10_000);
    viewer.send(JSON.stringify({
      type: "create_session",
      device_id: device.deviceId,
      request_id: "00000000-0000-4000-8000-000000000001",
    }));
    assert.deepEqual(await rejected, { type: "error", code: "SERVER_ERROR" });
    assert.equal(
      lockConnection.prepare("SELECT COUNT(*) FROM presence_authorization_bindings")
        .pluck().get(),
      0,
      "failed binding transaction must not insert an authorization binding",
    );

    lockConnection.exec("ROLLBACK");
    lockHeld = false;
    const createdMessages = nextMessages(viewer, 2);
    const ownerJoined = nextMessage(owner);
    viewer.send(JSON.stringify({
      type: "create_session",
      device_id: device.deviceId,
      request_id: "00000000-0000-4000-8000-000000000002",
    }));
    const responses = await createdMessages;
    assert.ok(responses.some((message) =>
      message.type === "session_created" &&
      message.request_id === "00000000-0000-4000-8000-000000000002"));
    assert.equal(responses.some((message) => message.type === "session_attached"), false);
    assert.equal((await ownerJoined).type, "viewer_joined");
    assert.equal(
      lockConnection.prepare("SELECT COUNT(*) FROM presence_authorization_bindings")
        .pluck().get(),
      1,
    );
  } finally {
    if (lockHeld) lockConnection.exec("ROLLBACK");
    lockConnection.close();
    await Promise.all(sockets.map(terminateSocket));
    await server.app.close();
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
