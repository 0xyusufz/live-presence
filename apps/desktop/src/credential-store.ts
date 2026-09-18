export interface DesktopCredentialStore {
  clearRefreshCredential(): Promise<void>;
  loadRefreshCredential(): Promise<string | null>;
  saveRefreshCredential(refreshCredential: string): Promise<void>;
}

export const desktopCredentialStorage = {
  namespace: "live-presence.device",
  purpose: "Persist the device refresh credential through Electron safeStorage/OS keychain.",
} as const;
