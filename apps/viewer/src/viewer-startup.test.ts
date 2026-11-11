import assert from "node:assert/strict";
import { test } from "node:test";
import { readSelectedDeviceId, saveSelectedDeviceId } from "./device-preference.js";
import { ViewerStartupConnection } from "./viewer-startup.js";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
}

test("saved device automatically connects once per viewer page load", () => {
  const storage = memoryStorage();
  const deviceId = "00000000-0000-0000-0000-000000000001";
  saveSelectedDeviceId(storage, deviceId);
  const initialPage = new ViewerStartupConnection();
  const firstConnect: string[] = [];

  initialPage.start(readSelectedDeviceId(storage), (deviceId) => firstConnect.push(deviceId));
  initialPage.start(readSelectedDeviceId(storage), (deviceId) => firstConnect.push(deviceId));

  assert.deepEqual(firstConnect, [deviceId]);

  const reopenedPage = new ViewerStartupConnection();
  const reopenedConnect: string[] = [];
  reopenedPage.start(readSelectedDeviceId(storage), (deviceId) => reopenedConnect.push(deviceId));
  assert.deepEqual(reopenedConnect, [deviceId]);
});

test("explicit disconnect prevents an automatic startup connection", () => {
  const startup = new ViewerStartupConnection();
  const attempts: string[] = [];

  startup.disconnect();
  startup.start("00000000-0000-0000-0000-000000000001", (deviceId) => attempts.push(deviceId));

  assert.deepEqual(attempts, []);
});
