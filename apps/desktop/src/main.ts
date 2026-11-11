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
import { parseClientMessage } from "../../../shared/src/protocol.js";
import { mimeType, resolveAssetPath } from "./main/app-protocol.js";
import { SafeStorageCredentialStore } from "./main/credential-store.js";
import { DisplayCapturePicker } from "./main/display-capture.js";
import { MainSignalingTransport } from "./main/signaling-transport.js";
import type { AppEvent, SocketEvent } from "./ipc-contract.js";

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false } },
]);

const API_URL = process.env.LIVE_PRESENCE_SERVER_URL ?? "http://127.0.0.1:3000";
const WEB_ORIGIN = process.env.LIVE_PRESENCE_WEB_ORIGIN ?? "http://localhost:5173";
const HEARTBEAT_INTERVAL_MS = 1_000;
const HEARTBEAT_EXPIRY_MS = 4_000;
const CLEANUP_ACK_MS = 2_000;

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

const credentials = new SafeStorageCredentialStore(app.getPath("userData"));
const picker = new DisplayCapturePicker();
let transport: MainSignalingTransport | undefined;

function emitAppEvent(event: AppEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("app:event", event);
  if (indicatorWindow && !indicatorWindow.isDestroyed()) indicatorWindow.webContents.send("app:event", event);
}

function emitSocketEvent(event: SocketEvent): void {
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
  await window.loadURL("app://bundle/indicator");
  indicatorReady = true;
  window.hide();
  emitAppEvent({ type: "indicator-ready", ready: true });
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
  cameraIntent = false;
  app.exit(1);
}

async function stopSharing(reason: string, quitAfter = false): Promise<void> {
  if (stopping) {
    if (quitAfter) quittingAfterCleanup = true;
    return;
  }
  stopping = true;
  quittingAfterCleanup ||= quitAfter;
  const needsRendererCleanup = shareActive || capturePending;
  capturePending = false;
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
  ipcMain.handle("signaling:connect", async (event) => {
    if (!mainSender(event)) throw new Error("invalid IPC sender");
    transport ??= new MainSignalingTransport(
      validateApiUrl(API_URL),
      validateWebOrigin(WEB_ORIGIN),
      credentials,
      emitSocketEvent,
    );
    await transport.connect();
  });
  ipcMain.handle("signaling:send", (event, raw: unknown) => {
    if (!mainSender(event) || typeof raw !== "string" || raw.length > 128 * 1024) {
      console.warn(JSON.stringify({
        source: "desktop-main",
        event: "signaling-ipc-rejected",
        deviceId: transport?.deviceId,
        signalingState: transport?.deviceId ? "open" : "not-connected",
        sent: false,
        category: "ipc-validation",
        originalError: "invalid IPC sender or payload",
      }));
      throw new Error("invalid signaling IPC request");
    }
    try {
      const parsed = parseClientMessage(JSON.parse(raw));
      if (!parsed || parsed.type === "auth" || parsed.type === "share_request" ||
        parsed.type === "share_request_cancel" || parsed.type === "share_request_decision" ||
        parsed.type === "create_session" || parsed.type === "answer") {
        throw new Error("signaling message is invalid or not allowed");
      }
      if (!transport) throw new Error("owner signaling transport is unavailable");
      transport?.send(JSON.stringify(parsed));
      return;
    } catch (error) {
      console.warn(JSON.stringify({
        source: "desktop-main",
        event: "signaling-ipc-rejected",
        deviceId: transport?.deviceId,
        signalingState: transport?.deviceId ? "open" : "not-connected",
        sharingState: (() => {
          try {
            const parsed = parseClientMessage(JSON.parse(raw));
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
      throw error;
    }
  });
  ipcMain.on("signaling:close", (event) => {
    if (!mainSender(event)) return;
    transport?.close();
    transport = undefined;
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
  ipcMain.on("capture:screen-pending", (event) => {
    if (!mainSender(event) || !indicatorReady || shareActive || capturePending) {
      emitAppEvent({ type: "stop-sharing", reason: "indicator-not-ready" });
      return;
    }
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
      shareActive = false;
      capturePending = false;
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
  ipcMain.on("system:sleep-marker-result", (event, accepted: unknown) => {
    if (mainSender(event) && typeof accepted === "boolean") sleepMarkerAcknowledged = accepted;
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

async function createMainWindow(): Promise<void> {
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
  await window.loadURL("app://bundle/");
  window.show();
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
  await installAppProtocol();
  installIpcHandlers();
  picker.install();
  installPermissions();
  await createMainWindow();
  await createIndicator();

  setInterval(() => {
    if (!systemSuspended && (shareActive || capturePending) &&
      Date.now() - lastHeartbeat >= HEARTBEAT_EXPIRY_MS) {
      void stopSharing("renderer-heartbeat-timeout", true);
    }
  }, HEARTBEAT_INTERVAL_MS).unref();

  powerMonitor.on("suspend", () => {
    systemSuspended = true;
    sleepMarkerAcknowledged = false;
    emitAppEvent({ type: "suspend" });
  });
  powerMonitor.on("resume", () => {
    lastHeartbeat = Date.now();
    systemSuspended = false;
    if (shareActive && !sleepMarkerAcknowledged) {
      void stopSharing("sleep-continuity-unavailable");
      return;
    }
    if (capturePending && !shareActive) {
      void stopSharing("capture-interrupted-by-sleep");
      return;
    }
    emitAppEvent({ type: "resume" });
    sleepMarkerAcknowledged = false;
  });
  app.on("activate", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      void createMainWindow().then(async () => {
        if (!indicatorWindow || indicatorWindow.isDestroyed()) await createIndicator();
      });
    }
  });
}).catch((error: unknown) => {
  console.error("Desktop startup failed", error);
  app.exit(1);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
