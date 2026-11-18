import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import type { Duplex } from "node:stream";
import { test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { MainSignalingTransport } from "./signaling-transport.js";
import type { SocketEvent } from "../ipc-contract.js";

function waitForEvent(
  events: SocketEvent[],
  type: SocketEvent["type"],
  timeoutMs = 1_000,
): Promise<SocketEvent> {
  const existing = events.find((event) => event.type === type);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    let pollTimer: ReturnType<typeof setInterval>;
    const timeout = setTimeout(() => {
      clearInterval(pollTimer);
      reject(new Error(`Timed out waiting for signaling event "${type}" after ${timeoutMs}ms`));
    }, timeoutMs);
    const finish = (event: SocketEvent) => {
      clearTimeout(timeout);
      clearInterval(pollTimer);
      resolve(event);
    };
    pollTimer = setInterval(() => {
      const event = events.find((candidate) => candidate.type === type);
      if (!event) return;
      finish(event);
    }, 2);
  });
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("condition was not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function waitForDiagnostic(
  diagnostics: Array<Record<string, unknown>>,
  eventName: string,
): Promise<Record<string, unknown>> {
  await waitForCondition(() => diagnostics.some((entry) => entry.event === eventName));
  return diagnostics.find((entry) => entry.event === eventName)!;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function createDelayedUpgradeServer(
  authenticate: boolean,
  connectFirstUpgrade = false,
): Promise<{
  server: ReturnType<typeof createServer>;
  webSocketServer: WebSocketServer;
  url: string;
  getUpgradeCount: () => number;
  destroyUpgradeSockets: () => void;
}> {
  const server = createServer();
  const webSocketServer = new WebSocketServer({ noServer: true });
  const upgradeSockets = new Set<Duplex>();
  let upgradeCount = 0;
  let connectionCount = 0;
  server.on("upgrade", (request, socket, head) => {
    upgradeCount += 1;
    upgradeSockets.add(socket);
    socket.once("close", () => upgradeSockets.delete(socket));
    if (upgradeCount === 1 && !connectFirstUpgrade) return;
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request);
    });
  });
  if (authenticate) {
    webSocketServer.on("connection", (socket: WebSocket) => {
      connectionCount += 1;
      const isFirstConnection = connectionCount === 1;
      if (isFirstConnection && connectFirstUpgrade) {
        socket.close = () => socket;
      }
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (message.type === "auth" && !(isFirstConnection && connectFirstUpgrade)) {
          socket.send(JSON.stringify({
            type: "authenticated",
            role: "owner",
            device_id: "00000000-0000-0000-0000-000000000001",
          }));
        }
      });
    });
  }
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    server,
    webSocketServer,
    url: `http://127.0.0.1:${address.port}`,
    getUpgradeCount: () => upgradeCount,
    destroyUpgradeSockets: () => {
      for (const socket of upgradeSockets) socket.destroy();
    },
  };
}

test("owner transport shares one authenticated connection, heartbeats, and closes cleanly", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const messages: Array<Record<string, unknown>> = [];
  let connectionCount = 0;
  server.on("connection", (socket: WebSocket) => {
    connectionCount += 1;
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      messages.push(message);
      if (message.type === "auth") {
        socket.send(JSON.stringify({
          type: "authenticated",
          role: "owner",
          device_id: "00000000-0000-0000-0000-000000000001",
        }));
      } else if (message.type === "heartbeat") {
        socket.send(JSON.stringify({ type: "heartbeat_ack" }));
      }
    });
  });

  const events: SocketEvent[] = [];
  let releaseCredential: ((value: string | null) => void) | undefined;
  let credentialLoads = 0;
  const transport = new MainSignalingTransport(
    `http://127.0.0.1:${address.port}`,
    "http://localhost:5173",
    {
      load: () => {
        credentialLoads += 1;
        return new Promise((resolve) => { releaseCredential = resolve; });
      },
    },
    (event) => events.push(event),
    50,
  );

  try {
    const first = transport.connect();
    const concurrent = transport.connect();
    assert.equal(credentialLoads, 1);
    releaseCredential!("test-device-credential");
    await Promise.all([first, concurrent]);
    const opened = await waitForEvent(events, "open");
    assert.equal(opened.type, "open");
    if (opened.type === "open") assert.equal(opened.connectionGeneration, 1);
    const eventCountBeforeReuse = events.length;
    assert.equal(await transport.connect(), 1);
    const reusedOpen = events.slice(eventCountBeforeReuse).find((event) => event.type === "open");
    assert.ok(reusedOpen);
    if (reusedOpen?.type === "open") {
      assert.equal(reusedOpen.authenticatedTransportReuse, true);
      assert.equal(reusedOpen.deviceId, "00000000-0000-0000-0000-000000000001");
    }
    assert.equal(connectionCount, 1);

    transport.send(JSON.stringify({ type: "sharing_state", screen: false, camera: false }));
    transport.send(JSON.stringify({ type: "sharing_state", screen: true, camera: false }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(messages.some((message) => message.type === "sharing_state"));
    assert.ok(messages.some((message) =>
      message.type === "sharing_state" && message.screen === true && message.camera === false));
    await waitForCondition(() => messages.some((message) => message.type === "heartbeat"));
    assert.ok(messages.some((message) => message.type === "heartbeat"));

    transport.close();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const heartbeatCountAfterClose = messages.filter((message) => message.type === "heartbeat").length;
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(
      messages.filter((message) => message.type === "heartbeat").length,
      heartbeatCountAfterClose,
    );
    assert.ok(events.some((event) => event.type === "close"));
  } finally {
    transport.close();
    server.clients.forEach((socket) => socket.terminate());
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("repeated authentication and socket replacement keep one heartbeat per active socket", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const sockets: WebSocket[] = [];
  const messages: Array<{ socket: WebSocket; type: string }> = [];
  server.on("connection", (socket: WebSocket) => {
    sockets.push(socket);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      messages.push({ socket, type: String(message.type) });
      if (message.type === "auth") {
        const authenticated = JSON.stringify({
          type: "authenticated",
          role: "owner",
          device_id: "00000000-0000-0000-0000-000000000001",
        });
        socket.send(authenticated);
        socket.send(authenticated);
      } else if (message.type === "heartbeat") {
        socket.send(JSON.stringify({ type: "heartbeat_ack" }));
      }
    });
  });

  const events: SocketEvent[] = [];
  const diagnosticLogs: string[] = [];
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const originalDebug = console.debug;
  const captureLog = (...values: unknown[]): void => {
    for (const value of values) if (typeof value === "string") diagnosticLogs.push(value);
  };
  console.info = captureLog;
  console.warn = captureLog;
  console.debug = captureLog;
  const activeTimers = new Map<number, () => void>();
  let nextTimerId = 0;
  let scheduledIntervals = 0;
  const transport = new MainSignalingTransport(
    `http://127.0.0.1:${address.port}`,
    "http://localhost:5173",
    { load: async () => "test-device-credential" },
    (event) => events.push(event),
    15_000,
    (callback, delayMs) => {
      assert.equal(delayMs, 15_000);
      const id = ++nextTimerId;
      scheduledIntervals += 1;
      activeTimers.set(id, callback);
      return () => { activeTimers.delete(id); };
    },
  );
  const tickHeartbeat = (): void => {
    for (const callback of activeTimers.values()) callback();
  };

  try {
    const firstConnection = once(server, "connection");
    await transport.connect();
    const [firstSocket] = await firstConnection;
    await waitForCondition(() => events.filter((event) => event.type === "open").length === 2);
    assert.ok(events.some((event) =>
      event.type === "authentication-started" && event.connectionGeneration === 1));
    assert.equal(scheduledIntervals, 1);
    assert.equal(activeTimers.size, 1);

    tickHeartbeat();
    await waitForCondition(() => messages.filter(
      (message) => message.socket === firstSocket && message.type === "heartbeat",
    ).length === 1);
    assert.equal(messages.filter(
      (message) => message.socket === firstSocket && message.type === "heartbeat",
    ).length, 1);

    firstSocket.close();
    await waitForCondition(() =>
      events.some((event) => event.type === "close") && activeTimers.size === 0);
    const firstHeartbeatCount = messages.filter(
      (message) => message.socket === firstSocket && message.type === "heartbeat",
    ).length;
    tickHeartbeat();
    assert.equal(messages.filter(
      (message) => message.socket === firstSocket && message.type === "heartbeat",
    ).length, firstHeartbeatCount);

    const replacementConnection = once(server, "connection");
    await transport.connect();
    const [replacementSocket] = await replacementConnection;
    await waitForCondition(() => events.filter((event) => event.type === "open").length === 4);
    assert.ok(diagnosticLogs.some((line) => line.includes('"event":"reconnect_attempt_started"')));
    assert.ok(diagnosticLogs.some((line) => line.includes('"event":"reconnect_attempt_succeeded"')));
    assert.equal(scheduledIntervals, 2);
    assert.equal(activeTimers.size, 1);

    tickHeartbeat();
    await waitForCondition(() => messages.filter(
      (message) => message.socket === replacementSocket && message.type === "heartbeat",
    ).length === 1);
    assert.equal(messages.filter(
      (message) => message.socket === replacementSocket && message.type === "heartbeat",
    ).length, 1);

    replacementSocket.send(JSON.stringify({ type: "authenticated", role: "viewer" }));
    await waitForCondition(() => activeTimers.size === 0);
    assert.equal(activeTimers.size, 0);
  } finally {
    console.info = originalInfo;
    console.warn = originalWarn;
    console.debug = originalDebug;
    transport.close();
    server.clients.forEach((socket) => socket.terminate());
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("owner transport closes a half-open signaling socket after missing heartbeat acknowledgements", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const messages: string[] = [];
  server.on("connection", (socket: WebSocket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      messages.push(String(message.type));
      if (message.type === "auth") {
        socket.send(JSON.stringify({
          type: "authenticated",
          role: "owner",
          device_id: "00000000-0000-0000-0000-000000000001",
        }));
      }
    });
  });

  const activeTimers = new Map<number, () => void>();
  const events: SocketEvent[] = [];
  let nextTimerId = 0;
  let now = 0;
  const transport = new MainSignalingTransport(
    `http://127.0.0.1:${address.port}`,
    "http://localhost:5173",
    { load: async () => "test-device-credential" },
    (event) => events.push(event),
    15_000,
    (callback, delayMs) => {
      assert.equal(delayMs, 15_000);
      const id = ++nextTimerId;
      activeTimers.set(id, callback);
      return () => { activeTimers.delete(id); };
    },
    () => now,
  );

  try {
    const connected = once(server, "connection");
    await transport.connect();
    const [socket] = await connected;
    await waitForEvent(events, "open");
    const closed = once(socket, "close");
    now = 15_000;
    for (const callback of activeTimers.values()) callback();
    await waitForCondition(() => messages.includes("heartbeat"));
    now = 30_000;
    for (const callback of activeTimers.values()) callback();
    await closed;
    await waitForCondition(() => activeTimers.size === 0);

    assert.equal(activeTimers.size, 0);
    assert.ok(events.some((event) => event.type === "close"));
  } finally {
    transport.close();
    server.clients.forEach((socket) => socket.terminate());
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("owner transport receives heartbeat acknowledgements and refreshes the watchdog deadline", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let heartbeatCount = 0;
  server.on("connection", (socket: WebSocket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.type === "auth") {
        socket.send(JSON.stringify({
          type: "authenticated",
          role: "owner",
          device_id: "00000000-0000-0000-0000-000000000001",
        }));
      } else if (message.type === "heartbeat") {
        heartbeatCount += 1;
        if (heartbeatCount === 1) socket.send(JSON.stringify({ type: "heartbeat_ack" }));
      }
    });
  });

  const events: SocketEvent[] = [];
  const activeTimers = new Map<number, () => void>();
  let nextTimerId = 0;
  let now = 0;
  const transport = new MainSignalingTransport(
    `http://127.0.0.1:${address.port}`,
    "http://localhost:5173",
    { load: async () => "test-device-credential" },
    (event) => events.push(event),
    15_000,
    (callback) => {
      const id = ++nextTimerId;
      activeTimers.set(id, callback);
      return () => { activeTimers.delete(id); };
    },
    () => now,
  );
  const tick = (): void => {
    for (const callback of activeTimers.values()) callback();
  };

  try {
    const connected = once(server, "connection");
    await transport.connect();
    const [socket] = await connected;
    await waitForCondition(() => activeTimers.size === 1);
    const closed = once(socket, "close");

    now = 15_000;
    tick();
    await waitForCondition(() => heartbeatCount === 1);
    await waitForCondition(() => events.some((event) =>
      event.type === "message" && event.data.includes('"type":"heartbeat_ack"')));

    now = 30_000;
    tick();
    await waitForCondition(() => heartbeatCount === 2);
    assert.equal(socket.readyState, WebSocket.OPEN);

    now = 45_000;
    tick();
    await closed;
    await waitForCondition(() => activeTimers.size === 0);
    assert.equal(activeTimers.size, 0);
  } finally {
    transport.close();
    server.clients.forEach((socket) => socket.terminate());
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("close invalidates a delayed credential load without blocking a new deduplicated connect", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let connectionCount = 0;
  server.on("connection", () => { connectionCount += 1; });

  const credentialLoads: Array<ReturnType<typeof deferred<string | null>>> = [];
  const transport = new MainSignalingTransport(
    `http://127.0.0.1:${address.port}`,
    "http://localhost:5173",
    {
      load: () => {
        const load = deferred<string | null>();
        credentialLoads.push(load);
        return load.promise;
      },
    },
    () => undefined,
  );

  try {
    const staleAttempt = transport.connect();
    const duplicateStaleAttempt = transport.connect();
    assert.equal(credentialLoads.length, 1);
    transport.close();

    const newConnection = once(server, "connection");
    const currentAttempt = transport.connect();
    const duplicateCurrentAttempt = transport.connect();
    assert.equal(credentialLoads.length, 2);

    credentialLoads[1]!.resolve("current-device-credential");
    await Promise.all([currentAttempt, duplicateCurrentAttempt]);
    await newConnection;
    assert.equal(connectionCount, 1);

    credentialLoads[0]!.resolve("stale-device-credential");
    await Promise.all([staleAttempt, duplicateStaleAttempt]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(connectionCount, 1);
  } finally {
    transport.close();
    server.clients.forEach((socket) => socket.terminate());
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("owner transport does not open a socket without a saved credential", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let connectionCount = 0;
  server.on("connection", () => { connectionCount += 1; });

  const transport = new MainSignalingTransport(
    `http://127.0.0.1:${address.port}`,
    "http://localhost:5173",
    { load: async () => null },
    () => undefined,
  );
  try {
    await assert.rejects(transport.connect(), /device is not enrolled/);
    assert.equal(connectionCount, 0);
  } finally {
    transport.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("owner authentication timeout closes retryably and permits a fresh connection", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let connectionCount = 0;
  server.on("connection", (socket: WebSocket) => {
    connectionCount += 1;
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.type === "auth" && connectionCount > 1) {
        socket.send(JSON.stringify({
          type: "authenticated",
          role: "owner",
          device_id: "00000000-0000-0000-0000-000000000001",
        }));
      }
    });
  });
  const events: SocketEvent[] = [];
  const transport = new MainSignalingTransport(
    `http://127.0.0.1:${address.port}`,
    "http://localhost:5173",
    { load: async () => "test-device-credential" },
    (event) => events.push(event),
    15_000,
    undefined,
    undefined,
    20,
  );

  try {
    await transport.connect();
    const closed = await waitForEvent(events, "close", 1_000);
    assert.equal(closed.type, "close");
    if (closed.type === "close") {
      assert.equal(closed.code, 1013);
      assert.equal(closed.connectionGeneration, 1);
    }

    const replacementConnection = once(server, "connection");
    assert.equal(await transport.connect(), 2);
    await replacementConnection;
    await waitForCondition(() =>
      events.some((event) => event.type === "open" && event.connectionGeneration === 2));
    assert.equal(transport.deviceId, "00000000-0000-0000-0000-000000000001");
  } finally {
    transport.close();
    server.clients.forEach((socket) => socket.terminate());
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("a WebSocket stuck in CONNECTING is retired at the connection setup deadline", async () => {
  const { server, webSocketServer, url, destroyUpgradeSockets } =
    await createDelayedUpgradeServer(false);
  const events: SocketEvent[] = [];
  const transport = new MainSignalingTransport(
    url,
    "http://localhost:5173",
    { load: async () => "test-device-credential" },
    (event) => events.push(event),
    15_000,
    undefined,
    undefined,
    100,
  );

  try {
    assert.equal(await transport.connect(), 1);
    const closed = await waitForEvent(events, "close", 1_000);
    assert.equal(closed.type, "close");
    if (closed.type === "close") {
      assert.equal(closed.code, 1013);
      assert.equal(closed.connectionGeneration, 1);
    }
    assert.equal(events.some((event) => event.type === "open"), false);
  } finally {
    transport.close();
    webSocketServer.clients.forEach((socket) => socket.terminate());
    destroyUpgradeSockets();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("a fresh connection succeeds after a CONNECTING socket times out", async () => {
  const { server, webSocketServer, url, getUpgradeCount, destroyUpgradeSockets } =
    await createDelayedUpgradeServer(true);
  const events: SocketEvent[] = [];
  const transport = new MainSignalingTransport(
    url,
    "http://localhost:5173",
    { load: async () => "test-device-credential" },
    (event) => events.push(event),
    15_000,
    undefined,
    undefined,
    100,
  );

  try {
    assert.equal(await transport.connect(), 1);
    const firstClose = await waitForEvent(events, "close", 1_000);
    assert.equal(firstClose.type, "close");
    if (firstClose.type === "close") assert.equal(firstClose.code, 1013);

    assert.equal(await transport.connect(), 2);
    await waitForCondition(() =>
      events.some((event) => event.type === "open" && event.connectionGeneration === 2));
    assert.equal(getUpgradeCount(), 2);
    assert.equal(transport.deviceId, "00000000-0000-0000-0000-000000000001");
  } finally {
    transport.close();
    webSocketServer.clients.forEach((socket) => socket.terminate());
    destroyUpgradeSockets();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
  }
});

test("late events from a timed-out socket cannot affect its authenticated replacement", async () => {
  const { server, webSocketServer, url, getUpgradeCount, destroyUpgradeSockets } =
    await createDelayedUpgradeServer(true, true);
  const events: SocketEvent[] = [];
  const diagnostics: Array<Record<string, unknown>> = [];
  const transport = new MainSignalingTransport(
    url,
    "http://localhost:5173",
    { load: async () => "test-device-credential" },
    (event) => events.push(event),
    15_000,
    undefined,
    undefined,
    100,
    20,
    undefined,
    (_level, entry) => diagnostics.push(entry),
  );
  let retiredSocket: WebSocket | undefined;

  try {
    assert.equal(await transport.connect(), 1);
    await waitForCondition(() => getUpgradeCount() === 1);
    retiredSocket = (transport as unknown as { socket?: WebSocket }).socket;
    assert.ok(retiredSocket);

    const retiredClose = await waitForEvent(events, "close", 1_000);
    assert.equal(retiredClose.type, "close");
    if (retiredClose.type === "close") {
      assert.equal(retiredClose.code, 1013);
      assert.equal(retiredClose.connectionGeneration, 1);
    }
    assert.equal(await transport.connect(), 2);
    await waitForCondition(() =>
      events.some((event) => event.type === "open" && event.connectionGeneration === 2));
    await waitForDiagnostic(diagnostics, "authentication_accepted");
    assert.equal(transport.deviceId, "00000000-0000-0000-0000-000000000001");

    await waitForCondition(() =>
      retiredSocket!.listenerCount("error") === 0 &&
      retiredSocket!.listenerCount("close") === 0);
    assert.equal(retiredSocket.readyState, WebSocket.CLOSED);
    assert.equal(retiredSocket.listenerCount("open"), 0);
    assert.equal(retiredSocket.listenerCount("message"), 0);

    const eventCountBeforeLateEvents = events.length;
    const diagnosticCountBeforeLateEvents = diagnostics.length;
    retiredSocket.emit("open");
    retiredSocket.emit("message", Buffer.from(JSON.stringify({
      type: "authenticated",
      role: "owner",
      device_id: "00000000-0000-0000-0000-000000000002",
    })), false);
    retiredSocket.emit("close", 1013, Buffer.from("late close"));

    assert.equal(transport.deviceId, "00000000-0000-0000-0000-000000000001");
    assert.equal(events.length, eventCountBeforeLateEvents);
    assert.equal(diagnostics.length, diagnosticCountBeforeLateEvents);
    assert.equal(
      diagnostics.some((entry) =>
        entry.event === "connection_attempt_ended" &&
        entry.attemptId === 1 &&
        entry.outcome === "setup_timeout"),
      true,
    );
    assert.equal(
      events.filter((event) => event.type === "open" && event.connectionGeneration === 2).length,
      1,
    );
    assert.equal(
      events.some((event) => event.type === "open" && event.connectionGeneration === 1),
      false,
    );
    assert.equal(
      events.some((event) =>
        event.type === "message" && event.connectionGeneration === 1),
      false,
    );
    assert.equal(
      events.some((event) => event.type === "close" && event.connectionGeneration === 2),
      false,
    );
    assert.equal(
      (transport as unknown as { socket?: WebSocket }).socket?.readyState,
      WebSocket.OPEN,
    );
  } finally {
    transport.close();
    webSocketServer.clients.forEach((socket) => socket.terminate());
    retiredSocket?.terminate();
    destroyUpgradeSockets();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
  }
});

test("WebSocket construction failures end the attempt with safe diagnostics", async () => {
  const diagnostics: Array<Record<string, unknown>> = [];
  const failure = Object.assign(
    new Error("connect ECONNREFUSED 192.0.2.10:3000 Bearer abcdefghijklmnopqrstuvwxyz"),
    { code: "ECONNREFUSED" },
  );
  const transport = new MainSignalingTransport(
    "http://localhost:3000",
    "http://localhost:5173",
    { load: async () => "sensitive-device-credential" },
    () => undefined,
    15_000,
    undefined,
    undefined,
    100,
    100,
    () => { throw failure; },
    (_level, entry) => diagnostics.push(entry),
  );

  await assert.rejects(transport.connect(), /ECONNREFUSED/);
  assert.equal(transport.deviceId, undefined);
  assert.deepEqual(
    diagnostics.filter((entry) => [
      "connection_attempt_started",
      "credential_loading_started",
      "credential_loading_completed",
      "websocket_construction_started",
      "websocket_construction_failed",
      "connection_attempt_ended",
    ].includes(String(entry.event))).map((entry) => entry.event),
    [
      "connection_attempt_started",
      "credential_loading_started",
      "credential_loading_completed",
      "websocket_construction_started",
      "websocket_construction_failed",
      "connection_attempt_ended",
    ],
  );
  const logged = JSON.stringify(diagnostics);
  assert.equal(logged.includes("sensitive-device-credential"), false);
  assert.equal(logged.includes("192.0.2.10"), false);
  assert.equal(logged.includes("abcdefghijklmnopqrstuvwxyz"), false);
  assert.equal(
    diagnostics.find((entry) => entry.event === "websocket_construction_failed")?.errorCode,
    "ECONNREFUSED",
  );
  assert.equal(
    diagnostics.find((entry) => entry.event === "websocket_construction_failed")?.errorMessage,
    "connection refused",
  );
  transport.close();
});

test("a WebSocket error before open is retained in diagnostics and ends the attempt", async () => {
  const server = createServer();
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const diagnostics: Array<Record<string, unknown>> = [];
  const events: SocketEvent[] = [];
  const transport = new MainSignalingTransport(
    `http://127.0.0.1:${address.port}`,
    "http://localhost:5173",
    { load: async () => "test-device-credential" },
    (event) => events.push(event),
    15_000,
    undefined,
    undefined,
    1_000,
    100,
    undefined,
    (_level, entry) => diagnostics.push(entry),
  );

  try {
    assert.equal(await transport.connect(), 1);
    const error = await waitForDiagnostic(diagnostics, "websocket_error");
    const closed = await waitForDiagnostic(diagnostics, "websocket_close");
    assert.equal(error.stage, "websocket_open");
    assert.equal(closed.expected, false);
    assert.equal(transport.deviceId, undefined);
    assert.equal(events.some((event) => event.type === "close" && event.connectionGeneration === 1), true);
    assert.equal(
      diagnostics.some((entry) =>
        entry.event === "connection_attempt_ended" &&
        entry.attemptId === 1 &&
        entry.outcome === "websocket_closed"),
      true,
    );
  } finally {
    transport.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
});

test("an unexpected HTTP response before open is diagnosed without response contents", async () => {
  const server = createServer();
  server.on("upgrade", (_request, socket) => {
    socket.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nX-Diagnostic-Test: private-value\r\n\r\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const diagnostics: Array<Record<string, unknown>> = [];
  const events: SocketEvent[] = [];
  const transport = new MainSignalingTransport(
    `http://127.0.0.1:${address.port}`,
    "http://localhost:5173",
    { load: async () => "test-device-credential" },
    (event) => events.push(event),
    15_000,
    undefined,
    undefined,
    1_000,
    100,
    undefined,
    (_level, entry) => diagnostics.push(entry),
  );

  try {
    assert.equal(await transport.connect(), 1);
    const response = await waitForDiagnostic(diagnostics, "websocket_unexpected_response");
    await waitForDiagnostic(diagnostics, "websocket_close");
    assert.equal(response.statusCode, 503);
    assert.equal(response.statusClass, "5xx");
    assert.equal(response.responseMetadata, "headers_and_body_omitted");
    assert.equal(transport.deviceId, undefined);
    assert.equal(events.some((event) => event.type === "open"), false);
    assert.equal(JSON.stringify(diagnostics).includes("private-value"), false);
    assert.equal(
      diagnostics.some((entry) =>
        entry.event === "connection_attempt_ended" &&
        entry.attemptId === 1 &&
        entry.outcome === "websocket_closed"),
      true,
    );
  } finally {
    transport.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
});

test("setup timeout preserves an earlier WebSocket error diagnostic", async () => {
  const { server, webSocketServer, url, destroyUpgradeSockets } =
    await createDelayedUpgradeServer(false);
  const diagnostics: Array<Record<string, unknown>> = [];
  const events: SocketEvent[] = [];
  const transport = new MainSignalingTransport(
    url,
    "http://localhost:5173",
    { load: async () => "test-device-credential" },
    (event) => events.push(event),
    15_000,
    undefined,
    undefined,
    100,
    100,
    undefined,
    (_level, entry) => diagnostics.push(entry),
  );
  let socket: WebSocket | undefined;

  try {
    assert.equal(await transport.connect(), 1);
    await waitForCondition(() => server.listening);
    socket = (transport as unknown as { socket?: WebSocket }).socket;
    assert.ok(socket);
    socket.emit("error", Object.assign(new Error("connect ECONNRESET 198.51.100.4:443"), {
      code: "ECONNRESET",
    }));

    const error = await waitForDiagnostic(diagnostics, "websocket_error");
    const timeout = await waitForDiagnostic(diagnostics, "connection_setup_timeout");
    assert.equal(error.errorCode, "ECONNRESET");
    assert.equal(JSON.stringify(error).includes("198.51.100.4"), false);
    assert.equal(timeout.stage, "websocket_open");
    assert.equal(timeout.closeCode, 1013);
    assert.equal(transport.deviceId, undefined);
    assert.equal(events.some((event) =>
      event.type === "close" && event.code === 1013 && event.connectionGeneration === 1), true);
    await waitForCondition(() => socket!.readyState === WebSocket.CLOSED);
    assert.equal(
      diagnostics.some((entry) =>
        entry.event === "connection_attempt_ended" &&
        entry.attemptId === 1 &&
        entry.outcome === "setup_timeout"),
      true,
    );
  } finally {
    transport.close();
    webSocketServer.clients.forEach((client) => client.terminate());
    destroyUpgradeSockets();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
  }
});

test("authentication send failure retires the socket and permits a clean replacement", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  server.on("connection", (socket: WebSocket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.type === "auth") {
        socket.send(JSON.stringify({
          type: "authenticated",
          role: "owner",
          device_id: "00000000-0000-0000-0000-000000000001",
        }));
      }
    });
  });

  const events: SocketEvent[] = [];
  const diagnostics: Array<Record<string, unknown>> = [];
  let createdSockets = 0;
  let failedSocket: WebSocket | undefined;
  const transport = new MainSignalingTransport(
    `http://127.0.0.1:${address.port}`,
    "http://localhost:5173",
    { load: async () => "test-device-credential" },
    (event) => events.push(event),
    15_000,
    undefined,
    undefined,
    1_000,
    100,
    (url, options) => {
      const socket = new WebSocket(url, options);
      if (++createdSockets === 1) {
        failedSocket = socket;
        const originalSend = socket.send.bind(socket);
        Object.defineProperty(socket, "send", {
          value: (...args: Parameters<WebSocket["send"]>) => {
            const data = args[0];
            if (typeof data === "string" && JSON.parse(data).type === "auth") {
              throw Object.assign(new Error("authentication send failed"), { code: "EPIPE" });
            }
            return originalSend(...args);
          },
        });
      }
      return socket;
    },
    (_level, entry) => diagnostics.push(entry),
  );

  try {
    assert.equal(await transport.connect(), 1);
    await waitForEvent(events, "close", 1_000);
    assert.equal(failedSocket?.readyState, WebSocket.CLOSED);
    assert.equal(transport.deviceId, undefined);
    assert.equal(
      diagnostics.some((entry) =>
        entry.event === "authentication_message_send_failed" &&
        entry.attemptId === 1 &&
        entry.errorCode === "EPIPE"),
      true,
    );
    assert.equal(
      diagnostics.some((entry) =>
        entry.event === "connection_attempt_ended" &&
        entry.attemptId === 1 &&
        entry.outcome === "websocket_closed"),
      true,
    );
    assert.equal(JSON.stringify(diagnostics).includes("test-device-credential"), false);

    assert.equal(await transport.connect(), 2);
    await waitForCondition(() =>
      events.some((event) => event.type === "open" && event.connectionGeneration === 2));
    assert.equal(transport.deviceId, "00000000-0000-0000-0000-000000000001");

    const eventCount = events.length;
    const diagnosticCount = diagnostics.length;
    failedSocket!.emit("open");
    failedSocket!.emit("message", Buffer.from(JSON.stringify({
      type: "authenticated",
      role: "owner",
      device_id: "00000000-0000-0000-0000-000000000002",
    })), false);
    failedSocket!.emit("close", 1008, Buffer.from("stale close"));

    assert.equal(transport.deviceId, "00000000-0000-0000-0000-000000000001");
    assert.equal(events.length, eventCount);
    assert.equal(diagnostics.length, diagnosticCount);
    assert.equal(
      (transport as unknown as { socket?: WebSocket }).socket?.readyState,
      WebSocket.OPEN,
    );
  } finally {
    transport.close();
    failedSocket?.terminate();
    server.clients.forEach((socket) => socket.terminate());
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("a throwing diagnostic logger cannot interrupt authentication, close, or retry", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let sharingStateReceived = false;
  server.on("connection", (socket: WebSocket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.type === "auth") {
        socket.send(JSON.stringify({
          type: "authenticated",
          role: "owner",
          device_id: "00000000-0000-0000-0000-000000000001",
        }));
      } else if (message.type === "sharing_state") {
        sharingStateReceived = true;
      }
    });
  });

  const events: SocketEvent[] = [];
  const transport = new MainSignalingTransport(
    `http://127.0.0.1:${address.port}`,
    "http://localhost:5173",
    { load: async () => "test-device-credential" },
    (event) => events.push(event),
    15_000,
    undefined,
    undefined,
    1_000,
    100,
    undefined,
    () => { throw new Error("diagnostic sink failed"); },
  );

  try {
    assert.equal(await transport.connect(), 1);
    await waitForCondition(() =>
      events.some((event) => event.type === "open" && event.connectionGeneration === 1));
    assert.equal(transport.deviceId, "00000000-0000-0000-0000-000000000001");
    transport.send(JSON.stringify({ type: "sharing_state", screen: true, camera: false }), 1);
    await waitForCondition(() => sharingStateReceived);

    assert.equal(transport.close(1), true);
    assert.equal(await transport.connect(), 2);
    await waitForCondition(() =>
      events.some((event) => event.type === "open" && event.connectionGeneration === 2));
    assert.equal(transport.deviceId, "00000000-0000-0000-0000-000000000001");
  } finally {
    transport.close();
    server.clients.forEach((socket) => socket.terminate());
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("stale signaling generations cannot send or close the replacement connection", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  server.on("connection", (socket: WebSocket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.type === "auth") {
        socket.send(JSON.stringify({
          type: "authenticated",
          role: "owner",
          device_id: "00000000-0000-0000-0000-000000000001",
        }));
      }
    });
  });
  const events: SocketEvent[] = [];
  const diagnostics: Array<Record<string, unknown>> = [];
  const transport = new MainSignalingTransport(
    `http://127.0.0.1:${address.port}`,
    "http://localhost:5173",
    { load: async () => "test-device-credential" },
    (event) => events.push(event),
  );
  transport.setDiagnosticLogger((_level, entry) => diagnostics.push(entry));

  try {
    assert.equal(await transport.connect(), 1);
    await waitForEvent(events, "open");
    assert.equal(transport.close(1), true);
    assert.equal(await transport.connect(), 2);
    await waitForCondition(() =>
      events.some((event) => event.type === "open" && event.connectionGeneration === 2));
    transport.send(JSON.stringify({ type: "sharing_state", screen: true, camera: false }), 2);
    const sent = diagnostics.find((entry) => entry.event === "sharing_state_transport_sent");
    assert.equal(sent?.publicationOutcome, "sent");
    assert.equal(sent?.webSocketReadyState, "open");
    assert.equal(sent?.authenticated, true);
    assert.equal(sent?.activeConnectionGeneration, 2);
    assert.equal(sent?.requestedConnectionGeneration, 2);

    assert.throws(() =>
      transport.send(JSON.stringify({ type: "sharing_state", screen: false, camera: false }), 1),
    /generation is stale/);
    const rejected = diagnostics.filter((entry) => entry.event === "signaling_send_rejected").at(-1);
    assert.equal(rejected?.publicationOutcome, "send_rejected");
    assert.equal(rejected?.transportReason, "stale_generation");
    assert.equal(rejected?.webSocketReadyState, "open");
    assert.equal(rejected?.authenticated, true);
    assert.equal(rejected?.activeConnectionGeneration, 2);
    assert.equal(rejected?.requestedConnectionGeneration, 1);
    assert.equal(transport.close(1), false);
    assert.equal(transport.deviceId, "00000000-0000-0000-0000-000000000001");
    transport.close(2);
  } finally {
    transport.close();
    server.clients.forEach((socket) => socket.terminate());
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
