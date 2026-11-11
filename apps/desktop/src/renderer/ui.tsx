import { useEffect, useRef, useState, type JSX } from "react";
import {
  DesktopWebRtcClient,
  type SignalingSocket,
  type ClientLifecycleState,
} from "../../../../shared/src/client.js";
import type { WebRtcPeer } from "../../../../shared/src/webrtc.js";
import { createBrowserPeer } from "./webrtc-adapter.js";
import {
  acquireLiveScreenTrack,
  confirmLiveScreenCapture,
  sharingStatus,
  stopCapturedTracks,
} from "./sharing-status.js";

type Capture = {
  generation: number;
  screen?: MediaStreamTrack;
  camera?: MediaStreamTrack;
  cameraPending?: boolean;
  preparingScreen?: boolean;
  failureHandled?: boolean;
  failed?: boolean;
  client?: DesktopWebRtcClient;
};

function makeSocket(): SignalingSocket {
  let readyState = 0;
  let unsubscribe: (() => void) | undefined;
  const socket: SignalingSocket = {
    get readyState() { return readyState; },
    authenticationManaged: true,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    connect: () => {
      unsubscribe ??= window.livePresence.onSocketEvent((event) => {
        if (event.type === "open") {
          readyState = 1;
          socket.onopen?.();
        } else if (event.type === "message") {
          socket.onmessage?.({ data: event.data });
        } else if (event.type === "close") {
          readyState = 3;
          socket.onclose?.({ code: event.code });
          unsubscribe?.();
          unsubscribe = undefined;
        } else if (event.type === "error") {
          socket.onerror?.();
        }
      });
      void window.livePresence.connectSignaling().catch(() => socket.onerror?.());
    },
    send: (data) => window.livePresence.sendSignaling(data).catch((error) => {
        socket.onerror?.();
        throw error;
      }),
    close: () => {
      if (readyState === 3) return;
      readyState = 3;
      unsubscribe?.();
      unsubscribe = undefined;
      window.livePresence.closeSignaling();
      socket.onclose?.({ code: 1000 });
    },
  };
  return socket;
}

export function DesktopApp(): JSX.Element {
  const path = new URL(window.location.href).pathname;
  if (path === "/picker") return <SourcePicker />;
  if (path === "/indicator") return <Indicator />;
  return <ShareWindow />;
}

function SourcePicker(): JSX.Element {
  const [sources, setSources] = useState<Array<{ id: string; name: string }>>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void window.livePresence.getPickerSources().then((items) => {
      if (active) setSources(items);
    }).catch(() => {
      if (active) setError("Unable to list available sources.");
    });
    return () => { active = false; };
  }, []);

  return (
    <main className="picker">
      <h1>Choose what to share</h1>
      <p>Select a screen or window. Nothing is selected automatically.</p>
      {error && <p role="alert">{error}</p>}
      <div className="source-list">
        {sources.map((source) => (
          <button key={source.id} onClick={() => window.livePresence.selectPickerSource(source.id)}>
            {source.name}
          </button>
        ))}
      </div>
      {sources.length === 0 && !error && <p>No shareable screens or windows are available.</p>}
      <button className="secondary" onClick={() => window.livePresence.cancelPicker()}>Cancel</button>
    </main>
  );
}

function Indicator(): JSX.Element {
  const [camera, setCamera] = useState(false);
  useEffect(() => window.livePresence.onAppEvent((event) => {
    if (event.type === "indicator-state") setCamera(event.camera);
  }), []);
  return (
    <main className="indicator">
      <span className="live-dot" />
      <div>
        <strong>Sharing screen</strong>
        <small>{camera ? "Camera is also sharing" : "Camera is off"}</small>
      </div>
      <button className="stop" onClick={() => window.livePresence.stopFromIndicator()}>Stop</button>
    </main>
  );
}

function ShareWindow(): JSX.Element {
  const capture = useRef<Capture>({ generation: 0 });
  const [state, setState] = useState<ClientLifecycleState>("IDLE");
  const [screenSharing, setScreenSharing] = useState(false);
  const [cameraSharing, setCameraSharing] = useState(false);
  const [indicatorPrepared, setIndicatorPrepared] = useState(false);
  const [message, setMessage] = useState("");
  const [credentialSaved, setCredentialSaved] = useState<boolean | undefined>();
  const [credentialInput, setCredentialInput] = useState("");
  const [serverUrl, setServerUrl] = useState("");

  function ensureOwnerClient(): DesktopWebRtcClient {
    const current = capture.current;
    if (current.client) return current.client;
    const client = new DesktopWebRtcClient({
      socketFactory: makeSocket,
      peerFactory: createBrowserPeer,
      managedAuthentication: true,
      loadManagedIceServers: () => window.livePresence.loadIceServers(),
      isSharingActive: () => Boolean(
        capture.current.screen &&
        capture.current.screen.readyState === "live" &&
        capture.current.generation > 0
      ),
      prepareOwnerPeer: (peer) => attachCurrentTracks(peer, capture.current.generation),
      onSharingResumed: () => {
        setMessage("Connected / Sharing resumed");
        window.livePresence.notifySharingResumed();
      },
      onOwnerSessionEnded: (reason) => {
        if (reason === "viewer_grace_expired" || reason === "authorization_revoked" || reason === "recovery_timeout") {
          void stopCurrent(
            reason === "recovery_timeout"
              ? "Network recovery timed out; sharing was stopped."
              : "Viewer session ended; sharing was stopped.",
          );
        }
      },
      onDiagnostic: (diagnostic) => {
        console.info(JSON.stringify({
          source: "desktop-renderer",
          event: diagnostic.event,
          deviceId: diagnostic.deviceId,
          lifecycle: diagnostic.lifecycle,
          signalingState: diagnostic.signalingState,
          sharingState: diagnostic.sharingState,
          sent: diagnostic.sent,
          category: diagnostic.category,
          recoveryAttemptId: diagnostic.recoveryAttemptId,
          recoveryPhase: diagnostic.recoveryPhase,
          originalError: diagnostic.event === "failure" || diagnostic.event === "signaling"
            ? diagnostic.message
            : undefined,
          sessionId: diagnostic.sessionId,
          peer: diagnostic.peer,
        }));
      },
      onSharingStateConfirmed: ({ deviceId, screen, camera }) => {
        console.info(JSON.stringify({
          source: "desktop-renderer",
          event: "sharing-state-confirmed",
          deviceId,
          lifecycle: capture.current.client?.lifecycle,
          signalingState: "open",
          sharingState: { screen, camera },
          sent: true,
        }));
        if (screen && capture.current.screen?.readyState === "live") {
          setMessage("Sharing is active and available to authorized viewers.");
        }
      },
      onTerminalError: (error) => {
        const current = capture.current;
        if (current.failureHandled) return;
        current.failureHandled = true;
        current.failed = true;
        const reason = `${error.message} Sharing was stopped.`;
        if (current.screen || current.preparingScreen) void stopCurrent(reason);
        else setMessage(reason);
      },
    });
    current.client = client;
    void client.setSharingState(false, false).catch(() => undefined);
    return client;
  }

  useEffect(() => {
    let active = true;
    void Promise.all([
      window.livePresence.hasCredential(),
      window.livePresence.getServerUrl(),
      window.livePresence.indicatorReady(),
    ]).then(([hasCredential, url, indicatorAvailable]) => {
      if (!active) return;
      setCredentialSaved(hasCredential);
      setServerUrl(url);
      setIndicatorPrepared(indicatorAvailable);
      if (hasCredential) {
        const client = ensureOwnerClient();
        void client.start().catch(() => {
          if (active) setMessage("Owner presence could not connect; retrying.");
        });
      }
    }).catch(() => {
      if (active) setMessage("Desktop setup could not be loaded.");
    });
    const timer = window.setInterval(() => {
      window.livePresence.reportHeartbeat();
      const current = capture.current;
      if (current.screen || current.preparingScreen) {
        if (current.client) setState(current.client.lifecycle);
      }
      if (current.client?.lifecycle === "FAILED" && !current.failureHandled) {
        const error = current.client.failure;
        current.failureHandled = true;
        current.failed = true;
        const reason = `${error?.message ?? "The WebRTC session failed."} Sharing was stopped.`;
        if (current.screen || current.preparingScreen) void stopCurrent(reason);
        else setMessage(reason);
      }
    }, 750);
    const removeEvents = window.livePresence.onAppEvent((event) => {
      if (event.type === "stop-sharing") void stopCurrent("Sharing stopped for safety.");
      if (event.type === "indicator-ready") setIndicatorPrepared(event.ready);
      if (event.type === "suspend") {
        const client = capture.current.client;
        if (!client) {
          window.livePresence.reportSleepMarker(false);
          return;
        }
        void client.prepareForSleep().then(
          () => window.livePresence.reportSleepMarker(true),
          () => window.livePresence.reportSleepMarker(false),
        );
      }
      if (event.type === "resume") {
        capture.current.client?.resumeAfterWake();
      }
    });
    return () => {
      active = false;
      window.clearInterval(timer);
      removeEvents();
    };
  }, []);

  async function stopCurrent(reason?: string): Promise<void> {
    const current = capture.current;
    current.generation += 1;
    current.cameraPending = false;
    current.preparingScreen = false;
    try { void current.client?.stopSharingSession().catch(() => undefined); } catch { /* the socket may already be closed */ }
    const screen = current.screen;
    const camera = current.camera;
    current.screen = undefined;
    current.camera = undefined;
    stopCapturedTracks(screen, camera);
    setScreenSharing(false);
    setCameraSharing(false);
    setState("IDLE");
    const cleanupResults = await Promise.allSettled([
      window.livePresence.setCameraIntent(false),
      window.livePresence.setScreenActive(false),
    ]);
    window.livePresence.acknowledgeCleanup();
    if (cleanupResults.some((result) => result.status === "rejected")) {
      setMessage(reason
        ? `${reason} Local media stopped; main-process cleanup is being enforced.`
        : "Local media stopped; main-process cleanup is being enforced.");
    } else if (reason) {
      setMessage(reason);
    }
  }

  async function saveCredential(): Promise<void> {
    const value = credentialInput.trim();
    if (!value) {
      setMessage("Enter the existing device credential.");
      return;
    }
    try {
      await window.livePresence.saveCredential(value);
      setCredentialInput("");
      setCredentialSaved(true);
      setMessage("Device credential saved securely.");
      const client = ensureOwnerClient();
      void client.start().catch(() => {
        setMessage("Owner presence could not connect; retrying.");
      });
    } catch {
      setMessage("The device credential could not be saved.");
    }
  }

  function startScreenShare(): void {
    if (screenSharing || capture.current.screen) return;
    const generation = ++capture.current.generation;
    capture.current.preparingScreen = true;
    capture.current.failed = false;
    capture.current.failureHandled = false;
    setMessage("");
    setState("CONNECTING");
    console.info(JSON.stringify({
      source: "desktop-renderer",
      event: "screen-capture-requested",
      lifecycle: capture.current.client?.lifecycle ?? state,
      signalingState: "not-connected",
      sharingState: { screen: false, camera: false },
      sent: false,
    }));
    window.livePresence.beginScreenCapture();
    let request: Promise<MediaStream>;
    try {
      request = navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch {
      void stopCurrent("Screen sharing could not be started.");
      return;
    }
    void finishScreenShare(request, generation);
  }

  async function finishScreenShare(request: Promise<MediaStream>, generation: number): Promise<void> {
    let screen: MediaStreamTrack;
    try {
      screen = await acquireLiveScreenTrack(() => request);
    } catch {
      if (capture.current.generation === generation) {
        await stopCurrent("Screen sharing was canceled or unavailable.");
      }
      return;
    }
    if (capture.current.generation !== generation) {
      screen.stop();
      return;
    }
    capture.current.screen = screen;
    capture.current.preparingScreen = false;
    setScreenSharing(true);
    screen.addEventListener("ended", () => {
      if (capture.current.screen === screen) void stopCurrent("The screen capture ended.");
    }, { once: true });

    try {
      await confirmLiveScreenCapture(screen, () => window.livePresence.setScreenActive(true));
      console.info(JSON.stringify({
        source: "desktop-renderer",
        event: "screen-capture-confirmed-by-main",
        lifecycle: capture.current.client?.lifecycle ?? state,
        signalingState: "unknown",
        sharingState: { screen: true, camera: false },
        sent: false,
      }));
      if (capture.current.generation !== generation || screen.readyState !== "live") {
        await stopCurrent("The screen capture ended before sharing could start.");
        return;
      }
      const client = ensureOwnerClient();
      await client.setSharingState(true, false);
      setState("CONNECTING");
      if (capture.current.generation !== generation) return;
      setState(client.lifecycle);
    } catch (error) {
      if (capture.current.generation === generation) {
        console.error(JSON.stringify({
          source: "desktop-renderer",
          event: "screen-sharing-activation-failed",
          lifecycle: capture.current.client?.lifecycle ?? state,
          signalingState: capture.current.client ? "unknown" : "not-connected",
          sharingState: { screen: false, camera: false },
          sent: false,
          category: "capture-or-signaling",
          originalError: error instanceof Error ? error.message : "unknown error",
        }));
        await stopCurrent("Sharing could not connect.");
      }
    }
  }

  async function attachCurrentTracks(peer: WebRtcPeer, generation: number): Promise<void> {
    const current = capture.current;
    if (current.generation !== generation || !current.screen || current.screen.readyState !== "live") {
      throw new Error("screen track is unavailable");
    }
    await peer.replaceTrack("screen", current.screen);
    if (current.generation !== generation || current.screen?.readyState !== "live") {
      throw new Error("screen sharing ended during peer preparation");
    }
    const camera = current.camera;
    if (camera?.readyState === "live") await peer.replaceTrack("camera", camera);
    else await peer.replaceTrack("camera", null);
    if (current.generation !== generation) throw new Error("sharing session stopped during peer preparation");
  }

  async function toggleCamera(): Promise<void> {
    const current = capture.current;
    const generation = current.generation;
    if (!current.screen || !current.client || current.screen.readyState !== "live") return;
    if (current.camera) {
      const camera = current.camera;
      current.camera = undefined;
      try { await current.client.replaceOwnerTrack("camera", null); } catch { /* stopping the track is still safe */ }
      camera.stop();
      await window.livePresence.setCameraIntent(false).catch(() => undefined);
      await current.client.setSharingState(true, false).catch(() => undefined);
      setCameraSharing(false);
      return;
    }
    if (current.cameraPending) return;

    current.cameraPending = true;
    try {
      await window.livePresence.setCameraIntent(true);
      if (capture.current.generation !== generation) return;
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      const camera = stream.getVideoTracks()[0];
      if (!camera || capture.current.generation !== generation || current.screen?.readyState !== "live") {
        for (const track of stream.getTracks()) track.stop();
        await window.livePresence.setCameraIntent(false);
        return;
      }
      current.camera = camera;
      camera.addEventListener("ended", () => {
        if (capture.current.camera === camera) void disableCameraAfterFailure(camera);
      }, { once: true });
      await current.client.replaceOwnerTrack("camera", camera);
      if (capture.current.generation !== generation || current.screen?.readyState !== "live") {
        camera.stop();
        return;
      }
      await current.client.setSharingState(true, true);
      setCameraSharing(true);
      setMessage("");
    } catch {
      const failedCamera = current.camera;
      current.camera = undefined;
      failedCamera?.stop();
      await current.client?.replaceOwnerTrack("camera", null).catch(() => undefined);
      await window.livePresence.setCameraIntent(false).catch(() => undefined);
      if (capture.current.generation === generation) setMessage("Camera is unavailable or permission was denied.");
    } finally {
      if (capture.current.generation === generation) current.cameraPending = false;
    }
  }

  async function disableCameraAfterFailure(camera: MediaStreamTrack): Promise<void> {
    const current = capture.current;
    if (current.camera !== camera) return;
    current.camera = undefined;
    try {
      await current.client?.replaceOwnerTrack("camera", null);
    } catch {
      setMessage("Camera stopped; screen sharing continues.");
    } finally {
      camera.stop();
      await window.livePresence.setCameraIntent(false).catch(() => undefined);
      await current.client?.setSharingState(true, false).catch(() => undefined);
      setCameraSharing(false);
      setMessage("Camera stopped; screen sharing continues.");
    }
  }

  return (
    <main className="desktop">
      <header>
        <p className="eyebrow">LIVE PRESENCE</p>
        <h1>Share your screen, on your terms.</h1>
        <p>Sharing starts only when you choose a screen locally.</p>
      </header>
      {credentialSaved === false && (
        <section className="card">
          <h2>Connect this device</h2>
          <p>Paste the existing enrolled-device credential. It is stored using the operating system credential store.</p>
          <input
            type="password"
            autoComplete="off"
            value={credentialInput}
            onChange={(event) => setCredentialInput(event.target.value)}
            aria-label="Existing device credential"
          />
          <button onClick={() => void saveCredential()}>Save device credential</button>
        </section>
      )}
      <section className="card">
        <p className="status">
          <span className={`status-dot ${capture.current.screen?.readyState === "live" ? "on" : ""}`} />
          {sharingStatus(
            capture.current.preparingScreen ? "preparing" :
              capture.current.screen?.readyState === "live" ? "live" : "idle",
            capture.current.client?.lifecycle ?? state,
            capture.current.failed ?? false,
          )}
        </p>
        <p>{serverUrl || "Signaling server not configured"}</p>
        <div className="actions">
          <button disabled={screenSharing || credentialSaved === false || !indicatorPrepared} onClick={startScreenShare}>
            Share Screen
          </button>
          <button className="secondary" disabled={!screenSharing} onClick={() => void toggleCamera()}>
            {cameraSharing ? "Turn camera off" : "Share camera"}
          </button>
          <button className="stop" disabled={!screenSharing} onClick={() => void stopCurrent()}>
            Stop sharing
          </button>
        </div>
        {cameraSharing && <p className="camera-note">Camera is sharing independently. Audio is not captured.</p>}
      </section>
      <p className="notice" role="status">{message}</p>
      <footer>Media is sent peer-to-peer when possible. The server handles signaling only.</footer>
    </main>
  );
}
