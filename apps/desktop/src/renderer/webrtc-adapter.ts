import type {
  WebRtcConfiguration,
  WebRtcDescription,
  WebRtcFactory,
  WebRtcPeerConnection,
  WebRtcTrack,
  WebRtcTransceiver,
} from "../../../../shared/src/webrtc.js";

function makeConfiguration(configuration?: WebRtcConfiguration): RTCConfiguration {
  return {
    iceServers: configuration?.iceServers?.map((server) => ({
      urls: typeof server.urls === "string" ? server.urls : [...server.urls],
      ...(server.username ? { username: server.username } : {}),
      ...(server.credential ? { credential: server.credential } : {}),
    })),
    ...(configuration?.iceTransportPolicy ? { iceTransportPolicy: configuration.iceTransportPolicy } : {}),
  };
}

function adaptTransceiver(transceiver: RTCRtpTransceiver): WebRtcTransceiver {
  return {
    get mid() { return transceiver.mid; },
    get currentDirection() { return transceiver.currentDirection; },
    get direction() { return transceiver.direction; },
    set direction(value: string) {
      if (value !== "sendonly" && value !== "recvonly" && value !== "sendrecv" && value !== "inactive") {
        throw new Error("invalid transceiver direction");
      }
      transceiver.direction = value;
    },
    sender: {
      replaceTrack: (track: WebRtcTrack | null) => {
        if (track !== null && !(track instanceof MediaStreamTrack)) {
          throw new Error("track is not a browser media track");
        }
        return transceiver.sender.replaceTrack(track);
      },
    },
  };
}

export const createBrowserPeer: WebRtcFactory = (configuration) => {
  const peer = new RTCPeerConnection(makeConfiguration(configuration));
  let onIceCandidate: WebRtcPeerConnection["onicecandidate"] = null;
  let onTrack: WebRtcPeerConnection["ontrack"] = null;
  let onConnectionStateChange: WebRtcPeerConnection["onconnectionstatechange"] = null;
  let onIceConnectionStateChange: WebRtcPeerConnection["oniceconnectionstatechange"] = null;
  let onSignalingStateChange: WebRtcPeerConnection["onsignalingstatechange"] = null;

  peer.onicecandidate = (event) => onIceCandidate?.({ candidate: event.candidate });
  peer.ontrack = (event) => onTrack?.({
    track: event.track,
    transceiver: { mid: event.transceiver.mid },
  });
  peer.onconnectionstatechange = () => onConnectionStateChange?.();
  peer.oniceconnectionstatechange = () => onIceConnectionStateChange?.();
  peer.onsignalingstatechange = () => onSignalingStateChange?.();

  const adapter: WebRtcPeerConnection = {
    get connectionState() { return peer.connectionState; },
    get iceConnectionState() { return peer.iceConnectionState; },
    get signalingState() { return peer.signalingState; },
    get transceivers() { return peer.getTransceivers().map(adaptTransceiver); },
    addTransceiver: (kind, init) => adaptTransceiver(peer.addTransceiver(kind, init)),
    setConfiguration: (value) => peer.setConfiguration(makeConfiguration(value)),
    createOffer: async (options) => {
      const description = await peer.createOffer(options);
      if (description.type !== "offer") throw new Error("browser returned a non-offer description");
      return { type: description.type, sdp: description.sdp };
    },
    createAnswer: async () => {
      const description = await peer.createAnswer();
      if (description.type !== "answer") throw new Error("browser returned a non-answer description");
      return { type: description.type, sdp: description.sdp };
    },
    setLocalDescription: (description: WebRtcDescription) => peer.setLocalDescription(description),
    setRemoteDescription: (description: WebRtcDescription) => peer.setRemoteDescription(description),
    addIceCandidate: (candidate) => peer.addIceCandidate(candidate as RTCIceCandidateInit | null),
    close: () => peer.close(),
    get onicecandidate() { return onIceCandidate; },
    set onicecandidate(value) { onIceCandidate = value; },
    get ontrack() { return onTrack; },
    set ontrack(value) { onTrack = value; },
    get onconnectionstatechange() { return onConnectionStateChange; },
    set onconnectionstatechange(value) { onConnectionStateChange = value; },
    get oniceconnectionstatechange() { return onIceConnectionStateChange; },
    set oniceconnectionstatechange(value) { onIceConnectionStateChange = value; },
    get onsignalingstatechange() { return onSignalingStateChange; },
    set onsignalingstatechange(value) { onSignalingStateChange = value; },
  };
  return adapter;
};
