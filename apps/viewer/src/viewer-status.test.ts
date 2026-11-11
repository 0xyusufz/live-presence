import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClientLifecycleState } from "../../../shared/src/client.js";
import { viewerStatus } from "./viewer-status.js";

test("online inactive-sharing polls keep the visible status Connected", () => {
  const pollingLifecycles: ClientLifecycleState[] = ["CLOSED", "CLOSED", "CLOSED", "CLOSED"];
  const visibleStatuses = pollingLifecycles.map((lifecycle) => viewerStatus(lifecycle, true, false));
  assert.deepEqual(visibleStatuses, ["Connected", "Connected", "Connected", "Connected"]);
});

test("signaling loss shows Reconnecting instead of Connected", () => {
  assert.equal(viewerStatus("RECONNECTING", false, false), "Reconnecting");
});
