import type { CaptureDiagnosticEvent } from "../ipc-contract.js";

export function sharingStateSendEvent(
  event: string,
  publicationOutcome: string | undefined,
): CaptureDiagnosticEvent | undefined {
  if (event !== "sharing-state") return undefined;
  if (publicationOutcome === "socket_not_open" || publicationOutcome === "send_rejected") {
    return "sharing_state_update_not_sent";
  }
  if (publicationOutcome === "sent") return "sharing_state_update_sent";
  return undefined;
}
