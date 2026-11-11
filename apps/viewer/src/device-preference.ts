export const SELECTED_DEVICE_STORAGE_KEY = "live-presence.viewer.selected-device-id";

type DevicePreferenceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const DEVICE_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function readSelectedDeviceId(storage: DevicePreferenceStorage | undefined): string {
  try {
    const saved = storage?.getItem(SELECTED_DEVICE_STORAGE_KEY) ?? "";
    return DEVICE_ID.test(saved) ? saved : "";
  } catch {
    return "";
  }
}

export function saveSelectedDeviceId(storage: DevicePreferenceStorage | undefined, deviceId: string): void {
  const selected = deviceId.trim();
  try {
    if (!storage) return;
    if (selected && DEVICE_ID.test(selected)) storage.setItem(SELECTED_DEVICE_STORAGE_KEY, selected);
    else storage.removeItem(SELECTED_DEVICE_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

export function saveSelectedDeviceIdWhenAvailable(
  storage: DevicePreferenceStorage | undefined,
  deviceId: string,
  available: boolean,
): void {
  if (available) saveSelectedDeviceId(storage, deviceId);
}
