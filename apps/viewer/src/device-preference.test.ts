import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readSelectedDeviceId,
  saveSelectedDeviceId,
  saveSelectedDeviceIdWhenAvailable,
  SELECTED_DEVICE_STORAGE_KEY,
} from "./device-preference.js";

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

test("viewer refresh restores only the selected device ID preference", () => {
  const storage = memoryStorage();
  saveSelectedDeviceId(storage, "  00000000-0000-0000-0000-000000000001  ");

  const refreshedPageDeviceId = readSelectedDeviceId(storage);

  assert.equal(refreshedPageDeviceId, "00000000-0000-0000-0000-000000000001");
  assert.equal(storage.length, 1);
  assert.equal(storage.key(0), SELECTED_DEVICE_STORAGE_KEY);
  assert.equal(storage.getItem("credential"), null);
  assert.equal(storage.getItem("token"), null);
});

test("clearing the selected device ID removes the persisted preference", () => {
  const storage = memoryStorage();
  saveSelectedDeviceId(storage, "00000000-0000-0000-0000-000000000001");
  saveSelectedDeviceId(storage, "");

  assert.equal(readSelectedDeviceId(storage), "");
  assert.equal(storage.length, 0);
});

test("restricted storage does not prevent loading, saving, or disconnecting", () => {
  const restrictedStorage = {
    getItem: () => { throw new Error("storage access denied"); },
    setItem: () => { throw new Error("storage access denied"); },
    removeItem: () => { throw new Error("storage access denied"); },
  };

  assert.equal(readSelectedDeviceId(restrictedStorage), "");
  assert.doesNotThrow(() => saveSelectedDeviceId(restrictedStorage, "device-id"));
  assert.doesNotThrow(() => saveSelectedDeviceId(restrictedStorage, ""));
});

test("malformed saved device IDs are ignored", () => {
  const storage = memoryStorage();
  storage.setItem(SELECTED_DEVICE_STORAGE_KEY, "not-a-device-id");

  assert.equal(readSelectedDeviceId(storage), "");
});

test("failed authorization does not save a newly entered device ID", () => {
  const storage = memoryStorage();

  saveSelectedDeviceIdWhenAvailable(storage, "00000000-0000-0000-0000-000000000001", false);

  assert.equal(readSelectedDeviceId(storage), "");
  assert.equal(storage.length, 0);
});

test("temporary unavailability does not clear a previously saved device ID", () => {
  const storage = memoryStorage();
  const deviceId = "00000000-0000-0000-0000-000000000001";
  saveSelectedDeviceId(storage, deviceId);

  saveSelectedDeviceIdWhenAvailable(storage, deviceId, false);

  assert.equal(readSelectedDeviceId(storage), deviceId);
});
