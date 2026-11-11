import type { ClientLifecycleState } from "../../../shared/src/client.js";

export function viewerStatus(
  lifecycle: ClientLifecycleState,
  deviceOnline: boolean,
  screenSharing: boolean,
): ClientLifecycleState | "Connected" | "Reconnecting" {
  if (lifecycle === "CONNECTED" || (deviceOnline && !screenSharing && lifecycle === "CLOSED")) {
    return "Connected";
  }
  if (lifecycle === "RECONNECTING") return "Reconnecting";
  return lifecycle;
}
