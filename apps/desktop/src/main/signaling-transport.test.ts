import assert from "node:assert/strict";
import { once } from "node:events";
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
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
    await waitForEvent(events, "open");
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
