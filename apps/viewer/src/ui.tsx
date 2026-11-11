import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import {
  ViewerWebRtcClient,
  type ClientLifecycleState,
  type SignalingSocket,
} from "../../../shared/src/client.js";
import type { WebRtcTrack } from "../../../shared/src/webrtc.js";
import { createBrowserPeer } from "./webrtc-adapter.js";
import { RemoteCameraMedia } from "./remote-camera.js";
import {
  readSelectedDeviceId,
  saveSelectedDeviceId,
  saveSelectedDeviceIdWhenAvailable,
} from "./device-preference.js";
import { ViewerStartupConnection } from "./viewer-startup.js";
import { viewerStatus } from "./viewer-status.js";
import { VideoPlayback, stopViewerMediaTracks } from "./viewer-media.js";

function browserStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function createSocket(serverUrl: string): SignalingSocket {
  const url = new URL("/ws", serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  let socket: WebSocket | undefined;
  const adapter: SignalingSocket = {
    get readyState() { return socket?.readyState ?? WebSocket.CLOSED; },
    authenticationManaged: true,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    connect: () => {
      socket = new WebSocket(url);
      socket.onopen = () => adapter.onopen?.();
      socket.onmessage = (event) => adapter.onmessage?.({ data: event.data });
      socket.onerror = () => adapter.onerror?.();
      socket.onclose = (event) => adapter.onclose?.({ code: event.code });
    },
    send: (data) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("signaling socket is not open");
      socket.send(data);
    },
    close: () => socket?.close(),
  };
  return adapter;
}

export function ViewerApp(): JSX.Element {
  const [deviceId, setDeviceId] = useState(() => readSelectedDeviceId(browserStorage()));
  const [client, setClient] = useState<ViewerWebRtcClient>();
  const [lifecycle, setLifecycle] = useState<ClientLifecycleState>("IDLE");
  const [autoConnecting, setAutoConnecting] = useState(false);
  const [deviceOnline, setDeviceOnline] = useState(false);
  const [screenSharing, setScreenSharing] = useState(false);
  const [screenStream, setScreenStream] = useState<MediaStream>();
  const [cameraStream, setCameraStream] = useState<MediaStream>();
  const [cameraSharing, setCameraSharing] = useState(false);
  const [error, setError] = useState("");
  const clientRef = useRef<ViewerWebRtcClient | undefined>(undefined);
  const connectionInFlightGenerationRef = useRef<number | undefined>(undefined);
  const startupConnectionRef = useRef(new ViewerStartupConnection());
  const userDisconnectedRef = useRef(false);
  const attemptGenerationRef = useRef(0);
  const retryTimerRef = useRef<number | undefined>(undefined);
  const retryAttemptRef = useRef(0);
  const screenPlayback = useMemo(() => new VideoPlayback(), []);
  const cameraPlayback = useMemo(() => new VideoPlayback(), []);
  const setScreenVideo = useCallback((video: HTMLVideoElement | null) => {
    screenPlayback.setVideo(video);
  }, [screenPlayback]);
  const setCameraVideo = useCallback((video: HTMLVideoElement | null) => {
    cameraPlayback.setVideo(video);
  }, [cameraPlayback]);
  const cameraMedia = useMemo(() => new RemoteCameraMedia({
    onStream: setCameraStream,
    detachVideo: () => cameraPlayback.setStream(undefined),
  }), []);

  useEffect(() => screenPlayback.setStream(screenStream), [screenPlayback, screenStream]);
  useEffect(() => cameraPlayback.setStream(cameraStream), [cameraPlayback, cameraStream]);
  useEffect(() => () => {
    screenPlayback.clear();
    cameraPlayback.clear();
  }, [screenPlayback, cameraPlayback]);
  useEffect(() => {
    if (!client) return;
    const timer = window.setInterval(() => setLifecycle(client.lifecycle), 500);
    return () => window.clearInterval(timer);
  }, [client]);

  function schedulePreflightRetry(targetDevice: string, generation: number, message: string): void {
    if (userDisconnectedRef.current || attemptGenerationRef.current !== generation || retryTimerRef.current !== undefined) return;
    setError(message);
    setAutoConnecting(true);
    setLifecycle("RECONNECTING");
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(retryAttemptRef.current, 5));
    retryAttemptRef.current += 1;
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = undefined;
      void connect(targetDevice, generation);
    }, delay);
  }

  async function connect(targetDeviceInput = deviceId, generation = attemptGenerationRef.current): Promise<void> {
    const targetDevice = targetDeviceInput.trim();
    if (!targetDevice) {
      setError("Enter the ID of an authorized desktop device.");
      return;
    }
    if (connectionInFlightGenerationRef.current !== undefined || clientRef.current || userDisconnectedRef.current ||
      attemptGenerationRef.current !== generation) return;
    connectionInFlightGenerationRef.current = generation;
    setAutoConnecting(true);
    const apiOrigin = window.location.origin;
    try {
      const sessionResponse = await fetch(new URL("/auth/session", apiOrigin), {
        credentials: "include",
        cache: "no-store",
      });
      if (userDisconnectedRef.current || attemptGenerationRef.current !== generation) {
        if (connectionInFlightGenerationRef.current === generation) connectionInFlightGenerationRef.current = undefined;
        return;
      }
      if (!sessionResponse.ok) {
        connectionInFlightGenerationRef.current = undefined;
        if (sessionResponse.status >= 500) {
          schedulePreflightRetry(targetDevice, generation, "The Live Presence service is unavailable. Reconnecting…");
          return;
        }
        setAutoConnecting(false);
        setError("Sign in through the existing Live Presence account flow before connecting.");
        return;
      }
    } catch {
      if (connectionInFlightGenerationRef.current === generation) connectionInFlightGenerationRef.current = undefined;
      if (userDisconnectedRef.current || attemptGenerationRef.current !== generation) return;
      schedulePreflightRetry(targetDevice, generation, "The Live Presence service could not be reached. Reconnecting…");
      return;
    }
    if (userDisconnectedRef.current || attemptGenerationRef.current !== generation) {
      if (connectionInFlightGenerationRef.current === generation) connectionInFlightGenerationRef.current = undefined;
      return;
    }
    setError("");
    setDeviceOnline(false);
    const next = new ViewerWebRtcClient({
      socketFactory: () => createSocket(apiOrigin),
      peerFactory: createBrowserPeer,
      managedAuthentication: true,
      deviceId: targetDevice,
      loadIceServers: async () => {
        const response = await fetch(new URL("/webrtc/ice-servers", apiOrigin), {
          credentials: "include",
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`ICE server request failed (${response.status})`);
        const body: unknown = await response.json();
        if (!body || typeof body !== "object" || !("iceServers" in body) ||
          !Array.isArray(body.iceServers) || body.iceServers.length === 0) {
          throw new Error("ICE server response is invalid");
        }
        return { iceServers: body.iceServers };
      },
      onDiagnostic: (diagnostic) => {
        const log = "operationStatus" in diagnostic && diagnostic.operationStatus === "failed"
          ? console.warn
          : "event" in diagnostic && (
            diagnostic.event === "recovery" ||
            diagnostic.event === "peer_connection_state_changed" ||
            diagnostic.event === "ice_connection_state_changed" ||
            diagnostic.event === "signaling_state_changed"
          )
            ? console.info
            : console.debug;
        log("[viewer-webrtc]", diagnostic);
      },
      onTerminalError: (failure) => setError(failure.message),
      onSharingState: ({ screen, camera }) => {
        setScreenSharing(screen);
        setCameraSharing(camera);
        cameraMedia.setEnabled(screen && camera);
      },
      onDeviceAvailability: (online) => {
        setDeviceOnline(online);
        saveSelectedDeviceIdWhenAvailable(browserStorage(), targetDevice, online);
      },
      onSessionEnded: () => {
        cameraMedia.clear();
        setCameraSharing(false);
        setScreenStream((stream) => {
          stopViewerMediaTracks(stream);
          return undefined;
        });
        setCameraStream((stream) => {
          stopViewerMediaTracks(stream);
          return undefined;
        });
      },
    });
    next.onRemoteTrack = (track: WebRtcTrack, _mid, kind) => {
      if (!(track instanceof MediaStreamTrack) || !kind) return;
      if (kind === "screen") setScreenStream(new MediaStream([track]));
      else cameraMedia.setTrack(track);
    };
    clientRef.current = next;
    connectionInFlightGenerationRef.current = undefined;
    retryAttemptRef.current = 0;
    setClient(next);
    setLifecycle("CONNECTING");
    next.start();
  }

  useEffect(() => {
    const savedDeviceId = readSelectedDeviceId(browserStorage()).trim();
    userDisconnectedRef.current = false;
    const generation = attemptGenerationRef.current;
    startupConnectionRef.current.start(savedDeviceId, (selectedDeviceId) => {
      void connect(selectedDeviceId, generation);
    });
  }, []);

  function stop(): void {
    userDisconnectedRef.current = true;
    startupConnectionRef.current.disconnect();
    attemptGenerationRef.current += 1;
    connectionInFlightGenerationRef.current = undefined;
    if (retryTimerRef.current !== undefined) window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = undefined;
    clientRef.current?.close();
    clientRef.current = undefined;
    saveSelectedDeviceId(browserStorage(), "");
    setDeviceId("");
    setClient(undefined);
    setAutoConnecting(false);
    setDeviceOnline(false);
    setScreenSharing(false);
    stopViewerMediaTracks(screenStream, cameraStream);
    setScreenStream(undefined);
    cameraMedia.clear();
    setCameraStream(undefined);
    setCameraSharing(false);
    setLifecycle("IDLE");
    setError("");
  }

  const visibleStatus = viewerStatus(lifecycle, deviceOnline, screenSharing);

  return (
    <main className="viewer">
      <header>
        <p className="eyebrow">LIVE PRESENCE</p>
        <h1>Private, peer-to-peer viewing</h1>
        <p>Enter your existing sign-in session and an authorized desktop device. New sharing starts only on the desktop.</p>
      </header>
      {!client && !autoConnecting && (
        <section className="connect-card">
          <p>Use your existing browser sign-in. Your session cookie is never exposed to application JavaScript.</p>
          <label>
            Authorized desktop device ID
            <input
              value={deviceId}
              onChange={(event) => {
                setDeviceId(event.target.value);
              }}
            />
          </label>
          <button onClick={() => {
            userDisconnectedRef.current = false;
            retryAttemptRef.current = 0;
            const generation = ++attemptGenerationRef.current;
            void connect(deviceId, generation);
          }}>Connect</button>
        </section>
      )}
      {(client || autoConnecting) && (
        <section className="session-card">
          <div className="session-head">
            <strong>
              <span className={`dot ${visibleStatus === "Connected" ? "on" : ""}`} />
              {visibleStatus}
            </strong>
            <button className="stop" onClick={stop}>Disconnect</button>
          </div>
          <div className="video-grid">
            <figure className="screen">
              <video ref={setScreenVideo} autoPlay playsInline muted />
              <figcaption>Screen</figcaption>
            </figure>
            <figure className="camera">
              {cameraStream
                ? <video ref={setCameraVideo} autoPlay playsInline muted />
                : <div className="camera-off" role="status">{cameraSharing ? "Camera reconnecting" : "Camera off"}</div>}
              <figcaption>Camera</figcaption>
            </figure>
          </div>
          {!screenStream && <p className="waiting">{
            deviceOnline && !screenSharing
              ? "The desktop is connected but is not sharing."
              : "Waiting for the desktop to share its screen."
          }</p>}
        </section>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <footer>The signaling service does not receive or relay screen or camera media.</footer>
    </main>
  );
}
