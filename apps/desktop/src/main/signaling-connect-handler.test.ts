import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSignalingConnectHandler,
  readSignalingConnectFailureCategory,
  type SignalingConnectDiagnostic,
} from "./signaling-connect-handler.js";

const correlationId = "123e4567-e89b-42d3-a456-426614174000";

function makeHandler(options: {
  senderAllowed?: boolean;
  connect?: () => Promise<number>;
  authenticatedReuse?: boolean;
} = {}) {
  const diagnostics: SignalingConnectDiagnostic[] = [];
  let transport: object | undefined = {};
  const handler = createSignalingConnectHandler<object, object>({
    isSenderAllowed: () => options.senderAllowed ?? true,
    getTransport: () => transport,
    createTransport: () => ({}),
    setTransport: (value) => { transport = value; },
    isAuthenticatedReuse: () => options.authenticatedReuse ?? false,
    connect: () => options.connect?.() ?? Promise.resolve(7),
    log: (diagnostic) => diagnostics.push(diagnostic),
  });
  return { handler, diagnostics };
}

test("signaling connect sender rejection is diagnosed and categorized", async () => {
  const { handler, diagnostics } = makeHandler({ senderAllowed: false });

  await assert.rejects(handler({}, correlationId), (error: unknown) => {
    assert.equal(readSignalingConnectFailureCategory(error), "sender_validation_rejected");
    return true;
  });
  assert.deepEqual(diagnostics, [{
    event: "signaling_connect_sender_rejected",
    correlationId,
    level: "warn",
    connectErrorName: "Error",
    connectErrorCategory: "sender_validation_rejected",
    connectErrorMessage: "Signaling IPC sender validation rejected",
  }]);
});

test("transport initialization failure is diagnosed and rejected without exposing the error", async () => {
  const diagnostics: SignalingConnectDiagnostic[] = [];
  let connectCalled = false;
  const handler = createSignalingConnectHandler<object, object>({
    isSenderAllowed: () => true,
    getTransport: () => undefined,
    createTransport: () => {
      throw new Error("credential=private-token; cookie=session-secret");
    },
    setTransport: () => {},
    isAuthenticatedReuse: () => false,
    connect: async () => {
      connectCalled = true;
      return 7;
    },
    log: (diagnostic) => diagnostics.push(diagnostic),
  });

  await assert.rejects(handler({}, correlationId), (error: unknown) => {
    assert.equal(
      readSignalingConnectFailureCategory(error),
      "transport_initialization_failed",
    );
    assert.doesNotMatch(error instanceof Error ? error.message : "", /private-token|session-secret/);
    return true;
  });
  assert.equal(connectCalled, false);
  assert.deepEqual(diagnostics, [{
    event: "signaling_connect_transport_initialization_failed",
    correlationId,
    level: "error",
    connectErrorName: "Error",
    connectErrorCategory: "transport_initialization_failed",
    connectErrorMessage: "Signaling transport initialization failed",
  }]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /private-token|session-secret|credential|cookie/);
});

test("signaling connect rejection logs only sanitized error details", async () => {
  const { handler, diagnostics } = makeHandler({
    connect: async () => {
      const error = new Error("Bearer private-token; cookie=session-secret");
      error.name = "Bearer private-token";
      throw error;
    },
  });

  await assert.rejects(handler({}, correlationId), (error: unknown) => {
    assert.equal(readSignalingConnectFailureCategory(error), "transport_connect_rejected");
    return true;
  });
  assert.deepEqual(diagnostics, [{
    event: "signaling_connect_transport_rejected",
    correlationId,
    level: "error",
    connectErrorName: "UnknownError",
    connectErrorCategory: "transport_connect_rejected",
    connectErrorMessage: "Signaling transport connection rejected",
  }]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /private-token|session-secret|Bearer/);
});

test("known connection failures retain a safe specific category", async () => {
  const { handler, diagnostics } = makeHandler({
    connect: async () => { throw new Error("signaling connection setup timed out"); },
  });

  await assert.rejects(handler({}, correlationId), (error: unknown) => {
    assert.equal(readSignalingConnectFailureCategory(error), "connection_setup_timeout");
    return true;
  });
  assert.equal(diagnostics[0]?.connectErrorCategory, "connection_setup_timeout");
  assert.equal(diagnostics[0]?.connectErrorMessage, "Signaling connection setup timed out");
});

test("authenticated transport reuse success is explicitly diagnosed", async () => {
  const { handler, diagnostics } = makeHandler({ authenticatedReuse: true });

  assert.equal(await handler({}, correlationId), 7);
  assert.deepEqual(diagnostics, [{
    event: "signaling_connect_authenticated_reuse_succeeded",
    correlationId,
    level: "info",
  }]);
});

test("authenticated reuse event delivery failure stays classified when logging throws", async () => {
  const diagnostics: SignalingConnectDiagnostic[] = [];
  const deliveryError = new Error("deviceCredential=private-token; sdp=private-description");
  const loggerError = new Error("log path contains private-token");
  const handler = createSignalingConnectHandler<object, object>({
    isSenderAllowed: () => true,
    getTransport: () => ({}),
    createTransport: () => ({}),
    setTransport: () => {},
    isAuthenticatedReuse: () => true,
    connect: async () => {
      throw deliveryError;
    },
    log: (diagnostic) => {
      diagnostics.push(diagnostic);
      throw loggerError;
    },
  });

  await assert.rejects(handler({}, correlationId), (error: unknown) => {
    assert.equal(readSignalingConnectFailureCategory(error), "authenticated_reuse_failed");
    assert.doesNotMatch(error instanceof Error ? error.message : "", /private-token|private-description/);
    return true;
  });
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.event, "signaling_connect_transport_rejected");
  assert.equal(diagnostics[0]?.connectErrorCategory, "authenticated_reuse_failed");
  assert.equal(diagnostics[0]?.connectErrorMessage, "Authenticated transport reuse failed");
  assert.doesNotMatch(JSON.stringify(diagnostics), /private-token|private-description|deviceCredential|sdp/);
});
