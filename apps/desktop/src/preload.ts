import { contextBridge, ipcRenderer } from "electron";
import type { AppEvent, LivePresenceBridge, SocketEvent } from "./ipc-contract.js";
import type { WebRtcConfiguration } from "../../../shared/src/webrtc.js";

const bridge: LivePresenceBridge = {
  hasCredential: () => ipcRenderer.invoke("credential:exists") as Promise<boolean>,
  indicatorReady: () => ipcRenderer.invoke("capture:indicator-ready") as Promise<boolean>,
  saveCredential: (value) => ipcRenderer.invoke("credential:save", value) as Promise<void>,
  getServerUrl: () => ipcRenderer.invoke("config:server-url") as Promise<string>,
  connectSignaling: (correlationId) =>
    ipcRenderer.invoke("signaling:connect", correlationId) as Promise<number>,
  sendSignaling: (value, connectionGeneration, peerRegistrationId) =>
    ipcRenderer.invoke("signaling:send", value, connectionGeneration, peerRegistrationId) as Promise<void>,
  registerSignalingPeerGeneration: (sessionId, connectionGeneration) =>
    ipcRenderer.invoke("signaling:peer-generation", sessionId, connectionGeneration) as Promise<string>,
  clearSignalingPeerGeneration: (peerRegistrationId) =>
    ipcRenderer.invoke("signaling:peer-generation:clear", peerRegistrationId) as Promise<void>,
  closeSignaling: (connectionGeneration) => ipcRenderer.send("signaling:close", connectionGeneration),
  onSocketEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, value: SocketEvent) => callback(value);
    ipcRenderer.on("signaling:event", listener);
    return () => ipcRenderer.removeListener("signaling:event", listener);
  },
  loadIceServers: () => ipcRenderer.invoke("ice:load") as Promise<WebRtcConfiguration>,
  beginScreenCapture: (attemptId) => ipcRenderer.send("capture:screen-pending", attemptId),
  getPickerSources: () => ipcRenderer.invoke("picker:list") as Promise<Array<{ id: string; name: string }>>,
  selectPickerSource: (id) => ipcRenderer.send("picker:select", id),
  cancelPicker: () => ipcRenderer.send("picker:cancel"),
  setScreenActive: (active) => ipcRenderer.invoke("capture:screen-active", active) as Promise<void>,
  setCameraIntent: (active) => ipcRenderer.invoke("capture:camera-intent", active) as Promise<void>,
  reportHeartbeat: () => ipcRenderer.send("watchdog:heartbeat"),
  acknowledgeCleanup: () => ipcRenderer.send("capture:cleanup-ack"),
  reportSleepMarker: (cycleId, accepted) =>
    ipcRenderer.send("system:sleep-marker-result", cycleId, accepted),
  reportSleepRecovery: (cycleId, recoveryAttemptId, phase) =>
    ipcRenderer.send("system:sleep-recovery-result", cycleId, recoveryAttemptId, phase),
  notifySharingResumed: () => ipcRenderer.send("notification:sharing-resumed"),
  reportCaptureDiagnostic: (event, details = {}) => ipcRenderer.send("capture:diagnostic", event, details),
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
