import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClientLifecycleState } from "../../../shared/src/client.js";
import { viewerStatus } from "./viewer-status.js";

test("online inactive-sharing polls show Not sharing", () => {
  const pollingLifecycles: ClientLifecycleState[] = ["CLOSED", "CLOSED", "CLOSED", "CLOSED"];
  const visibleStatuses = pollingLifecycles.map((lifecycle) => viewerStatus(lifecycle, true, false));
  assert.deepEqual(visibleStatuses, ["Not sharing", "Not sharing", "Not sharing", "Not sharing"]);
});

test("signaling loss shows Reconnecting instead of Connected", () => {
  assert.equal(viewerStatus("RECONNECTING", false, false), "Reconnecting");
});

test("owner offline and intentional viewer disconnect have distinct statuses", () => {
  assert.equal(viewerStatus("CLOSED", false, false), "Owner offline");
  assert.equal(viewerStatus("IDLE", false, false, true), "Disconnected");
});

test("sharing remains Connected and takes precedence over inactive-device states", () => {
  assert.equal(viewerStatus("CONNECTED", true, true), "Connected");
  assert.equal(viewerStatus("RECONNECTING", true, false), "Reconnecting");
});
