import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type JSX } from "react";
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
import { getViewerSession, requestViewerLogin, signOutViewer, type ViewerAccount } from "./auth-client.js";

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
  const [account, setAccount] = useState<ViewerAccount | null>();
  const [authChecked, setAuthChecked] = useState(false);
  const [authEmail, setAuthEmail] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authMessage, setAuthMessage] = useState("");
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
    try {
      const session = await getViewerSession();
      if (userDisconnectedRef.current || attemptGenerationRef.current !== generation) {
        if (connectionInFlightGenerationRef.current === generation) connectionInFlightGenerationRef.current = undefined;
        return;
      }
      setAccount(session);
      if (!session) {
        connectionInFlightGenerationRef.current = undefined;
        setAutoConnecting(false);
        setError("Your sign-in session has expired. Request a new sign-in link.");
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
    const apiOrigin = window.location.origin;
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
    let active = true;
    const savedDeviceId = readSelectedDeviceId(browserStorage()).trim();
    userDisconnectedRef.current = false;
    const generation = attemptGenerationRef.current;
    void getViewerSession().then((session) => {
      if (!active) return;
      setAccount(session);
      setAuthChecked(true);
      if (session) {
        startupConnectionRef.current.start(savedDeviceId, (selectedDeviceId) => {
          void connect(selectedDeviceId, generation);
        });
      }
    }).catch(() => {
      if (!active) return;
      setAccount(null);
      setAuthChecked(true);
      setError("The Live Presence sign-in service could not be reached.");
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!account) return;
    const timer = window.setInterval(() => {
      void getViewerSession().then((session) => {
        if (session) return;
        stop();
        setAccount(null);
        setError("Your sign-in session expired. Request a new sign-in link.");
      }).catch(() => undefined);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [account]);

  async function requestLoginLink(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setAuthBusy(true);
    setAuthMessage("");
    setError("");
    try {
      const result = await requestViewerLogin(authEmail.trim());
      setAuthMessage(result.deliveryConfigured
        ? "If this email is eligible, a sign-in link has been sent. Complete sign-in using the existing email flow, then return here."
        : "Email delivery is not configured for this server. Configure a login-link delivery provider to sign in.");
    } catch (requestError) {
      setAuthMessage(requestError instanceof Error ? requestError.message : "A sign-in link could not be requested.");
    } finally {
      setAuthBusy(false);
    }
  }

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

  async function signOut(): Promise<void> {
    try {
      await signOutViewer();
    } catch {
      setError("Sign-out could not reach the server. Your local viewer connection was closed.");
    }
    stop();
    setAccount(null);
    setAuthMessage("");
  }

  const visibleStatus = viewerStatus(lifecycle, deviceOnline, screenSharing);

  return (
    <main className="viewer">
      <header>
        <p className="eyebrow">LIVE PRESENCE</p>
        <h1>Private, peer-to-peer viewing</h1>
        <p>Sign in to connect to a desktop device you are authorized to view. New sharing starts only on the desktop.</p>
      </header>
      {!authChecked && <section className="connect-card" role="status">Checking sign-in session…</section>}
      {authChecked && !account && !client && !autoConnecting && (
        <section className="connect-card">
          <h2>Sign in</h2>
          <p>We’ll send a one-time sign-in link to your email. The session is stored in a secure, HTTP-only cookie.</p>
          <form onSubmit={(event) => void requestLoginLink(event)}>
            <label>
              Email address
              <input
                type="email"
                autoComplete="email"
                required
                value={authEmail}
                onChange={(event) => setAuthEmail(event.target.value)}
              />
            </label>
            <button disabled={authBusy} type="submit">{authBusy ? "Requesting…" : "Email me a sign-in link"}</button>
          </form>
          {authMessage && <p role="status">{authMessage}</p>}
        </section>
      )}
      {authChecked && account && !client && !autoConnecting && (
        <section className="connect-card">
          <div className="session-head">
            <p>Signed in as <strong>{account.email}</strong></p>
            <button className="secondary" onClick={() => void signOut()}>Sign out</button>
          </div>
          <label>
            Authorized desktop device ID
            <input
              value={deviceId}
              onChange={(event) => setDeviceId(event.target.value)}
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
            <div>
              <strong>
                <span className={`dot ${visibleStatus === "Connected" ? "on" : ""}`} />
                {visibleStatus}
              </strong>
              {account && <p>Signed in as {account.email}</p>}
            </div>
            <div>
              <button className="stop" onClick={stop}>Disconnect</button>
              <button className="secondary" onClick={() => void signOut()}>Sign out</button>
            </div>
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
