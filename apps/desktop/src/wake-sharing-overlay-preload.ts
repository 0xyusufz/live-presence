import { contextBridge, ipcRenderer } from "electron";
import type {
  WakeSharingOverlayBridge,
  WakeSharingOverlayChoice,
} from "./ipc-contract.js";

let choiceCallback: ((choice: WakeSharingOverlayChoice) => void) | undefined;
let pendingChoice: WakeSharingOverlayChoice | undefined;

ipcRenderer.on("wake-sharing-overlay:choice", (_event, choice: WakeSharingOverlayChoice) => {
  if (choiceCallback) choiceCallback(choice);
  else pendingChoice = choice;
});

const bridge: WakeSharingOverlayBridge = {
  reportReady: () => ipcRenderer.send("wake-sharing-overlay:ready"),
  select: (cycleId, option) => ipcRenderer.send("wake-sharing-overlay:select", cycleId, option),
  dismiss: (cycleId) => ipcRenderer.send("wake-sharing-overlay:dismiss", cycleId),
  onChoice: (callback) => {
    choiceCallback = callback;
    if (pendingChoice) {
      callback(pendingChoice);
      pendingChoice = undefined;
    }
    return () => {
      if (choiceCallback === callback) choiceCallback = undefined;
    };
  },
};

contextBridge.exposeInMainWorld("wakeSharingOverlay", bridge);
