import { contextBridge, ipcRenderer } from "electron";
import type { AppEvent, LivePresenceBridge, SocketEvent } from "./ipc-contract.js";
import type { WebRtcConfiguration } from "../../../shared/src/webrtc.js";

const bridge: LivePresenceBridge = {
  hasCredential: () => ipcRenderer.invoke("credential:exists") as Promise<boolean>,
  indicatorReady: () => ipcRenderer.invoke("capture:indicator-ready") as Promise<boolean>,
  saveCredential: (value) => ipcRenderer.invoke("credential:save", value) as Promise<void>,
  getServerUrl: () => ipcRenderer.invoke("config:server-url") as Promise<string>,
  connectSignaling: () => ipcRenderer.invoke("signaling:connect") as Promise<void>,
  sendSignaling: (value) => ipcRenderer.invoke("signaling:send", value) as Promise<void>,
  closeSignaling: () => ipcRenderer.send("signaling:close"),
  onSocketEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, value: SocketEvent) => callback(value);
    ipcRenderer.on("signaling:event", listener);
    return () => ipcRenderer.removeListener("signaling:event", listener);
  },
  loadIceServers: () => ipcRenderer.invoke("ice:load") as Promise<WebRtcConfiguration>,
  beginScreenCapture: () => ipcRenderer.send("capture:screen-pending"),
  getPickerSources: () => ipcRenderer.invoke("picker:list") as Promise<Array<{ id: string; name: string }>>,
  selectPickerSource: (id) => ipcRenderer.send("picker:select", id),
  cancelPicker: () => ipcRenderer.send("picker:cancel"),
  setScreenActive: (active) => ipcRenderer.invoke("capture:screen-active", active) as Promise<void>,
  setCameraIntent: (active) => ipcRenderer.invoke("capture:camera-intent", active) as Promise<void>,
  reportHeartbeat: () => ipcRenderer.send("watchdog:heartbeat"),
  acknowledgeCleanup: () => ipcRenderer.send("capture:cleanup-ack"),
  reportSleepMarker: (accepted) => ipcRenderer.send("system:sleep-marker-result", accepted),
  notifySharingResumed: () => ipcRenderer.send("notification:sharing-resumed"),
  stopFromIndicator: () => ipcRenderer.send("indicator:stop"),
  onAppEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, value: AppEvent) => callback(value);
    ipcRenderer.on("app:event", listener);
    return () => ipcRenderer.removeListener("app:event", listener);
  },
};

contextBridge.exposeInMainWorld("livePresence", bridge);

declare global {
  interface Window {
    livePresence: LivePresenceBridge;
  }
}
