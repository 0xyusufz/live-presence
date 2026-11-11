import type { WebRtcConfiguration } from "../../../shared/src/webrtc.js";

export type SocketEvent =
  | { type: "open"; connectionGeneration?: number }
  | { type: "message"; data: string }
  | { type: "close"; code?: number; connectionGeneration?: number }
  | { type: "error"; message: string };

export type AppEvent =
  | { type: "stop-sharing"; reason: string }
  | { type: "suspend" }
  | { type: "resume" }
  | { type: "indicator-ready"; ready: boolean }
  | { type: "indicator-state"; screen: boolean; camera: boolean };

export type LivePresenceBridge = {
  hasCredential(): Promise<boolean>;
  indicatorReady(): Promise<boolean>;
  saveCredential(value: string): Promise<void>;
  getServerUrl(): Promise<string>;
  connectSignaling(): Promise<void>;
  sendSignaling(value: string): Promise<void>;
  closeSignaling(): void;
  onSocketEvent(callback: (event: SocketEvent) => void): () => void;
  loadIceServers(): Promise<WebRtcConfiguration>;
  beginScreenCapture(): void;
  getPickerSources(): Promise<Array<{ id: string; name: string }>>;
  selectPickerSource(id: string): void;
  cancelPicker(): void;
  setScreenActive(active: boolean): Promise<void>;
  setCameraIntent(active: boolean): Promise<void>;
  reportHeartbeat(): void;
  acknowledgeCleanup(): void;
  reportSleepMarker(accepted: boolean): void;
  notifySharingResumed(): void;
  stopFromIndicator(): void;
  onAppEvent(callback: (event: AppEvent) => void): () => void;
};
