import {
  DesktopWebRtcClient,
  type DesktopClientOptions,
} from "../../../shared/src/client.js";

export type DesktopWebRtcClientOptions = DesktopClientOptions;

export function createDesktopWebRtcClient(
  options: DesktopWebRtcClientOptions,
): DesktopWebRtcClient {
  return new DesktopWebRtcClient(options);
}
