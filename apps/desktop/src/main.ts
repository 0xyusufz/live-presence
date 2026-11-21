import {
  app,
  BrowserWindow,
  ipcMain,
  net,
  Notification,
  protocol,
  session,
  powerMonitor,
} from "electron";
import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { parseClientMessage, parseServerMessage } from "../../../shared/src/protocol.js";
import { mimeType, resolveAssetPath } from "./main/app-protocol.js";
import { SafeStorageCredentialStore } from "./main/credential-store.js";
import { CaptureDiagnostics, isCaptureAttemptId } from "./main/capture-diagnostics.js";
import { DisplayCapturePicker } from "./main/display-capture.js";
import { MainSignalingTransport } from "./main/signaling-transport.js";
import { SignalingPeerGeneration } from "./main/signaling-peer-generation.js";
import { registerSignalingIpcHandlers } from "./main/signaling-ipc-handlers.js";
import { createSignalingConnectHandler } from "./main/signaling-connect-handler.js";
import { WindowRestorer } from "./main/window-restoration.js";
import {
  canAcceptRecoveryStart,
  canAcceptRecoveryTerminal,
  isValidRecoveryAttemptId,
} from "./main/sleep-recovery-state.js";
import type { AppEvent, SocketEvent } from "./ipc-contract.js";

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false } },
]);

const API_URL = process.env.LIVE_PRESENCE_SERVER_URL ?? "http://127.0.0.1:3000";
const WEB_ORIGIN = process.env.LIVE_PRESENCE_WEB_ORIGIN ?? "http://localhost:5173";
const HEARTBEAT_INTERVAL_MS = 1_000;
const HEARTBEAT_EXPIRY_MS = 4_000;
const CLEANUP_ACK_MS = 2_000;
const SLEEP_RECOVERY_DECISION_MS = 10_000;

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

let mainWindow: BrowserWindow | undefined;
let indicatorWindow: BrowserWindow | undefined;
let indicatorReady = false;
let shareActive = false;
let capturePending = false;
let cameraIntent = false;
let lastHeartbeat = 0;
let cleanupWaiter: (() => void) | undefined;
let cleanupTimer: NodeJS.Timeout | undefined;
let stopping = false;
let quittingAfterCleanup = false;
let sleepMarkerAcknowledged = false;
let systemSuspended = false;
let sleepRecoveryCycleId = 0;
let sleepRecoveryTimer: NodeJS.Timeout | undefined;
let sleepRecoveryState: "idle" | "started" | "completed" | "failed" | "timed_out" = "idle";
let sleepRecoveryAttemptId: string | undefined;
let activeCaptureAttemptId: string | undefined;
let indicatorCreation: Promise<void> | undefined;

const credentials = new SafeStorageCredentialStore(app.getPath("userData"));
const captureDiagnostics = new CaptureDiagnostics(() => join(app.getPath("userData"), "screen-capture.log"));
const picker = new DisplayCapturePicker(undefined, (level, event, details) => {
  captureDiagnostics.log(event, { level, ...details });
}, () => activeCaptureAttemptId);
let transport: MainSignalingTransport | undefined;
const signalingPeerGeneration = new SignalingPeerGeneration();
const hasSingleInstanceLock = app.requestSingleInstanceLock();
const mainWindowRestorer = new WindowRestorer(() => mainWindow, createMainWindow);
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", restoreApplicationWindow);
}

function emitAppEvent(event: AppEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("app:event", event);
  if (indicatorWindow && !indicatorWindow.isDestroyed()) indicatorWindow.webContents.send("app:event", event);
}

function emitSocketEvent(event: SocketEvent): void {
  if (event.type === "message") {
    const message = parseServerMessage(JSON.parse(event.data));
    if (
      message?.type === "viewer_rejoined" ||
      (message?.type === "viewer_left" && message.reason !== "temporary_disconnect")
    ) {
      signalingPeerGeneration.invalidate();
    }
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("signaling:event", event);
}

function appFrame(sender: Electron.WebContents, frame: Electron.WebFrameMain | null): boolean {
  try {
    if (!frame || frame !== sender.mainFrame) return false;
    const url = new URL(frame.url);
    return url.protocol === "app:" && url.hostname === "bundle";
  } catch {
    return false;
  }
}

function mainSender(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  return Boolean(mainWindow && event.sender === mainWindow.webContents && appFrame(event.sender, event.senderFrame));
}

function pickerSender(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  return Boolean(picker.isPickerContents(event.sender) && appFrame(event.sender, event.senderFrame));
}

function csp(): string {
  const devServer = typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === "undefined"
    ? ""
    : MAIN_WINDOW_VITE_DEV_SERVER_URL;
  const hmr = !devServer
    ? ""
    : " http://127.0.0.1:5174 ws://127.0.0.1:5174";
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "media-src 'self' blob:",
    `connect-src 'self'${hmr}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

async function installAppProtocol(): Promise<void> {
  const devServer = typeof MAIN_WINDOW_VITE_DEV_SERVER_URL === "undefined"
    ? ""
    : MAIN_WINDOW_VITE_DEV_SERVER_URL;
  const rendererName = typeof MAIN_WINDOW_VITE_NAME === "undefined"
    ? "main_window"
    : MAIN_WINDOW_VITE_NAME;
  const rendererRoot = devServer
    ? undefined
    : join(app.getAppPath(), ".vite", "renderer", rendererName);
  await protocol.handle("app", async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== "bundle") return new Response("Not found", { status: 404 });
    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    if (devServer) {
      const target = new URL(pathname + url.search, devServer);
      const response = await net.fetch(target.toString());
      const headers = new Headers(response.headers);
      if (pathname === "/" || pathname.endsWith(".html") || extname(pathname) === "") {
        headers.set("content-security-policy", csp());
      }
      return new Response(response.body, { status: response.status, headers });
    }

    let path = resolveAssetPath(rendererRoot!, pathname);
    if (path && extname(path) === "") path = join(rendererRoot!, "index.html");
    if (!path) return new Response("Bad path", { status: 400 });
    try {
      const info = await stat(path);
      if (!info.isFile()) return new Response("Not found", { status: 404 });
      const body = new Uint8Array(await readFile(path));
      const headers = new Headers({ "content-type": mimeType(path) });
      if (path.endsWith(".html")) headers.set("content-security-policy", csp());
      return new Response(body, { status: 200, headers });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

function windowOptions(width: number, height: number): Electron.BrowserWindowConstructorOptions {
  return {
    width,
    height,
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  };
}

async function createIndicator(): Promise<void> {
  const window = new BrowserWindow({
    ...windowOptions(280, 100),
    width: 280,
    height: 100,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    title: "Live Presence sharing indicator",
  });
  indicatorWindow = window;
  window.on("closed", () => {
    if (indicatorWindow !== window) return;
    indicatorWindow = undefined;
    indicatorReady = false;
    emitAppEvent({ type: "indicator-ready", ready: false });
    if (shareActive || capturePending) void stopSharing("indicator-closed", true);
  });
  window.webContents.on("render-process-gone", () => {
    if (shareActive || capturePending) void stopSharing("indicator-crashed", true);
  });
  try {
    await window.loadURL("app://bundle/indicator");
  } catch (error) {
    if (indicatorWindow === window) {
      indicatorWindow = undefined;
      indicatorReady = false;
    }
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }
  indicatorReady = true;
  window.hide();
  emitAppEvent({ type: "indicator-ready", ready: true });
}

async function ensureIndicator(): Promise<void> {
  if (indicatorCreation) return indicatorCreation;
  if (indicatorWindow && !indicatorWindow.isDestroyed() && indicatorReady) return;

  const creation = createIndicator();
  indicatorCreation = creation;
  try {
    await creation;
  } finally {
    if (indicatorCreation === creation) indicatorCreation = undefined;
  }
}

function restoreApplicationWindow(): void {
  void mainWindowRestorer.restore()
    .then(ensureIndicator)
    .catch(() => console.error("Could not restore the application window."));
}

function showIndicator(): boolean {
  const window = indicatorWindow;
  if (!indicatorReady || !window || window.isDestroyed()) return false;
  try {
    window.show();
    window.setAlwaysOnTop(true, "screen-saver");
    return window.isVisible();
  } catch {
    return false;
  }
}

function hideIndicator(): void {
  if (indicatorWindow && !indicatorWindow.isDestroyed()) indicatorWindow.hide();
  emitAppEvent({ type: "indicator-state", screen: false, camera: false });
}

function forceRendererTermination(): void {
  signalingPeerGeneration.invalidate();
  transport?.close();
  transport = undefined;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.forcefullyCrashRenderer();
    mainWindow.destroy();
  }
  if (indicatorWindow && !indicatorWindow.isDestroyed()) indicatorWindow.destroy();
  indicatorWindow = undefined;
  shareActive = false;
  capturePending = false;
  activeCaptureAttemptId = undefined;
  cameraIntent = false;
  app.exit(1);
}

async function stopSharing(reason: string, quitAfter = false): Promise<void> {
  if (stopping) {
    if (quitAfter) quittingAfterCleanup = true;
    return;
  }
  stopping = true;
  sleepRecoveryCycleId += 1;
  if (sleepRecoveryTimer) clearTimeout(sleepRecoveryTimer);
  sleepRecoveryTimer = undefined;
  sleepRecoveryState = "idle";
  sleepRecoveryAttemptId = undefined;
  signalingPeerGeneration.invalidate();
  quittingAfterCleanup ||= quitAfter;
  const needsRendererCleanup = shareActive || capturePending;
  capturePending = false;
  activeCaptureAttemptId = undefined;
  cameraIntent = false;
  picker.cancel();
  if (!needsRendererCleanup && !quittingAfterCleanup) {
    hideIndicator();
    stopping = false;
    return;
  }
  let acknowledged = false;
  const ack = new Promise<void>((resolve) => {
    cleanupWaiter = () => {
      acknowledged = true;
      resolve();
    };
    cleanupTimer = setTimeout(resolve, CLEANUP_ACK_MS);
  });
  emitAppEvent({ type: "stop-sharing", reason });
  await ack;
  if (cleanupTimer) clearTimeout(cleanupTimer);
  cleanupTimer = undefined;
  cleanupWaiter = undefined;
  shareActive = false;
  cameraIntent = false;
  hideIndicator();
  if (!acknowledged) {
    forceRendererTermination();
    return;
  }
  stopping = false;
  if (quittingAfterCleanup) {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    app.quit();
  }
}

function startWatchdog(): void {
  lastHeartbeat = Date.now();
}

function validateApiUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("LIVE_PRESENCE_SERVER_URL must be an HTTP(S) origin");
  }
  return url.origin;
}

function validateWebOrigin(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("LIVE_PRESENCE_WEB_ORIGIN must be an HTTP(S) origin");
  }
  return url.origin;
}

function installIpcHandlers(): void {
  ipcMain.on("capture:diagnostic", (event, name: unknown, details: unknown) => {
    if (!mainSender(event) || typeof name !== "string" || name.length > 100 ||
      name === "owner_signaling_transport" ||
      typeof details !== "object" || details === null || Array.isArray(details)) return;
    captureDiagnostics.log(name, details);
  });
  ipcMain.handle("credential:exists", async (event) => {
    if (!mainSender(event)) throw new Error("invalid IPC sender");
    return credentials.has();
  });
  ipcMain.handle("capture:indicator-ready", (event) => {
    if (!mainSender(event)) throw new Error("invalid IPC sender");
    return indicatorReady;
  });
  ipcMain.handle("credential:save", async (event, value: unknown) => {
    if (!mainSender(event) || typeof value !== "string") throw new Error("invalid IPC request");
    await credentials.save(value);
  });
  ipcMain.handle("config:server-url", (event) => {
    if (!mainSender(event)) throw new Error("invalid IPC sender");
    return validateApiUrl(API_URL);
  });
  ipcMain.handle("signaling:connect", createSignalingConnectHandler({
    isSenderAllowed: mainSender,
    getTransport: () => transport,
    setTransport: (value) => { transport = value; },
    createTransport: () => {
      const instance = new MainSignalingTransport(
        validateApiUrl(API_URL),
        validateWebOrigin(WEB_ORIGIN),
        credentials,
        emitSocketEvent,
      );
      instance.setDiagnosticLogger((level, entry) => {
        captureDiagnostics.log("owner_signaling_transport", {
          ...entry,
          transportEvent: entry.event,
          level,
        });
      });
      return instance;
    },
    isAuthenticatedReuse: (instance) => instance.hasAuthenticatedOpenSocket,
    connect: (instance) => instance.connect(),
    log: (diagnostic) => {
      captureDiagnostics.log("owner_signaling_transport", {
        transportEvent: diagnostic.event,
        correlationId: diagnostic.correlationId ?? undefined,
        level: diagnostic.level,
        connectErrorName: diagnostic.connectErrorName,
        connectErrorCategory: diagnostic.connectErrorCategory,
        connectErrorMessage: diagnostic.connectErrorMessage,
      });
    },
  }));
  registerSignalingIpcHandlers({
    handle: (channel, handler) => {
      ipcMain.handle(channel, (event, ...args) => handler(event, ...args));
    },
    on: (channel, listener) => {
      ipcMain.on(channel, (event, ...args) => listener(event, ...args));
    },
  }, {
    isSenderAllowed: (event) =>
      mainSender(event as Electron.IpcMainEvent | Electron.IpcMainInvokeEvent),
    getTransport: () => transport,
    isSharingActive: () => shareActive,
    isStopping: () => stopping,
    peerGeneration: signalingPeerGeneration,
    onSendRejected: (raw, error) => {
      console.warn(JSON.stringify({
        source: "desktop-main",
        event: "signaling-ipc-rejected",
        deviceId: transport?.deviceId,
        signalingState: transport?.deviceId ? "open" : "not-connected",
        sharingState: (() => {
          try {
            const parsed = typeof raw === "string" ? parseClientMessage(JSON.parse(raw)) : undefined;
            return parsed?.type === "sharing_state"
              ? { screen: parsed.screen, camera: parsed.camera }
              : undefined;
          } catch {
            return undefined;
          }
        })(),
        sent: false,
        category: "signaling-send",
        originalError: error instanceof Error ? error.message : "unknown signaling send error",
      }));
    },
    onClose: (connectionGeneration, matchedActiveConnection) => {
      console.info(JSON.stringify({
        source: "desktop-main",
        event: "signaling_close_ipc",
        timestamp: new Date().toISOString(),
        requestedGeneration: connectionGeneration,
        matchedActiveConnection,
      }));
    },
  });
  ipcMain.handle("ice:load", async (event) => {
    if (!mainSender(event)) throw new Error("invalid IPC sender");
    transport ??= new MainSignalingTransport(
      validateApiUrl(API_URL),
      validateWebOrigin(WEB_ORIGIN),
      credentials,
      emitSocketEvent,
    );
    return transport.loadIceServers();
  });
  ipcMain.on("capture:screen-pending", (event, attemptId: unknown) => {
    if (!mainSender(event) || !isCaptureAttemptId(attemptId) ||
      !indicatorReady || shareActive || capturePending) {
      emitAppEvent({ type: "stop-sharing", reason: "indicator-not-ready" });
      return;
    }
    activeCaptureAttemptId = attemptId;
    capturePending = true;
    startWatchdog();
    console.info(JSON.stringify({
      source: "desktop-main",
      event: "screen-capture-pending",
      deviceId: transport?.deviceId,
      lifecycle: "capture-pending",
      signalingState: transport?.deviceId ? "open" : "not-connected",
      sharingState: { screen: false, camera: false },
      sent: false,
    }));
  });
  ipcMain.handle("capture:screen-active", async (event, active: unknown) => {
    if (!mainSender(event) || typeof active !== "boolean") throw new Error("invalid IPC request");
    if (!active) {
      sleepRecoveryCycleId += 1;
      if (sleepRecoveryTimer) clearTimeout(sleepRecoveryTimer);
      sleepRecoveryTimer = undefined;
      sleepRecoveryState = "idle";
      sleepRecoveryAttemptId = undefined;
      signalingPeerGeneration.invalidate();
      shareActive = false;
      capturePending = false;
      activeCaptureAttemptId = undefined;
      cameraIntent = false;
      hideIndicator();
      return;
    }
    if (!capturePending || !showIndicator()) {
      await stopSharing("indicator-display-failed");
      throw new Error("sharing indicator could not be displayed");
    }
    capturePending = false;
    shareActive = true;
    captureDiagnostics.log("screen_capture_activation_confirmed_by_main", {
      attemptId: activeCaptureAttemptId,
      screen: true,
      camera: false,
    });
    console.info(JSON.stringify({
      source: "desktop-main",
      event: "screen-capture-confirmed",
      deviceId: transport?.deviceId,
      lifecycle: "capture-active",
      signalingState: transport?.deviceId ? "open" : "not-connected",
      sharingState: { screen: true, camera: false },
      sent: false,
    }));
    emitAppEvent({ type: "indicator-state", screen: true, camera: false });
  });
  ipcMain.handle("capture:camera-intent", (event, active: unknown) => {
    if (!mainSender(event) || typeof active !== "boolean" || (active && !shareActive)) {
      throw new Error("camera is available only during active screen sharing");
    }
    cameraIntent = active;
  });
  ipcMain.handle("picker:list", (event) => {
    if (!pickerSender(event)) throw new Error("invalid IPC sender");
    return picker.listSources();
  });
  ipcMain.on("picker:select", (event, sourceId: unknown) => {
    if (!pickerSender(event) || typeof sourceId !== "string" || sourceId.length > 256) return;
    void picker.chooseSource(sourceId);
  });
  ipcMain.on("picker:cancel", (event) => {
    if (pickerSender(event)) picker.cancel();
  });
  ipcMain.on("watchdog:heartbeat", (event) => {
    if (mainSender(event)) lastHeartbeat = Date.now();
  });
  ipcMain.on("capture:cleanup-ack", (event) => {
    if (!mainSender(event)) return;
    cleanupWaiter?.();
  });
  ipcMain.on("system:sleep-marker-result", (event, cycleId: unknown, accepted: unknown) => {
    if (mainSender(event) && typeof cycleId === "number" &&
      cycleId === sleepRecoveryCycleId && typeof accepted === "boolean") {
      sleepMarkerAcknowledged = accepted;
    }
  });
  ipcMain.on("system:sleep-recovery-result", (
    event,
    cycleId: unknown,
    recoveryAttemptId: unknown,
    phase: unknown,
  ) => {
    if (!mainSender(event) || typeof cycleId !== "number" ||
      !isValidRecoveryAttemptId(recoveryAttemptId) ||
      !["eligible", "started", "completed", "failed", "timed_out"].includes(String(phase)) ||
      cycleId !== sleepRecoveryCycleId) return;
    if (phase === "eligible") {
      if (!shareActive || sleepRecoveryState !== "started" ||
        !canAcceptRecoveryStart(sleepRecoveryState, sleepRecoveryAttemptId, recoveryAttemptId)) return;
      sleepRecoveryAttemptId = recoveryAttemptId;
      emitAppEvent({
        type: "sleep-recovery-attempt-accepted",
        cycleId,
        recoveryAttemptId,
      });
      return;
    }
    if (phase === "started") {
      if (sleepRecoveryAttemptId !== recoveryAttemptId) return;
      return;
    }
    if (!canAcceptRecoveryTerminal(
      sleepRecoveryState,
      cycleId,
      sleepRecoveryCycleId,
      sleepRecoveryAttemptId,
      recoveryAttemptId,
      phase,
    )) return;
    if (phase === "completed") {
      if (sleepRecoveryTimer) clearTimeout(sleepRecoveryTimer);
      sleepRecoveryTimer = undefined;
      sleepRecoveryState = "completed";
      emitAppEvent({
        type: "sleep-recovery-result",
        cycleId,
        recoveryAttemptId,
        phase: "completed",
        accepted: true,
      });
    } else if (phase === "failed") {
      if (sleepRecoveryTimer) clearTimeout(sleepRecoveryTimer);
      sleepRecoveryTimer = undefined;
      sleepRecoveryState = "failed";
      emitAppEvent({
        type: "sleep-recovery-result",
        cycleId,
        recoveryAttemptId,
        phase: "failed",
        accepted: true,
      });
    } else if (phase === "timed_out") {
      if (sleepRecoveryTimer) clearTimeout(sleepRecoveryTimer);
      sleepRecoveryTimer = undefined;
      sleepRecoveryState = "timed_out";
      sleepRecoveryAttemptId = undefined;
      emitAppEvent({
        type: "sleep-recovery-result",
        cycleId,
        recoveryAttemptId,
        phase: "timed_out",
        accepted: true,
      });
    }
  });
  ipcMain.on("indicator:stop", (event) => {
    if (indicatorWindow && event.sender === indicatorWindow.webContents) void stopSharing("indicator-stop");
  });
  ipcMain.on("notification:sharing-resumed", (event) => {
    if (!mainSender(event) || !Notification.isSupported()) return;
    new Notification({ title: "Connected", body: "Sharing resumed" }).show();
  });
}

function installPermissions(): void {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const valid = webContents === mainWindow?.webContents &&
      appFrame(webContents, webContents.mainFrame);
    if (permission === "display-capture") {
      callback(valid);
      return;
    }
    if (permission !== "media" || !valid) {
      callback(false);
      return;
    }
    const videoRequested = "mediaTypes" in details && details.mediaTypes?.includes("video") === true;
    callback(videoRequested && cameraIntent && shareActive);
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, _origin, details) => {
    if (!webContents || webContents !== mainWindow?.webContents ||
      !appFrame(webContents, webContents.mainFrame)) return false;
    if (permission === "display-capture") return true;
    return permission === "media" && cameraIntent && shareActive &&
      details?.mediaType === "video";
  });
}

async function createMainWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    ...windowOptions(920, 680),
    minWidth: 620,
    minHeight: 480,
    title: "Live Presence",
  });
  mainWindow = window;
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("app://bundle/")) event.preventDefault();
  });
  window.webContents.on("render-process-gone", () => {
    if (shareActive || capturePending) void stopSharing("renderer-crashed", true);
    else {
      transport?.close();
      transport = undefined;
    }
  });
  window.webContents.on("unresponsive", () => {
    if (shareActive || capturePending) void stopSharing("renderer-unresponsive", true);
  });
  window.on("close", (event) => {
    if (shareActive || capturePending) {
      event.preventDefault();
      void stopSharing("main-window-closed", true);
    }
  });
  window.on("closed", () => {
    if (mainWindow !== window) return;
    mainWindow = undefined;
    if (!shareActive && !capturePending) {
      transport?.close();
      transport = undefined;
    }
    if (!shareActive && indicatorWindow && !indicatorWindow.isDestroyed()) indicatorWindow.close();
  });
  try {
    await window.loadURL("app://bundle/");
    return window;
  } catch (error) {
    if (mainWindow === window) mainWindow = undefined;
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }
}

app.on("before-quit", (event) => {
  if (shareActive || capturePending) {
    event.preventDefault();
    void stopSharing("application-shutdown", true);
  } else {
    transport?.close();
    transport = undefined;
  }
});

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  await installAppProtocol();
  installIpcHandlers();
  picker.install();
  installPermissions();
  await mainWindowRestorer.restore();
  await ensureIndicator();

  setInterval(() => {
    if (!systemSuspended && (shareActive || capturePending) &&
      Date.now() - lastHeartbeat >= HEARTBEAT_EXPIRY_MS) {
      void stopSharing("renderer-heartbeat-timeout", true);
    }
  }, HEARTBEAT_INTERVAL_MS).unref();

  powerMonitor.on("suspend", () => {
    systemSuspended = true;
    if (!shareActive && !capturePending) return;
    sleepMarkerAcknowledged = false;
    sleepRecoveryCycleId += 1;
    if (sleepRecoveryTimer) clearTimeout(sleepRecoveryTimer);
    sleepRecoveryTimer = undefined;
    sleepRecoveryState = "idle";
    sleepRecoveryAttemptId = undefined;
    emitAppEvent({ type: "suspend", cycleId: sleepRecoveryCycleId });
  });
  powerMonitor.on("resume", () => {
    lastHeartbeat = Date.now();
    systemSuspended = false;
    if (capturePending && !shareActive) {
      void stopSharing("capture-interrupted-by-sleep");
      return;
    }
    if (shareActive) {
      if (sleepRecoveryState !== "idle") return;
      sleepRecoveryState = "started";
      if (sleepRecoveryTimer) clearTimeout(sleepRecoveryTimer);
      sleepRecoveryTimer = setTimeout(() => {
        sleepRecoveryTimer = undefined;
        if (!shareActive || sleepRecoveryState !== "started") return;
        sleepRecoveryState = "timed_out";
        sleepRecoveryAttemptId = undefined;
        emitAppEvent({ type: "sleep-recovery-timeout", cycleId: sleepRecoveryCycleId });
      }, SLEEP_RECOVERY_DECISION_MS);
    }
    if (shareActive) emitAppEvent({ type: "resume", cycleId: sleepRecoveryCycleId });
    sleepMarkerAcknowledged = false;
  });
  app.on("activate", () => {
    if (!hasSingleInstanceLock) return;
    restoreApplicationWindow();
  });
}).catch((error: unknown) => {
  console.error("Desktop startup failed", error);
  app.exit(1);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
