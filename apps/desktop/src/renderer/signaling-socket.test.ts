import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { DesktopWebRtcClient } from "../../../../shared/src/client.js";
import type { LivePresenceBridge, SocketEvent } from "../ipc-contract.js";
import { SIGNALLING_CONNECT_ERROR_PREFIX } from "../main/signaling-connect-handler.js";
import { createSignalingSocket } from "./signaling-socket.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

test("a successful connect response associates the getter-only generation without rejection", async () => {
  const pending = deferred<number>();
  const diagnostics: Array<Record<string, unknown>> = [];
  let receiveEvent: ((event: SocketEvent) => void) | undefined;
  const bridge: Pick<
    LivePresenceBridge,
    "connectSignaling" | "sendSignaling" | "closeSignaling" | "onSocketEvent"
  > = {
    connectSignaling: () => pending.promise,
    sendSignaling: async () => {},
    closeSignaling: () => {},
    onSocketEvent: (callback) => {
      receiveEvent = callback;
      return () => { receiveEvent = undefined; };
    },
  };
  const socket = createSignalingSocket(bridge, (_level, entry) => diagnostics.push(entry));
  const descriptor = Object.getOwnPropertyDescriptor(socket, "connectionGeneration");
  assert.equal(typeof descriptor?.get, "function");
  assert.equal(descriptor?.set, undefined);
  const adapterSource = await readFile(resolve(__dirname, "signaling-socket.ts"), "utf8");
  assert.doesNotMatch(adapterSource, /socket\.connectionGeneration\s*=/);

  socket.connect?.();
  pending.resolve(46);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(socket.connectionGeneration, 46);
  assert.equal(socket.readyState, 0);
  assert.equal(
    diagnostics.some((entry) => entry.event === "renderer_connection_generation_associated"),
    true,
  );
  assert.equal(
    diagnostics.some((entry) => entry.event === "renderer_connection_attempt_failed"),
    false,
  );
  receiveEvent?.({ type: "open", connectionGeneration: 46 });
  assert.equal(socket.readyState, 1);
  socket.close();
});

test("an old close before authentication-started cannot affect the new renderer socket", async () => {
  let resolveGeneration!: (generation: number) => void;
  let receiveEvent: ((event: SocketEvent) => void) | undefined;
  let unsubscribeCount = 0;
  let closeCount = 0;
  const bridge: Pick<
    LivePresenceBridge,
    "connectSignaling" | "sendSignaling" | "closeSignaling" | "onSocketEvent"
  > = {
    connectSignaling: () => new Promise((resolve) => { resolveGeneration = resolve; }),
    sendSignaling: async () => {},
    closeSignaling: () => { closeCount += 1; },
    onSocketEvent: (callback) => {
      receiveEvent = callback;
      return () => { unsubscribeCount += 1; };
    },
  };
  const socket = createSignalingSocket(bridge);
  let opened = 0;
  let closed = 0;
  let errored = 0;
  socket.onopen = () => { opened += 1; };
  socket.onclose = () => { closed += 1; };
  socket.onerror = () => { errored += 1; };

  socket.connect?.();
  receiveEvent?.({ type: "close", code: 1006, connectionGeneration: 4 });
  receiveEvent?.({
    type: "error",
    message: "old socket error",
    connectionGeneration: 4,
  });
  resolveGeneration(5);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(socket.connectionGeneration, 5);
  assert.equal(socket.readyState, 0);
  assert.equal(closed, 0);
  assert.equal(errored, 0);
  assert.equal(unsubscribeCount, 0);
  assert.equal(closeCount, 0);

  receiveEvent?.({ type: "authentication-started", connectionGeneration: 5 });
  receiveEvent?.({ type: "close", code: 1006, connectionGeneration: 4 });
  assert.equal(socket.readyState, 0);
  assert.equal(closed, 0);
  assert.equal(errored, 0);
  assert.equal(unsubscribeCount, 0);

  receiveEvent?.({ type: "open", connectionGeneration: 5 });
  assert.equal(socket.readyState, 1);
  assert.equal(socket.authenticatedOnOpen, false);
  assert.equal(opened, 1);
  receiveEvent?.({ type: "close", code: 1013, connectionGeneration: 5 });
  assert.equal(socket.readyState, 3);
  assert.equal(closed, 1);
  assert.equal(unsubscribeCount, 1);
});

test("renderer close while connectSignaling is pending closes the resolved generation", async () => {
  const pending = deferred<number>();
  const diagnostics: Array<Record<string, unknown>> = [];
  const closeRequests: number[] = [];
  let unsubscribeCount = 0;
  let receiveEvent: ((event: SocketEvent) => void) | undefined;
  const bridge: Pick<
    LivePresenceBridge,
    "connectSignaling" | "sendSignaling" | "closeSignaling" | "onSocketEvent"
  > = {
    connectSignaling: () => pending.promise,
    sendSignaling: async () => {},
    closeSignaling: (generation) => { closeRequests.push(generation); },
    onSocketEvent: (callback) => {
      receiveEvent = callback;
      return () => { unsubscribeCount += 1; };
    },
  };
  const socket = createSignalingSocket(bridge, (_level, entry) => diagnostics.push(entry));
  let closeCount = 0;
  socket.onclose = () => { closeCount += 1; };

  socket.connect?.();
  socket.close();
  assert.equal(socket.readyState, 3);
  assert.equal(closeCount, 1);
  assert.equal(closeRequests.length, 0);

  pending.resolve(12);
  await new Promise((resolve) => setImmediate(resolve));
  receiveEvent?.({ type: "open", connectionGeneration: 12 });

  assert.equal(socket.connectionGeneration, undefined);
  assert.equal(socket.readyState, 3);
  assert.equal(closeCount, 1);
  assert.deepEqual(closeRequests, [12]);
  assert.equal(unsubscribeCount, 1);
  assert.equal(
    diagnostics.some((entry) =>
      entry.event === "renderer_close_requested" &&
      entry.connectPending === true),
    true,
  );
  assert.equal(
    diagnostics.some((entry) =>
      entry.event === "renderer_connection_closed_while_connect_pending" &&
      entry.socketConnectionGeneration === 12),
    true,
  );
  assert.equal(
    diagnostics.filter((entry) =>
      entry.event === "renderer_connection_attempt_ended").length,
    1,
  );
  assert.equal(
    diagnostics.find((entry) =>
      entry.event === "renderer_connection_attempt_ended")?.outcome,
    "renderer_close",
  );
});

test("a delayed close from an old renderer socket cannot close its replacement", async () => {
  const oldPending = deferred<number>();
  const replacementPending = deferred<number>();
  const diagnostics: Array<Record<string, unknown>> = [];
  const closeRequests: number[] = [];
  let activeGeneration: number | undefined;
  let eventListeners: Array<(event: SocketEvent) => void> = [];
  let connectCallCount = 0;
  const bridge: Pick<
    LivePresenceBridge,
    "connectSignaling" | "sendSignaling" | "closeSignaling" | "onSocketEvent"
  > = {
    connectSignaling: (() => {
      const callIndex = connectCallCount++;
      return callIndex === 0 ? oldPending.promise : replacementPending.promise;
    }) as LivePresenceBridge["connectSignaling"],
    sendSignaling: async () => {},
    closeSignaling: (generation) => {
      closeRequests.push(generation);
      if (activeGeneration === generation) activeGeneration = undefined;
    },
    onSocketEvent: (callback) => {
      eventListeners.push(callback);
      return () => {
        eventListeners = eventListeners.filter((listener) => listener !== callback);
      };
    },
  };
  const oldSocket = createSignalingSocket(bridge, (_level, entry) => diagnostics.push(entry));
  const replacementSocket = createSignalingSocket(bridge, (_level, entry) => diagnostics.push(entry));

  oldSocket.connect?.();
  oldSocket.close();
  replacementSocket.connect?.();
  replacementPending.resolve(22);
  await new Promise((resolve) => setImmediate(resolve));
  activeGeneration = 22;
  eventListeners[0]?.({ type: "open", connectionGeneration: 22 });

  oldPending.resolve(22);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(oldSocket.readyState, 3);
  assert.equal(replacementSocket.connectionGeneration, 22);
  assert.equal(replacementSocket.readyState, 1);
  assert.equal(activeGeneration, 22);
  assert.deepEqual(closeRequests, []);
  assert.equal(
    diagnostics.some((entry) =>
      entry.event === "renderer_connection_generation_associated" &&
      entry.socketConnectionGeneration === 22),
    true,
  );
  assert.equal(
    diagnostics.some((entry) =>
      entry.event === "renderer_stale_connection_resolution_ignored" &&
      entry.socketConnectionGeneration === 22),
    true,
  );
  replacementSocket.close();
});

test("a stale socket cannot close a replacement reusing the same main generation", async () => {
  const closeRequests: number[] = [];
  const listeners: Array<(event: SocketEvent) => void> = [];
  const bridge: Pick<
    LivePresenceBridge,
    "connectSignaling" | "sendSignaling" | "closeSignaling" | "onSocketEvent"
  > = {
    connectSignaling: async () => 33,
    sendSignaling: async () => {},
    closeSignaling: (generation) => { closeRequests.push(generation); },
    onSocketEvent: (callback) => {
      listeners.push(callback);
      return () => {
        const index = listeners.indexOf(callback);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
  };
  const oldSocket = createSignalingSocket(bridge);
  const replacementSocket = createSignalingSocket(bridge);

  oldSocket.connect?.();
  await new Promise((resolve) => setImmediate(resolve));
  listeners[0]?.({ type: "open", connectionGeneration: 33 });
  assert.equal(oldSocket.readyState, 1);

  replacementSocket.connect?.();
  await new Promise((resolve) => setImmediate(resolve));
  for (const listener of [...listeners]) {
    listener({ type: "open", connectionGeneration: 33 });
  }
  assert.equal(replacementSocket.readyState, 1);

  oldSocket.close();
  assert.deepEqual(closeRequests, []);
  assert.equal(replacementSocket.readyState, 1);

  replacementSocket.close();
  assert.deepEqual(closeRequests, [33]);
});

test("a stale socket cannot send using a generation reused by its replacement", async () => {
  const pendingSends: Array<{ data: string; generation: number }> = [];
  const listeners: Array<(event: SocketEvent) => void> = [];
  const bridge: Pick<
    LivePresenceBridge,
    "connectSignaling" | "sendSignaling" | "closeSignaling" | "onSocketEvent"
  > = {
    connectSignaling: async () => 35,
    sendSignaling: async (data, generation) => {
      pendingSends.push({ data, generation });
    },
    closeSignaling: () => {},
    onSocketEvent: (callback) => {
      listeners.push(callback);
      return () => {
        const index = listeners.indexOf(callback);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
  };
  const oldSocket = createSignalingSocket(bridge);
  const replacementSocket = createSignalingSocket(bridge);

  oldSocket.connect?.();
  await new Promise((resolve) => setImmediate(resolve));
  listeners[0]?.({ type: "open", connectionGeneration: 35 });
  assert.equal(oldSocket.connectionGeneration, 35);

  replacementSocket.connect?.();
  await new Promise((resolve) => setImmediate(resolve));
  for (const listener of [...listeners]) {
    listener({ type: "open", connectionGeneration: 35 });
  }
  assert.equal(replacementSocket.connectionGeneration, 35);

  await assert.rejects(
    Promise.resolve(oldSocket.send("stale-message")),
    /no longer the active renderer owner/,
  );
  assert.deepEqual(pendingSends, []);

  await replacementSocket.send("current-message");
  assert.deepEqual(pendingSends, [{ data: "current-message", generation: 35 }]);
  oldSocket.close();
  replacementSocket.close();
});

test("a delayed stale connection resolution cannot associate its generation or buffered events", async () => {
  const oldPending = deferred<number>();
  const replacementPending = deferred<number>();
  const diagnostics: Array<Record<string, unknown>> = [];
  const closeRequests: number[] = [];
  const listeners: Array<(event: SocketEvent) => void> = [];
  let connectCallCount = 0;
  const bridge: Pick<
    LivePresenceBridge,
    "connectSignaling" | "sendSignaling" | "closeSignaling" | "onSocketEvent"
  > = {
    connectSignaling: (() => {
      const callIndex = connectCallCount++;
      return callIndex === 0 ? oldPending.promise : replacementPending.promise;
    }) as LivePresenceBridge["connectSignaling"],
    sendSignaling: async () => {},
    closeSignaling: (generation) => { closeRequests.push(generation); },
    onSocketEvent: (callback) => {
      listeners.push(callback);
      return () => {
        const index = listeners.indexOf(callback);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
  };
  const oldSocket = createSignalingSocket(bridge, (_level, entry) => diagnostics.push(entry));
  const replacementSocket = createSignalingSocket(bridge, (_level, entry) => diagnostics.push(entry));
  let oldOpenCount = 0;
  let oldCloseCount = 0;
  oldSocket.onopen = () => { oldOpenCount += 1; };
  oldSocket.onclose = () => { oldCloseCount += 1; };

  oldSocket.connect?.();
  listeners[0]?.({ type: "open", connectionGeneration: 44 });
  replacementSocket.connect?.();
  replacementPending.resolve(45);
  await new Promise((resolve) => setImmediate(resolve));
  for (const listener of [...listeners]) {
    listener({ type: "open", connectionGeneration: 45 });
  }

  oldPending.resolve(44);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(oldSocket.connectionGeneration, undefined);
  assert.equal(oldSocket.readyState, 3);
  assert.equal(oldOpenCount, 0);
  assert.equal(oldCloseCount, 1);
  assert.equal(replacementSocket.connectionGeneration, 45);
  assert.equal(replacementSocket.readyState, 1);
  assert.deepEqual(closeRequests, []);
  assert.equal(
    diagnostics.some((entry) =>
      entry.event === "renderer_stale_connection_resolution_ignored" &&
      entry.socketConnectionGeneration === 44),
    true,
  );
  assert.equal(
    diagnostics.some((entry) =>
      entry.event === "renderer_connection_generation_association_rejected" &&
      entry.socketConnectionGeneration === 44),
    true,
  );

  oldSocket.close();
  replacementSocket.close();
  assert.deepEqual(closeRequests, [45]);
});

test("managed signaling can authenticate after connect resolves without renderer-close IPC", async () => {
  const closeRequests: number[] = [];
  const diagnostics: Array<{ event?: string }> = [];
  let receiveEvent: ((event: SocketEvent) => void) | undefined;
  let rendererSocket: ReturnType<typeof createSignalingSocket> | undefined;
  const bridge: Pick<
    LivePresenceBridge,
    "connectSignaling" | "sendSignaling" | "closeSignaling" | "onSocketEvent"
  > = {
    connectSignaling: () => {
      receiveEvent?.({
        type: "error",
        message: "early transport error",
        connectionGeneration: 41,
      });
      return Promise.resolve(41);
    },
    sendSignaling: async () => {},
    closeSignaling: (generation) => { closeRequests.push(generation); },
    onSocketEvent: (callback) => {
      receiveEvent = callback;
      return () => { receiveEvent = undefined; };
    },
  };
  const client = new DesktopWebRtcClient({
    socketFactory: () => {
      rendererSocket = createSignalingSocket(bridge);
      return rendererSocket;
    },
    peerFactory: () => { throw new Error("peer factory should not be used"); },
    managedAuthentication: true,
    reconnect: { maxAttempts: 0 },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

  await client.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rendererSocket?.connectionGeneration, 41);
  assert.equal(rendererSocket?.readyState, 0);
  assert.deepEqual(closeRequests, []);

  receiveEvent?.({ type: "authentication-started", connectionGeneration: 41 });
  receiveEvent?.({ type: "open", connectionGeneration: 41 });
  receiveEvent?.({
    type: "message",
    connectionGeneration: 41,
    data: JSON.stringify({ type: "authenticated", role: "owner", device_id: "device" }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(rendererSocket?.readyState, 1);
  assert.equal(client.lifecycle, "CONNECTING");
  assert.equal(closeRequests.length, 0);
  assert.equal(
    diagnostics.some((diagnostic) => diagnostic.event === "owner_authentication_completed"),
    true,
  );
  client.close();
  assert.deepEqual(closeRequests, [41]);
});

test("authenticated transport reuse marks its open event as authenticated", async () => {
  const pending = deferred<number>();
  const diagnostics: Array<Record<string, unknown>> = [];
  let receiveEvent: ((event: SocketEvent) => void) | undefined;
  const bridge: Pick<
    LivePresenceBridge,
    "connectSignaling" | "sendSignaling" | "closeSignaling" | "onSocketEvent"
  > = {
    connectSignaling: () => pending.promise,
    sendSignaling: async () => {},
    closeSignaling: () => {},
    onSocketEvent: (callback) => {
      receiveEvent = callback;
      return () => { receiveEvent = undefined; };
    },
  };
  const socket = createSignalingSocket(bridge, (_level, entry) => diagnostics.push(entry));
  socket.connect?.();
  pending.resolve(46);
  await new Promise((resolve) => setImmediate(resolve));

  receiveEvent?.({
    type: "open",
    connectionGeneration: 46,
    authenticatedTransportReuse: true,
    deviceId: "00000000-0000-0000-0000-000000000046",
  });

  assert.equal(socket.readyState, 1);
  assert.equal(socket.authenticatedOnOpen, true);
  assert.equal(socket.authenticatedDeviceId, "00000000-0000-0000-0000-000000000046");
  assert.equal(
    diagnostics.some((entry) =>
      entry.event === "renderer_socket_open_received" &&
      entry.authenticatedTransportReuse === true),
    true,
  );
  socket.close();
});

test("open without explicit reuse metadata is not inferred as authenticated reuse", async () => {
  const listeners: Array<(event: SocketEvent) => void> = [];
  const bridge: Pick<
    LivePresenceBridge,
    "connectSignaling" | "sendSignaling" | "closeSignaling" | "onSocketEvent"
  > = {
    connectSignaling: async () => 48,
    sendSignaling: async () => {},
    closeSignaling: () => {},
    onSocketEvent: (callback) => {
      listeners.push(callback);
      return () => {};
    },
  };
  const socket = createSignalingSocket(bridge, () => {});
  socket.connect?.();
  await new Promise((resolve) => setImmediate(resolve));
  listeners[0]?.({ type: "open", connectionGeneration: 48 });

  assert.equal(socket.readyState, 1);
  assert.equal(socket.authenticatedOnOpen, false);
  assert.equal(socket.authenticatedDeviceId, undefined);
  socket.close();
});

test("diagnostic logger failures do not interrupt renderer signaling", async () => {
  const listeners: Array<(event: SocketEvent) => void> = [];
  const sends: string[] = [];
  const bridge: Pick<
    LivePresenceBridge,
    "connectSignaling" | "sendSignaling" | "closeSignaling" | "onSocketEvent"
  > = {
    connectSignaling: async () => 47,
    sendSignaling: async (data) => { sends.push(data); },
    closeSignaling: () => {},
    onSocketEvent: (callback) => {
      listeners.push(callback);
      return () => {};
    },
  };
  const socket = createSignalingSocket(bridge, () => { throw new Error("diagnostic sink failed"); });
  socket.connect?.();
  await new Promise((resolve) => setImmediate(resolve));
  listeners[0]?.({ type: "open", connectionGeneration: 47 });
  await socket.send("safe-test-message");

  assert.equal(socket.readyState, 1);
  assert.deepEqual(sends, ["safe-test-message"]);
  socket.close();
});

test("renderer signaling rejects a superseded peer before invoking IPC", async () => {
  const listeners: Array<(event: SocketEvent) => void> = [];
  const sends: string[] = [];
  const bridge: Pick<
    LivePresenceBridge,
    "connectSignaling" | "sendSignaling" | "closeSignaling" | "onSocketEvent"
  > = {
    connectSignaling: async () => 48,
    sendSignaling: async (data) => { sends.push(data); },
    closeSignaling: () => {},
    onSocketEvent: (callback) => {
      listeners.push(callback);
      return () => {};
    },
  };
  const socket = createSignalingSocket(bridge);
  socket.connect?.();
  await new Promise((resolve) => setImmediate(resolve));
  listeners[0]?.({ type: "open", connectionGeneration: 48 });

  await assert.rejects(async () => { await socket.send("stale-offer", undefined, () => false); }, /superseded peer/);
  assert.deepEqual(sends, []);
  await socket.send("current-offer", undefined, () => true);
  assert.deepEqual(sends, ["current-offer"]);
  socket.close();
});

test("renderer signaling forwards only the main-issued peer registration through IPC", async () => {
  const listeners: Array<(event: SocketEvent) => void> = [];
  const registrations: Array<[string, number]> = [];
  const clearings: string[] = [];
  const sends: Array<[string, number, string | undefined]> = [];
  const bridge: Pick<
    LivePresenceBridge,
    "connectSignaling" | "sendSignaling" | "closeSignaling" | "onSocketEvent"
  > & Partial<Pick<
    LivePresenceBridge,
    "registerSignalingPeerGeneration" | "clearSignalingPeerGeneration"
  >> = {
    connectSignaling: async () => 49,
    registerSignalingPeerGeneration: async (sessionId, connectionGeneration) => {
      registrations.push([sessionId, connectionGeneration]);
      return "main-registration-1";
    },
    clearSignalingPeerGeneration: async (registrationId) => {
      clearings.push(registrationId);
    },
    sendSignaling: async (data, connectionGeneration, registrationId) => {
      sends.push([data, connectionGeneration, registrationId]);
    },
    closeSignaling: () => {},
    onSocketEvent: (callback) => {
      listeners.push(callback);
      return () => {};
    },
  };
  const socket = createSignalingSocket(bridge);
  socket.connect?.();
  await new Promise((resolve) => setImmediate(resolve));
  const registration = socket.setPeerGeneration?.(12, "00000000-0000-0000-0000-000000000101");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(registrations, []);

  listeners[0]?.({ type: "open", connectionGeneration: 49 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(registrations, []);

  listeners[0]?.({
    type: "message",
    data: JSON.stringify({
      type: "session_recovery",
      session_id: "00000000-0000-0000-0000-000000000101",
      recovery_attempt_id: "recovery-current",
    }),
    connectionGeneration: 49,
  });

  await registration;
  await socket.send("current-offer", 12, () => true);

  assert.deepEqual(registrations, [["00000000-0000-0000-0000-000000000101", 49]]);
  assert.deepEqual(sends, [["current-offer", 49, "main-registration-1"]]);
  assert.deepEqual(clearings, []);
  socket.close();
});

test("peer registration waits for authentication and matching server session restoration", async () => {
  const listeners: Array<(event: SocketEvent) => void> = [];
  const registrations: Array<[string, number]> = [];
  const bridge: Pick<
    LivePresenceBridge,
    "connectSignaling" | "sendSignaling" | "closeSignaling" | "onSocketEvent"
  > & Partial<Pick<LivePresenceBridge, "registerSignalingPeerGeneration">> = {
    connectSignaling: async () => 50,
    registerSignalingPeerGeneration: async (sessionId, connectionGeneration) => {
      registrations.push([sessionId, connectionGeneration]);
      return "registration-ready";
    },
    sendSignaling: async () => {},
    closeSignaling: () => {},
    onSocketEvent: (callback) => {
      listeners.push(callback);
      return () => {};
    },
  };
  const socket = createSignalingSocket(bridge);
  socket.connect?.();
  await new Promise((resolve) => setImmediate(resolve));
  const registration = socket.setPeerGeneration?.(18, "00000000-0000-0000-0000-000000000102");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(registrations, []);

  listeners[0]?.({ type: "open", connectionGeneration: 50 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(registrations, []);

  listeners[0]?.({
    type: "message",
    data: JSON.stringify({
      type: "viewer_joined",
      session_id: "00000000-0000-0000-0000-000000000102",
      viewer_user_id: "viewer",
    }),
    connectionGeneration: 50,
  });
  await registration;
  assert.deepEqual(registrations, [["00000000-0000-0000-0000-000000000102", 50]]);
  socket.close();
});

test("old peer registration is cleared immediately while the replacement waits for session restoration", async () => {
  const listeners: Array<(event: SocketEvent) => void> = [];
  const registrations: string[] = [];
  const clearings: string[] = [];
  const bridge: Pick<
    LivePresenceBridge,
    "connectSignaling" | "sendSignaling" | "closeSignaling" | "onSocketEvent"
  > & Partial<Pick<
    LivePresenceBridge,
    "registerSignalingPeerGeneration" | "clearSignalingPeerGeneration"
  >> = {
    connectSignaling: async () => 51,
    registerSignalingPeerGeneration: async (sessionId) => {
      registrations.push(sessionId);
      return `registration-${registrations.length}`;
    },
    clearSignalingPeerGeneration: async (registrationId) => { clearings.push(registrationId); },
    sendSignaling: async () => {},
    closeSignaling: () => {},
    onSocketEvent: (callback) => {
      listeners.push(callback);
      return () => {};
    },
  };
  const socket = createSignalingSocket(bridge);
  socket.connect?.();
  await new Promise((resolve) => setImmediate(resolve));
  listeners[0]?.({ type: "open", connectionGeneration: 51 });
  listeners[0]?.({
    type: "message",
    data: JSON.stringify({ type: "session_recovery", session_id: "00000000-0000-0000-0000-000000000103" }),
    connectionGeneration: 51,
  });
  await socket.setPeerGeneration?.(1, "00000000-0000-0000-0000-000000000103");

  const replacement = socket.setPeerGeneration?.(2, "00000000-0000-0000-0000-000000000104");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(clearings, ["registration-1"]);
  assert.deepEqual(registrations, ["00000000-0000-0000-0000-000000000103"]);

  listeners[0]?.({
    type: "message",
    data: JSON.stringify({ type: "session_recovery", session_id: "00000000-0000-0000-0000-000000000104" }),
    connectionGeneration: 51,
  });
  await replacement;
  assert.deepEqual(registrations, [
    "00000000-0000-0000-0000-000000000103",
    "00000000-0000-0000-0000-000000000104",
  ]);
  socket.close();
});

test("peer registration is rejected when the server-observed session changes while it waits", async () => {
  const listeners: Array<(event: SocketEvent) => void> = [];
  const registrations: string[] = [];
  const bridge: Pick<
    LivePresenceBridge,
    "connectSignaling" | "sendSignaling" | "closeSignaling" | "onSocketEvent"
  > & Partial<Pick<LivePresenceBridge, "registerSignalingPeerGeneration">> = {
    connectSignaling: async () => 52,
    registerSignalingPeerGeneration: async (sessionId) => {
      registrations.push(sessionId);
      return "registration";
    },
    sendSignaling: async () => {},
    closeSignaling: () => {},
    onSocketEvent: (callback) => {
      listeners.push(callback);
      return () => {};
    },
  };
  const socket = createSignalingSocket(bridge);
  socket.connect?.();
  await new Promise((resolve) => setImmediate(resolve));
  listeners[0]?.({ type: "open", connectionGeneration: 52 });
  const registration = socket.setPeerGeneration?.(3, "00000000-0000-0000-0000-000000000105");
  assert.ok(registration);
  await new Promise((resolve) => setImmediate(resolve));
  listeners[0]?.({
    type: "message",
    data: JSON.stringify({ type: "session_recovery", session_id: "00000000-0000-0000-0000-000000000106" }),
    connectionGeneration: 52,
  });
  await assert.rejects(registration, /session changed/);
  assert.deepEqual(registrations, []);
  socket.close();
});

test("peer registration is rejected when its socket generation changes while waiting", async () => {
  const listeners: Array<(event: SocketEvent) => void> = [];
  const registrations: string[] = [];
  const bridge: Pick<
    LivePresenceBridge,
    "connectSignaling" | "sendSignaling" | "closeSignaling" | "onSocketEvent"
  > & Partial<Pick<LivePresenceBridge, "registerSignalingPeerGeneration">> = {
    connectSignaling: async () => 53,
    registerSignalingPeerGeneration: async (sessionId) => {
      registrations.push(sessionId);
      return "registration";
    },
    sendSignaling: async () => {},
    closeSignaling: () => {},
    onSocketEvent: (callback) => {
      listeners.push(callback);
      return () => {};
    },
  };
  const socket = createSignalingSocket(bridge);
  socket.connect?.();
  await new Promise((resolve) => setImmediate(resolve));
  listeners[0]?.({ type: "open", connectionGeneration: 53 });
  const registration = socket.setPeerGeneration?.(4, "00000000-0000-0000-0000-000000000101");
  assert.ok(registration);
  await new Promise((resolve) => setImmediate(resolve));
  listeners[0]?.({ type: "open", connectionGeneration: 54 });
  await assert.rejects(registration, /connection generation changed|superseded/);
  assert.deepEqual(registrations, []);
  socket.close();
});

test("a superseded renderer socket cannot overwrite the current peer registration", async () => {
  const listeners: Array<(event: SocketEvent) => void> = [];
  const registrations: Array<[string, number]> = [];
  const bridge: Pick<
    LivePresenceBridge,
    "connectSignaling" | "sendSignaling" | "closeSignaling" | "onSocketEvent"
  > & Partial<Pick<LivePresenceBridge, "registerSignalingPeerGeneration">> = {
    connectSignaling: async () => 55,
    registerSignalingPeerGeneration: async (sessionId, connectionGeneration) => {
      registrations.push([sessionId, connectionGeneration]);
      return `registration-${registrations.length}`;
    },
    sendSignaling: async () => {},
    closeSignaling: () => {},
    onSocketEvent: (callback) => {
      listeners.push(callback);
      return () => {};
    },
  };
  const oldSocket = createSignalingSocket(bridge);
  oldSocket.connect?.();
  await new Promise((resolve) => setImmediate(resolve));
  const oldRegistration = oldSocket.setPeerGeneration?.(7, "00000000-0000-0000-0000-000000000101");
  assert.ok(oldRegistration);

  const currentSocket = createSignalingSocket(bridge);
  currentSocket.connect?.();
  await new Promise((resolve) => setImmediate(resolve));
  listeners[1]?.({ type: "open", connectionGeneration: 55 });
  listeners[1]?.({
    type: "message",
    data: JSON.stringify({ type: "session_recovery", session_id: "00000000-0000-0000-0000-000000000101" }),
    connectionGeneration: 55,
  });
  await currentSocket.setPeerGeneration?.(8, "00000000-0000-0000-0000-000000000101");
  await assert.rejects(oldRegistration, /superseded/);
  listeners[0]?.({
    type: "message",
    data: JSON.stringify({ type: "session_recovery", session_id: "00000000-0000-0000-0000-000000000101" }),
    connectionGeneration: 55,
  });

  assert.deepEqual(registrations, [["00000000-0000-0000-0000-000000000101", 55]]);
  currentSocket.close();
  oldSocket.close();
});

test("connect rejection diagnostics preserve the safe IPC category and correlation ID", async () => {
  const diagnostics: Array<Record<string, unknown>> = [];
  let receivedCorrelationId: string | undefined;
  const bridge: Pick<
    LivePresenceBridge,
    "connectSignaling" | "sendSignaling" | "closeSignaling" | "onSocketEvent"
  > = {
    connectSignaling: async (correlationId) => {
      receivedCorrelationId = correlationId;
      throw new Error(`${SIGNALLING_CONNECT_ERROR_PREFIX}connection_setup_timeout`);
    },
    sendSignaling: async () => {},
    closeSignaling: () => {},
    onSocketEvent: () => () => {},
  };
  const socket = createSignalingSocket(bridge, (_level, entry) => diagnostics.push(entry));
  socket.connect?.();
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(receivedCorrelationId ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(socket.readyState, 3);
  const rejected = diagnostics.find((entry) =>
    entry.event === "renderer_connection_generation_association_rejected");
  assert.equal(rejected?.reason, "connect_signaling_rejected");
  assert.equal(rejected?.connectFailureCategory, "connection_setup_timeout");
  assert.equal(rejected?.correlationId, receivedCorrelationId);
  socket.close();
});

test("a genuine terminal close cleans up the renderer socket without a redundant close request", async () => {
  let receiveEvent: ((event: SocketEvent) => void) | undefined;
  let unsubscribeCount = 0;
  const closeRequests: number[] = [];
  let rendererSocket: ReturnType<typeof createSignalingSocket> | undefined;
  const bridge: Pick<
    LivePresenceBridge,
    "connectSignaling" | "sendSignaling" | "closeSignaling" | "onSocketEvent"
  > = {
    connectSignaling: async () => 54,
    sendSignaling: async () => {},
    closeSignaling: (generation) => { closeRequests.push(generation); },
    onSocketEvent: (callback) => {
      receiveEvent = callback;
      return () => {
        unsubscribeCount += 1;
        receiveEvent = undefined;
      };
    },
  };
  const client = new DesktopWebRtcClient({
    socketFactory: () => {
      rendererSocket = createSignalingSocket(bridge);
      return rendererSocket;
    },
    peerFactory: () => { throw new Error("peer factory should not be used"); },
    managedAuthentication: true,
    reconnect: { maxAttempts: 0 },
  });

  await client.start();
  await new Promise((resolve) => setImmediate(resolve));
  receiveEvent?.({ type: "open", connectionGeneration: 54 });
  receiveEvent?.({
    type: "message",
    connectionGeneration: 54,
    data: JSON.stringify({ type: "authenticated", role: "owner", device_id: "device" }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  receiveEvent?.({ type: "close", code: 1008, connectionGeneration: 54 });

  assert.equal(client.lifecycle, "FAILED");
  assert.equal(rendererSocket?.readyState, 3);
  assert.equal(unsubscribeCount, 1);
  assert.deepEqual(closeRequests, []);
  client.close();
});
