import {
  ViewerWebRtcClient,
  type ViewerClientOptions,
} from "../../../shared/src/client.js";

export type ViewerWebRtcClientOptions = ViewerClientOptions;

export function createViewerWebRtcClient(
  options: ViewerWebRtcClientOptions,
): ViewerWebRtcClient {
  return new ViewerWebRtcClient(options);
}
