import assert from "node:assert/strict";
import { test } from "node:test";
import {
  registerSignalingIpcHandlers,
  type SignalingIpcRegistrar,
  type SignalingTransportBoundary,
} from "./signaling-ipc-handlers.js";
import { SignalingPeerGeneration } from "./signaling-peer-generation.js";

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const SESSION_ID = "11111111-1111-4111-8111-111111111111";

function createHarness() {
  const handlers = new Map<string, Handler>();
  const listeners = new Map<string, Handler>();
  const sent: string[] = [];
  const sender = {};
  let sharingActive = true;
  let stopping = false;
  const transport = {
    connectionGeneration: 4,
    hasAuthenticatedOpenSocket: true,
    activeSessionId: SESSION_ID,
    send: (raw, expectedGeneration) => {
      if (expectedGeneration !== transport.connectionGeneration) {
        throw new Error("signaling connection generation is stale");
      }
      sent.push(raw);
    },
    close: () => true,
  } satisfies SignalingTransportBoundary;
  let activeTransport: SignalingTransportBoundary = transport;
  const peerGeneration = new SignalingPeerGeneration();
  const registrar: SignalingIpcRegistrar = {
    handle: (channel, handler) => { handlers.set(channel, handler); },
    on: (channel, listener) => { listeners.set(channel, listener); },
  };
  registerSignalingIpcHandlers(registrar, {
    isSenderAllowed: (event) => event === sender,
    getTransport: () => activeTransport,
    isSharingActive: () => sharingActive,
    isStopping: () => stopping,
    peerGeneration,
  });
  const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const handler = handlers.get(channel);
    assert.ok(handler, `missing handler: ${channel}`);
    return handler(sender, ...args);
  };
  return {
    handlers,
    invoke,
    peerGeneration,
    sent,
    sender,
    transport,
    replaceTransport: (nextTransport: SignalingTransportBoundary) => {
      activeTransport = nextTransport;
    },
    setSharingActive: (value: boolean) => { sharingActive = value; },
    setStopping: (value: boolean) => { stopping = value; },
  };
}

const offer = JSON.stringify({
  type: "offer",
  session_id: SESSION_ID,
  negotiation_id: "negotiation-current",
  sdp: "v=0\r\n",
});

test("production IPC handlers authorize current peer registration and signaling", async () => {
  const harness = createHarness();
  const registrationId = await harness.invoke("signaling:peer-generation", SESSION_ID, 4);
  assert.equal(typeof registrationId, "string");
  await harness.invoke("signaling:send", offer, 4, registrationId);
  assert.equal(harness.sent.length, 1);
});

test("production IPC registration rejects renderer-supplied future generations", async () => {
  const harness = createHarness();
  await assert.rejects(
    harness.invoke("signaling:peer-generation", SESSION_ID, 4, 9_999_999),
    /invalid signaling peer registration request/,
  );
});

test("production IPC registration rejects an obsolete transport generation", async () => {
  const harness = createHarness();
  await assert.rejects(
    harness.invoke("signaling:peer-generation", SESSION_ID, 3),
    /signaling peer registration is not authorized/,
  );
  const registrationId = await harness.invoke("signaling:peer-generation", SESSION_ID, 4);
  await assert.rejects(
    harness.invoke("signaling:send", offer, 3, registrationId),
    /signaling connection generation is stale|owner signaling transport was superseded/,
  );
  assert.equal(harness.sent.length, 0);
});

test("a previously registered peer becomes stale after replacement", async () => {
  const harness = createHarness();
  const oldRegistration = await harness.invoke("signaling:peer-generation", SESSION_ID, 4);
  const currentRegistration = await harness.invoke("signaling:peer-generation", SESSION_ID, 4);
  await assert.rejects(
    harness.invoke("signaling:send", offer, 4, oldRegistration),
    /signaling peer registration is stale/,
  );
  await harness.invoke("signaling:send", offer, 4, currentRegistration);
  assert.equal(harness.sent.length, 1);
});

test("stale signaling is rejected at the production IPC send handler after replacement", async () => {
  const harness = createHarness();
  const oldRegistration = await harness.invoke("signaling:peer-generation", SESSION_ID, 4);
  const pendingSend = harness.invoke("signaling:send", offer, 4, oldRegistration);
  await harness.invoke("signaling:peer-generation", SESSION_ID, 4);
  await assert.rejects(pendingSend, /signaling peer registration is stale/);
  assert.equal(harness.sent.length, 0);
});

test("Stop Sharing invalidates registration before a pending offer can forward", async () => {
  const harness = createHarness();
  const registrationId = await harness.invoke("signaling:peer-generation", SESSION_ID, 4);
  const pendingSend = harness.invoke("signaling:send", offer, 4, registrationId);
  await harness.invoke(
    "signaling:send",
    JSON.stringify({ type: "sharing_state", screen: false, camera: false }),
    4,
  );
  await assert.rejects(pendingSend, /signaling connection generation is stale|peer registration is stale/);
  assert.equal(harness.sent.length, 1);
  assert.equal(JSON.parse(harness.sent[0]!).type, "sharing_state");
});

test("cleanup from an old peer cannot invalidate a newer registration", async () => {
  const harness = createHarness();
  const oldRegistration = await harness.invoke("signaling:peer-generation", SESSION_ID, 4);
  const currentRegistration = await harness.invoke("signaling:peer-generation", SESSION_ID, 4);
  await harness.invoke("signaling:peer-generation:clear", oldRegistration);
  await harness.invoke("signaling:send", offer, 4, currentRegistration);
  assert.equal(harness.sent.length, 1);
});

test("transport generation is rechecked immediately before forwarding", async () => {
  const harness = createHarness();
  const registrationId = await harness.invoke("signaling:peer-generation", SESSION_ID, 4);
  const pendingSend = harness.invoke("signaling:send", offer, 4, registrationId);
  harness.transport.connectionGeneration = 5;
  await assert.rejects(pendingSend, /owner signaling transport was superseded/);
  assert.equal(harness.sent.length, 0);
});

test("registrations cannot cross to a replacement transport with a reused numeric generation", async () => {
  const harness = createHarness();
  const registrationId = await harness.invoke("signaling:peer-generation", SESSION_ID, 4);
  const replacementTransport = {
    ...harness.transport,
    send: () => assert.fail("old peer registration must not reach replacement transport"),
    close: () => true,
  } satisfies SignalingTransportBoundary;
  harness.replaceTransport(replacementTransport);

  await assert.rejects(
    harness.invoke("signaling:send", offer, 4, registrationId),
    /signaling session does not match the active peer registration/,
  );
  assert.equal(harness.sent.length, 0);
});

test("active session and sharing lifecycle are rechecked immediately before forwarding", async () => {
  const harness = createHarness();
  const registrationId = await harness.invoke("signaling:peer-generation", SESSION_ID, 4);
  const pendingSend = harness.invoke("signaling:send", offer, 4, registrationId);
  harness.transport.activeSessionId = "22222222-2222-4222-8222-222222222222";
  await assert.rejects(pendingSend, /owner signaling transport was superseded/);
  assert.equal(harness.sent.length, 0);

  const currentRegistration = await harness.invoke(
    "signaling:peer-generation",
    harness.transport.activeSessionId,
    4,
  );
  const updatedOffer = offer.replace(SESSION_ID, harness.transport.activeSessionId);
  const stoppedSend = harness.invoke("signaling:send", updatedOffer, 4, currentRegistration);
  harness.setSharingActive(false);
  await assert.rejects(stoppedSend, /owner signaling transport was superseded/);
  assert.equal(harness.sent.length, 0);
});
