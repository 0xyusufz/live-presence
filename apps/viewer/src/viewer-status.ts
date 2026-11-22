import type { ClientLifecycleState } from "../../../shared/src/client.js";

export function viewerStatus(
  lifecycle: ClientLifecycleState,
  deviceOnline: boolean,
  screenSharing: boolean,
  intentionallyDisconnected = false,
): ClientLifecycleState | "Connected" | "Not sharing" | "Owner offline" | "Disconnected" | "Reconnecting" {
  if (intentionallyDisconnected) return "Disconnected";
  if (lifecycle === "RECONNECTING") return "Reconnecting";
  if (lifecycle === "CONNECTED") return "Connected";
  if (lifecycle === "CLOSED" && deviceOnline && !screenSharing) return "Not sharing";
  if (lifecycle === "CLOSED" && !deviceOnline) return "Owner offline";
  return lifecycle;
}
