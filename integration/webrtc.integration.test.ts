import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { build } from "esbuild";
import { buildApp } from "../server/src/app.js";

declare global {
  interface Window {
    livePresenceHarness?: {
      start: () => Promise<void>;
      snapshot: () => Promise<{
        lifecycle: string;
        receivedTracks: number;
        renderedFrames: number;
        peerConnectionState: string | null;
        iceConnectionState: string | null;
        openSockets: number;
        stats: {
          candidateType: string | null;
          localCandidateType: string | null;
          remoteCandidateType: string | null;
          dtlsState: string | null;
        } | null;
        gatheredCandidateTypes: string[];
        authenticatedSockets: number;
        authenticated: boolean;
        error: string | null;
        peerConnectionsCreated: number;
        syntheticTracksAttached: number;
        sessionId: string | null;
      }>;
      close: () => void;
      forceSocketClose: () => void;
    };
  }
}

const mode = process.argv.find((argument) => argument.startsWith("--mode="))?.split("=")[1] ?? "all";

const cloudflareConfigured = Boolean(
  process.env.CLOUDFLARE_TURN_KEY_ID && process.env.CLOUDFLARE_TURN_API_TOKEN,
);
const missingSetup = cloudflareConfigured ? undefined : "CLOUDFLARE_TURN_KEY_ID and CLOUDFLARE_TURN_API_TOKEN are required";

type Credentials = {
  ownerCookie: string;
  ownerUserId: string;
  ownerRefreshToken: string;
  viewerCookie: string;
  viewerSessionToken: string;
  viewerUserId: string;
  deviceId: string;
};

type IceServersOverride = Array<{
  urls: string | string[];
  username?: string;
  credential?: string;
}>;

type Harness = {
  browser: Browser;
  ownerContext: BrowserContext;
  viewerContext: BrowserContext;
  ownerPage: Page;
  viewerPage: Page;
  close: () => Promise<void>;
  restartServer: () => Promise<void>;
};

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate an integration-test port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function cookieParts(setCookie: string | string[]): { header: string; value: string } {
  const header = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0]!;
  return { header, value: header.split("=")[1]! };
}

async function provision(
  app: Awaited<ReturnType<typeof buildApp>>["app"],
): Promise<Credentials> {
  async function login(email: string): Promise<{ cookie: string; userId: string }> {
    const requested = await app.inject({
      method: "POST",
      url: "/auth/request-login",
      payload: { email },
    });
    const token = requested.json<{ developmentToken: string }>().developmentToken;
    const verified = await app.inject({
      method: "POST",
      url: "/auth/verify-login",
      payload: { token },
    });
    const cookie = cookieParts(verified.headers["set-cookie"] as string | string[]);
    return { cookie: cookie.header, userId: verified.json<{ user: { id: string } }>().user.id };
  }

  const owner = await login("phase4-owner@example.com");
  const viewer = await login("phase4-viewer@example.com");
  const enrollment = await app.inject({
    method: "POST",
    url: "/devices/enrollment-code",
    headers: { cookie: owner.cookie },
  });
  const code = enrollment.json<{ code: string }>().code;
  const enrolled = await app.inject({
    method: "POST",
    url: "/devices/enroll",
    payload: { code, name: "Phase 4 integration device", platform: "macOS" },
  });
  const device = enrolled.json<{ deviceId: string; refreshToken: string }>();
  return {
    ownerCookie: owner.cookie,
    ownerUserId: owner.userId,
    ownerRefreshToken: device.refreshToken,
    viewerCookie: viewer.cookie,
    viewerSessionToken: viewer.cookie.split("=")[1]!,
    viewerUserId: viewer.userId,
    deviceId: device.deviceId,
  };
}

async function bundleBrowserEntry(): Promise<string> {
  const output = join(tmpdir(), `live-presence-webrtc-${process.pid}-${Date.now()}.js`);
  await build({
    entryPoints: [join(process.cwd(), "integration/browser-entry.ts")],
    outfile: output,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
  });
  return output;
}

async function createHarness(
  policy: "all" | "relay",
  iceServersOverride?: IceServersOverride,
  viewerReconnectBaseDelayMs = 1_000,
  blockDirectCandidates = false,
): Promise<Harness> {
  const port = await freePort();
  const origin = `http://localhost:${port}`;
  const databaseDirectory = mkdtempSync(join(tmpdir(), "live-presence-webrtc-db-"));
  const databasePath = join(databaseDirectory, "integration.sqlite");
  type Runtime = Awaited<ReturnType<typeof buildApp>>;
  let runtime: Runtime | undefined;
  const startServer = async (): Promise<Runtime> => {
    const next = await buildApp(
      databasePath,
      3600,
      "test",
      undefined,
      600,
      45,
      origin,
      process.env.CLOUDFLARE_TURN_KEY_ID,
      process.env.CLOUDFLARE_TURN_API_TOKEN,
      undefined,
      Number(process.env.TURN_CREDENTIAL_TTL_SECONDS ?? 86_400),
    );
    next.app.get("/", async (_request, reply) => reply.type("text/html").send("<!doctype html><title>Phase 4 WebRTC test</title>"));
    await next.app.listen({ host: "127.0.0.1", port });
    runtime = next;
    return next;
  };
  const stopServer = async (): Promise<void> => {
    const current = runtime;
    runtime = undefined;
    if (!current) return;
    await current.app.close();
    current.close();
  };
  const server = await startServer();
  const credentials = await provision(server.app);
  server.authorization.grant(credentials.ownerUserId, credentials.viewerUserId);
  const bundle = await bundleBrowserEntry();
  const browser = await chromium.launch({ headless: true });
  const ownerContext = await browser.newContext();
  const viewerContext = await browser.newContext();
  await viewerContext.addCookies([{
    name: "live_presence_session",
    value: credentials.viewerSessionToken,
    url: origin,
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
  }]);
  const ownerPage = await ownerContext.newPage();
  const viewerPage = await viewerContext.newPage();
  await ownerPage.goto(origin);
  await viewerPage.goto(origin);
  await ownerPage.addScriptTag({ path: bundle });
  await viewerPage.addScriptTag({ path: bundle });
  const common = {
    baseUrl: origin,
    wsUrl: `ws://localhost:${port}/ws`,
    policy,
    blockDirectCandidates,
  };
  await ownerPage.evaluate((options) => {
    (window as Window & { livePresenceOptions?: unknown }).livePresenceOptions = options;
  }, { ...common, role: "owner", token: credentials.ownerRefreshToken, iceServersOverride });
  await viewerPage.evaluate((options) => {
    (window as Window & { livePresenceOptions?: unknown }).livePresenceOptions = options;
  }, {
    ...common,
    role: "viewer",
    token: credentials.viewerSessionToken,
    deviceId: credentials.deviceId,
    iceServersOverride,
    reconnectBaseDelayMs: viewerReconnectBaseDelayMs,
  });
  const close = async (): Promise<void> => {
    await ownerPage.evaluate(() => window.livePresenceHarness?.close()).catch(() => undefined);
    await viewerPage.evaluate(() => window.livePresenceHarness?.close()).catch(() => undefined);
    await browser.close().catch(() => undefined);
    await ownerContext.close().catch(() => undefined);
    await viewerContext.close().catch(() => undefined);
    await stopServer().catch(() => undefined);
    rmSync(bundle, { force: true });
    rmSync(databaseDirectory, { recursive: true, force: true });
  };
  const restartServer = async (): Promise<void> => {
    await stopServer();
    await startServer();
  };
  return { browser, ownerContext, viewerContext, ownerPage, viewerPage, close, restartServer };
}

async function startPair(harness: Harness): Promise<void> {
  const ownerStart = harness.ownerPage.evaluate(() => window.livePresenceHarness?.start());
  const authDeadline = Date.now() + 10_000;
  while (Date.now() < authDeadline) {
    if ((await snapshot(harness.ownerPage)).authenticated) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok((await snapshot(harness.ownerPage)).authenticated, "owner socket did not authenticate");
  await Promise.all([
    ownerStart,
    harness.viewerPage.evaluate(() => window.livePresenceHarness?.start()),
  ]);
}

type Snapshot = Awaited<ReturnType<NonNullable<Window["livePresenceHarness"]>["snapshot"]>>;

async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(async () => {
    const value = await window.livePresenceHarness?.snapshot();
    if (!value) throw new Error("harness is unavailable");
    return value;
  });
}

async function waitForConnected(page: Page): Promise<Snapshot> {
  const deadline = Date.now() + 30_000;
  let latest = await snapshot(page);
  while (Date.now() < deadline) {
    if (latest.lifecycle === "CONNECTED") return latest;
    await new Promise((resolve) => setTimeout(resolve, 250));
    latest = await snapshot(page);
  }
  throw new Error(`browser peer did not connect (state: ${latest.lifecycle}; ${latest.error ?? "no diagnostic"})`);
}

async function waitForAuthenticated(page: Page, count: number): Promise<Snapshot> {
  const deadline = Date.now() + 30_000;
  let latest = await snapshot(page);
  while (Date.now() < deadline) {
    if (latest.authenticatedSockets >= count) return latest;
    await new Promise((resolve) => setTimeout(resolve, 250));
    latest = await snapshot(page);
  }
  throw new Error(
    `browser socket did not authenticate ${count} times (observed ${latest.authenticatedSockets}; lifecycle=${latest.lifecycle}; ${latest.error ?? "no diagnostic"})`,
  );
}

async function waitForRenderedMedia(page: Page): Promise<Snapshot> {
  const deadline = Date.now() + 10_000;
  let latest = await snapshot(page);
  while (Date.now() < deadline) {
    if (latest.renderedFrames > 0) return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
    latest = await snapshot(page);
  }
  throw new Error("viewer did not render a remote media frame");
}

async function waitForPair(harness: Harness, timeoutMs = 30_000): Promise<[Snapshot, Snapshot]> {
  const deadline = Date.now() + timeoutMs;
  let owner = await snapshot(harness.ownerPage);
  let viewer = await snapshot(harness.viewerPage);
  while (Date.now() < deadline) {
    if (owner.lifecycle === "CONNECTED" && viewer.lifecycle === "CONNECTED") {
      return [owner, viewer];
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    owner = await snapshot(harness.ownerPage);
    viewer = await snapshot(harness.viewerPage);
  }
  throw new Error(
    `browser pair did not connect (owner: ${owner.lifecycle}, auth=${owner.authenticatedSockets}, session=${owner.sessionId ?? "none"}, ${owner.error ?? "no diagnostic"}; viewer: ${viewer.lifecycle}, auth=${viewer.authenticatedSockets}, session=${viewer.sessionId ?? "none"}, ${viewer.error ?? "no diagnostic"})`,
  );
}

async function waitForTerminalPair(harness: Harness): Promise<{ snapshots: [Snapshot, Snapshot]; timedOut: boolean }> {
  const deadline = Date.now() + 35_000;
  let owner = await snapshot(harness.ownerPage);
  let viewer = await snapshot(harness.viewerPage);
  while (Date.now() < deadline) {
    const ownerTerminal = owner.lifecycle === "FAILED" || owner.lifecycle === "CLOSED";
    const viewerTerminal = viewer.lifecycle === "FAILED" || viewer.lifecycle === "CLOSED";
    if (ownerTerminal && viewerTerminal) return { snapshots: [owner, viewer], timedOut: false };
    await new Promise((resolve) => setTimeout(resolve, 250));
    owner = await snapshot(harness.ownerPage);
    viewer = await snapshot(harness.viewerPage);
  }
  return { snapshots: [owner, viewer], timedOut: true };
}

test("Phase 4 direct-preferred Chromium WebRTC negotiation", { skip: (mode !== "all" && mode !== "direct") || missingSetup }, async (t) => {
  const harness = await createHarness("all");
  t.after(() => harness.close());
  await startPair(harness);
  const [owner] = await waitForPair(harness);
  const viewer = await waitForRenderedMedia(harness.viewerPage);
  assert.equal(owner.lifecycle, "CONNECTED");
  assert.equal(viewer.lifecycle, "CONNECTED");
  assert.deepEqual(viewer.transceivers, ["0:recvonly:recvonly", "1:recvonly:recvonly"]);
  assert.ok(viewer.receivedTracks > 0, "viewer did not receive a remote media track");
  assert.ok(viewer.renderedFrames > 0, "viewer did not render a remote media frame");
  assert.ok(viewer.stats?.dtlsState === "connected", "DTLS transport did not connect");
  assert.ok(viewer.stats?.candidateType === "direct" || viewer.stats?.candidateType === "relay");
  if (viewer.stats?.candidateType === "direct") {
    assert.notEqual(viewer.stats.localCandidateType, "relay");
    assert.notEqual(viewer.stats.remoteCandidateType, "relay");
  }
});

test("Phase 4 forced-relay Chromium WebRTC negotiation", { skip: (mode !== "all" && mode !== "relay") || missingSetup }, async (t) => {
  const harness = await createHarness("relay");
  t.after(() => harness.close());
  await startPair(harness);
  const viewer = await waitForConnected(harness.viewerPage);
  assert.equal(viewer.lifecycle, "CONNECTED");
  assert.ok(viewer.receivedTracks > 0, "viewer did not receive relay media");
  assert.ok(viewer.renderedFrames > 0, "viewer did not render relay media");
  assert.equal(viewer.stats?.candidateType, "relay", "selected candidate pair was not relayed");
  assert.equal(viewer.stats?.localCandidateType, "relay");
  assert.equal(viewer.stats?.remoteCandidateType, "relay");
  assert.equal(viewer.stats?.dtlsState, "connected");
});

test("Phase 4 all-policy fallback selects Cloudflare relay when direct candidates are unavailable", { skip: (mode !== "all" && mode !== "fallback") || missingSetup }, async (t) => {
  const harness = await createHarness("all", undefined, 1_000, true);
  t.after(() => harness.close());
  await startPair(harness);
  const [owner, viewer] = await waitForPair(harness);
  const media = await waitForRenderedMedia(harness.viewerPage);

  assert.equal(owner.lifecycle, "CONNECTED");
  assert.equal(viewer.lifecycle, "CONNECTED");
  assert.equal(owner.sessionId, viewer.sessionId);
  assert.equal(owner.peerConnectionsCreated, 1, "owner created duplicate peer connections");
  assert.equal(viewer.peerConnectionsCreated, 1, "viewer created duplicate peer connections");
  assert.ok(owner.gatheredCandidateTypes.includes("relay"));
  assert.ok(viewer.gatheredCandidateTypes.includes("relay"));
  assert.equal(viewer.stats?.candidateType, "relay");
  assert.equal(viewer.stats?.localCandidateType, "relay");
  assert.equal(viewer.stats?.remoteCandidateType, "relay");
  assert.equal(viewer.stats?.dtlsState, "connected");
  assert.ok(media.renderedFrames > 0, "viewer did not render media over the selected relay");

  await harness.viewerPage.evaluate(() => window.livePresenceHarness?.close());
  await new Promise((resolve) => setTimeout(resolve, 500));
  const ownerAfterCleanup = await snapshot(harness.ownerPage);
  assert.equal(ownerAfterCleanup.peerConnectionState, "closed");
  assert.equal(ownerAfterCleanup.openSockets, 1);
});

test("Phase 4 explicit cleanup closes peers and prevents recovery", { skip: mode !== "all" || missingSetup }, async (t) => {
  const harness = await createHarness("all");
  t.after(() => harness.close());
  await startPair(harness);
  await waitForConnected(harness.ownerPage);
  await waitForConnected(harness.viewerPage);
  await harness.viewerPage.evaluate(() => window.livePresenceHarness?.close());
  await new Promise((resolve) => setTimeout(resolve, 500));
  const viewer = await snapshot(harness.viewerPage).catch(() => null);
  assert.ok(viewer === null || viewer.lifecycle === "CLOSED");
  if (viewer) assert.equal(viewer.openSockets, 0);
  const owner = await snapshot(harness.ownerPage);
  assert.ok(owner.lifecycle === "CLOSED" || owner.lifecycle === "FAILED");
  assert.equal(owner.peerConnectionState, "closed");
  assert.equal(owner.openSockets, 1, "owner control-plane socket should remain online after viewer leave");
});

test("Phase 4 controlled viewer signaling reconnect reauthenticates and recreates authorization", { skip: mode !== "all" || missingSetup }, async (t) => {
  const harness = await createHarness("all");
  t.after(() => harness.close());
  await startPair(harness);
  await waitForConnected(harness.ownerPage);
  await waitForConnected(harness.viewerPage);
  await harness.viewerPage.evaluate(() => window.livePresenceHarness?.forceSocketClose());
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const viewer = await snapshot(harness.viewerPage);
  assert.ok(viewer.authenticatedSockets >= 2, "viewer did not authenticate a fresh socket");
  assert.equal(viewer.lifecycle, "CONNECTED");
});

test("Phase 4 server restart invalidates the old session and recreates an authorized session", { skip: (mode !== "all" && mode !== "restart") || missingSetup }, async (t) => {
  const harness = await createHarness("all", undefined, 10_000);
  t.after(() => harness.close());
  await startPair(harness);
  const [beforeOwner, beforeViewer] = await waitForPair(harness);
  const oldSessionId = beforeOwner.sessionId;
  assert.ok(oldSessionId);

  await harness.ownerPage.evaluate(() => window.livePresenceHarness?.forceSocketClose());
  await harness.viewerPage.evaluate(() => window.livePresenceHarness?.forceSocketClose());
  await new Promise((resolve) => setTimeout(resolve, 250));
  await harness.restartServer();
  await harness.ownerPage.evaluate(() => window.livePresenceHarness?.forceReconnect());
  await waitForAuthenticated(harness.ownerPage, 2);
  await harness.viewerPage.evaluate(() => window.livePresenceHarness?.forceReconnect());
  const [afterOwner, afterViewer] = await waitForPair(harness);

  assert.notEqual(afterOwner.sessionId, oldSessionId, "server restart reused the old session ID");
  assert.equal(afterViewer.sessionId, afterOwner.sessionId);
  assert.ok(afterOwner.authenticatedSockets >= 2, "owner did not authenticate after restart");
  assert.ok(afterViewer.authenticatedSockets >= 2, "viewer did not authenticate after restart");
  assert.equal(afterOwner.syntheticTracksAttached, 1, "restart resumed media attachment automatically");
  assert.equal(afterOwner.lifecycle, "CONNECTED");
  assert.equal(afterViewer.lifecycle, "CONNECTED");
  await harness.ownerPage.evaluate(() => window.livePresenceHarness?.close());
  await harness.viewerPage.evaluate(() => window.livePresenceHarness?.close());
});

test("Phase 4 forced relay failure reaches a bounded terminal state without direct fallback", { skip: mode !== "all" && mode !== "failure" || missingSetup }, async (t) => {
  const invalidRelay: IceServersOverride = [{
    urls: [
      "turn:127.0.0.1:9?transport=udp",
      "turns:127.0.0.1:9?transport=tcp",
    ],
    username: "invalid-test-user",
    credential: "invalid-test-credential",
  }];
  const harness = await createHarness("relay", invalidRelay);
  t.after(() => harness.close());
  await startPair(harness);
  const failure = await waitForTerminalPair(harness);
  const [owner, viewer] = failure.snapshots;

  assert.notEqual(owner.lifecycle, "CONNECTED");
  assert.notEqual(viewer.lifecycle, "CONNECTED");
  assert.ok(!owner.gatheredCandidateTypes.includes("host"));
  assert.ok(!owner.gatheredCandidateTypes.includes("srflx"));
  assert.ok(!viewer.gatheredCandidateTypes.includes("host"));
  assert.ok(!viewer.gatheredCandidateTypes.includes("srflx"));
  assert.equal(failure.timedOut, false, "production initial ICE timeout did not reach a terminal state");
  assert.ok(owner.lifecycle === "FAILED" || viewer.lifecycle === "FAILED", "no terminal failure was surfaced");
  assert.equal(owner.peerConnectionState, "closed");
  assert.equal(viewer.peerConnectionState, "closed");
  assert.equal(owner.sessionId, null);
  assert.equal(viewer.sessionId, null);
});
