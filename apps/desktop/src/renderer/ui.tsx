import { useEffect, useRef, useState, type JSX } from "react";
import {
  DesktopWebRtcClient,
  type SignalingSocket,
  type ClientLifecycleState,
} from "../../../../shared/src/client.js";
import { createBrowserPeer } from "./webrtc-adapter.js";
import {
  attachApprovedTracks,
  acquireLiveScreenTrack,
  beginScreenCapturePreparation,
  canStartWakeSharingChoice,
  confirmLiveScreenCapture,
  handleTerminalCaptureFailure,
  invalidateCapture,
  inspectScreenVideoTracks,
  isCurrentCameraTrack,
  isLiveCameraTrack,
  removeApprovedCameraTrack,
  replaceApprovedCameraTrack,
  detachOwnerClientAfterCaptureStop,
  reuseOrCreateOwnerClient,
  setApprovedCameraTrack,
  sharingStatus,
  startCameraAfterScreenActivation,
  stopOwnerCapture,
} from "./sharing-status.js";
import { createSignalingSocket } from "./signaling-socket.js";
import { sharingStateSendEvent } from "./capture-diagnostic-events.js";
import {
  captureCleanupDiagnostic,
  trackLifecycleDiagnostic,
} from "./capture-lifecycle-diagnostics.js";
import {
  isDefinitiveSleepRecoveryFailure,
  isNewWakeSharingChoiceCycle,
  shouldOfferWakeSharingChoice,
} from "../main/sleep-recovery-state.js";
import {
  displayCaptureFailureCategory,
  displayCaptureFailureMessage,
} from "../capture-utils.js";
import type {
  CaptureDiagnosticCategory,
  CaptureCleanupReason,
  CaptureDiagnosticDetails,
  CaptureDiagnosticErrorCode,
  CaptureDiagnosticEvent,
  WakeSharingChoiceOption,
  WakeSharingChoiceHandler,
  WakeSharingOverlayChoice,
} from "../ipc-contract.js";

type Capture = {
  generation: number;
  attemptId?: string;
  screen?: MediaStreamTrack;
  camera?: MediaStreamTrack;
  cameraPending?: boolean;
  preparingScreen?: boolean;
  failureHandled?: boolean;
  failed?: boolean;
  client?: DesktopWebRtcClient;
};

function makeSocket(): SignalingSocket {
  return createSignalingSocket(window.livePresence);
}

function reportCaptureDiagnostic(
  event: CaptureDiagnosticEvent,
  details: CaptureDiagnosticDetails = {},
  attemptId?: string,
): void {
  try {
    window.livePresence.reportCaptureDiagnostic(event, {
      ...details,
      timestampWallMs: Date.now(),
      timestampMonotonicMs: performance.now(),
      ...(attemptId ? { attemptId } : {}),
    });
  } catch {
    // Diagnostic IPC must not affect media capture.
  }
}

function diagnosticFailureCategory(error: unknown): CaptureDiagnosticCategory {
  const category = displayCaptureFailureCategory(error);
  switch (category) {
    case "video_stream_not_provided":
    case "permission_or_consent_denied":
    case "no_capture_source":
    case "capture_cancelled":
    case "capture_failed":
      return category;
    default:
      return "unknown";
  }
}

function diagnosticErrorCode(error: unknown): CaptureDiagnosticErrorCode {
  if (!(error instanceof Error)) return "unknown";
  switch (error.name) {
    case "AbortError":
    case "NotAllowedError":
    case "NotFoundError":
    case "TypeError":
    case "SecurityError":
    case "InvalidStateError":
    case "Error":
    case "DOMException":
      return error.name;
    default:
      return "unknown";
  }
}

export function DesktopApp(): JSX.Element {
  const path = new URL(window.location.href).pathname;
  if (path === "/picker") return <SourcePicker />;
  if (path === "/indicator") return <Indicator />;
  if (path === "/wake-sharing-overlay") return <WakeSharingOverlay />;
  return <ShareWindow />;
}

function WakeSharingOverlay(): JSX.Element {
  const [choice, setChoice] = useState<WakeSharingOverlayChoice | undefined>();

  useEffect(() => {
    const removeChoiceListener = window.wakeSharingOverlay.onChoice(setChoice);
    window.wakeSharingOverlay.reportReady();
    return removeChoiceListener;
  }, []);

  if (!choice) {
    return (
      <main className="wake-overlay-page" aria-live="polite">
        <p>Preparing sharing choices...</p>
      </main>
    );
  }

  return (
    <main className="wake-overlay-page">
      <section
        className="wake-choice wake-choice-window"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wake-overlay-title"
        aria-describedby="wake-overlay-description"
      >
        <h2 id="wake-overlay-title">What would you like to share?</h2>
        <p id="wake-overlay-description">
          Choose what to share again. Nothing starts until you choose.
        </p>
        {!choice.canChoose && <p role="status">Preparing the sharing controls...</p>}
        <div className="wake-choice-actions">
          <button
            disabled={!choice.canChoose}
            onClick={() => window.wakeSharingOverlay.select(choice.cycleId, "screen")}
          >
            Screen only
          </button>
          <button
            className="secondary"
            disabled={!choice.canChoose}
            onClick={() => window.wakeSharingOverlay.select(choice.cycleId, "screen-camera")}
          >
            Screen + camera
          </button>
          <button
            className="stop"
            onClick={() => window.wakeSharingOverlay.dismiss(choice.cycleId)}
          >
            Not now
          </button>
        </div>
      </section>
    </main>
  );
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
  const indicatorPreparedRef = useRef(false);
  const [message, setMessage] = useState("");
  const [credentialSaved, setCredentialSaved] = useState<boolean | undefined>();
  const [credentialInput, setCredentialInput] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [wakeChoiceOpen, setWakeChoiceOpen] = useState(false);
  const sleepRecoveryCycle = useRef<number | undefined>(undefined);
  const sleepRecoveryAttemptId = useRef<string | undefined>(undefined);
  const sleepRecoveryState = useRef<"idle" | "eligible" | "started" | "completed" | "failed" | "timed_out">("idle");
  const suspendStartedAt = useRef<number | undefined>(undefined);
  const wakeChoiceCycle = useRef<number | undefined>(undefined);
  const wakeChoiceObserved = useRef(false);
  const lastWakeChoiceCycle = useRef<number | undefined>(undefined);
  const wakeChoiceSelectionInFlight = useRef(false);
  const wakeChoiceHandlerRef = useRef<WakeSharingChoiceHandler>(() => false);
  wakeChoiceHandlerRef.current = (cycleId, option) =>
    startWakeSharingChoice(cycleId, option, false);

  function showWakeSharingChoice(cycleId: number): void {
    const alreadyOffered = !isNewWakeSharingChoiceCycle(cycleId, lastWakeChoiceCycle.current);
    if (!shouldOfferWakeSharingChoice(
      wakeChoiceCycle.current === cycleId,
      true,
      sleepRecoveryState.current === "completed",
      alreadyOffered,
    )) return;
    lastWakeChoiceCycle.current = cycleId;
    window.livePresence.registerDisplayedWakeSharingChoice(cycleId);
    if (window.livePresence.platform !== "darwin") {
      window.livePresence.restoreApplicationWindow();
      setWakeChoiceOpen(true);
    }
  }

  function cancelWakeSharingChoice(cycleId: number | undefined): boolean {
    if (cycleId === undefined || wakeChoiceCycle.current !== cycleId) return false;
    window.livePresence.completeWakeSharingChoice(cycleId);
    wakeChoiceCycle.current = undefined;
    wakeChoiceObserved.current = false;
    setWakeChoiceOpen(false);
    return true;
  }

  function reportTrackLifecycle(
    track: MediaStreamTrack,
    trackKind: "screen" | "camera",
    trackEvent: "ended" | "mute" | "unmute",
    attemptId?: string,
  ): void {
    const diagnostic = trackLifecycleDiagnostic(
      track,
      trackKind,
      trackEvent,
      capture.current.generation,
      sleepRecoveryCycle.current,
      sleepRecoveryState.current,
    );
    reportCaptureDiagnostic(diagnostic.event, diagnostic.details, attemptId);
  }

  function captureTrackDiagnosticDetails(): CaptureDiagnosticDetails {
    const current = capture.current;
    return {
      screen: current.screen?.readyState === "live",
      camera: current.camera?.readyState === "live",
      screenReadyState: current.screen?.readyState ?? "unavailable",
      cameraReadyState: current.camera?.readyState ?? "unavailable",
      screenEnabled: current.screen?.enabled,
      cameraEnabled: current.camera?.enabled,
      screenMuted: current.screen?.muted,
      cameraMuted: current.camera?.muted,
      captureGeneration: current.generation,
      cycleId: sleepRecoveryCycle.current,
      sleepRecoveryState: sleepRecoveryState.current,
    };
  }

  function requestSleepRecoveryCompletion(recoveryAttemptId?: string): void {
    if (
      sleepRecoveryCycle.current === undefined ||
      typeof recoveryAttemptId !== "string" ||
      recoveryAttemptId.length === 0 ||
      (sleepRecoveryState.current !== "eligible" && sleepRecoveryState.current !== "started")
    ) return;
    if (recoveryAttemptId !== sleepRecoveryAttemptId.current) return;
    reportCaptureDiagnostic("sleep_recovery_started", {
      cycleId: sleepRecoveryCycle.current,
      recoveryAttemptId,
      recoveryPhase: "completed",
      screen: capture.current.screen?.readyState === "live",
      signalingState: capture.current.client?.getSignalingState(),
    });
    window.livePresence.reportSleepRecovery(
      sleepRecoveryCycle.current,
      recoveryAttemptId,
      "completed",
    );
  }

  function ensureOwnerClient(): DesktopWebRtcClient {
    const current = capture.current;
    return reuseOrCreateOwnerClient(current, () => {
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
        isCameraActive: () => Boolean(
          capture.current.camera &&
          capture.current.camera.readyState === "live" &&
          capture.current.generation > 0
        ),
        getSharingGeneration: () => capture.current.generation,
        prepareOwnerPeer: (peer) =>
          attachApprovedTracks(peer, capture.current, capture.current.generation),
        onSharingResumed: (recoveryAttemptId) => {
          requestSleepRecoveryCompletion(recoveryAttemptId);
        },
        onOwnerSessionEnded: (reason) => {
          if (reason === "authorization_revoked") {
            void stopCurrent(
              "Viewer authorization was revoked; sharing was stopped.",
              true,
              "safety_stop",
              wakeChoiceCycle.current,
            );
          }
        },
        onDiagnostic: (diagnostic) => {
        if (
          diagnostic.event === "sleep_marker_sent" ||
          diagnostic.event === "sleep_marker_timed_out" ||
          diagnostic.event === "sleep_marker_error_received"
        ) {
          reportCaptureDiagnostic(diagnostic.event, {
            cycleId: diagnostic.cycleId ?? sleepRecoveryCycle.current,
            ...captureTrackDiagnosticDetails(),
            correlationId: diagnostic.correlationId,
            elapsedSinceSuspendMs: suspendStartedAt.current === undefined
              ? undefined
              : performance.now() - suspendStartedAt.current,
          }, capture.current.attemptId);
        }
        if (
          (sleepRecoveryState.current === "eligible" || sleepRecoveryState.current === "started") &&
          diagnostic.event === "recovery" &&
          diagnostic.recoveryPhase === "completed"
        ) {
          requestSleepRecoveryCompletion(diagnostic.recoveryAttemptId);
        }
        const sharingStateEvent = sharingStateSendEvent(
          diagnostic.event,
          diagnostic.publicationOutcome,
        );
        if (sharingStateEvent) {
          reportCaptureDiagnostic(
            sharingStateEvent,
            {
              screen: diagnostic.sharingState?.screen ?? false,
              camera: diagnostic.sharingState?.camera ?? false,
              sent: diagnostic.sent ?? false,
              publicationOutcome: diagnostic.publicationOutcome,
              signalingState: diagnostic.signalingState,
              rendererConnectionGeneration: diagnostic.rendererConnectionGeneration,
              stage: "signaling_send",
            },
            capture.current.attemptId,
          );
        }
        const recoveryLifecycleEvent =
          diagnostic.event === "recovery_started" ||
          diagnostic.event === "session_recovery_received" ||
          diagnostic.event === "recovery_completed" ||
          diagnostic.event === "recovery_timed_out" ||
          diagnostic.event === "recovery";
        console.info(JSON.stringify({
          source: "desktop-renderer",
          event: diagnostic.event,
          timestamp: diagnostic.timestamp ?? new Date().toISOString(),
          deviceId: diagnostic.deviceId,
          lifecycle: diagnostic.lifecycle,
          signalingState: diagnostic.signalingState,
          sharingState: diagnostic.sharingState,
          sent: diagnostic.sent,
          publicationOutcome: diagnostic.publicationOutcome,
          category: diagnostic.category,
          recoveryAttemptId: diagnostic.recoveryAttemptId,
          recoveryPhase: diagnostic.recoveryPhase,
          peerGeneration: diagnostic.peerGeneration,
          negotiationId: diagnostic.negotiationId,
          socketConnectionGeneration: diagnostic.socketConnectionGeneration,
          peerState: diagnostic.peerState,
          iceState: diagnostic.iceState,
          candidateType: diagnostic.candidateType,
          messageType: diagnostic.messageType,
          attempt: diagnostic.attempt,
          reason: diagnostic.reason,
          sessionId: diagnostic.sessionId,
          peer: diagnostic.peer,
          ...(recoveryLifecycleEvent
            ? {
                recoveryCause: diagnostic.event === "recovery_timed_out"
                  ? "overall_recovery_deadline_expired"
                  : diagnostic.reason,
                screenTrackLive: capture.current.screen?.readyState === "live",
                cameraTrackLive: capture.current.camera?.readyState === "live",
              }
            : {}),
        }));
      },
      onSharingStateConfirmed: ({ deviceId, screen, camera, rendererConnectionGeneration }) => {
        reportCaptureDiagnostic("sharing_state_update_confirmed", {
          screen,
          camera,
          sent: true,
          rendererConnectionGeneration,
          stage: "backend_acknowledgement",
        }, capture.current.attemptId);
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
        handleTerminalCaptureFailure(
          capture.current,
          error,
          (reason) => { void stopCurrent(reason, true, "terminal_failure"); },
          setMessage,
        );
      },
      });
      return client;
    }, (client) => {
      if (
        !capture.current.screen ||
        capture.current.screen.readyState !== "live" ||
        capture.current.generation === 0
      ) {
        void client.setSharingState(false, false).catch(() => undefined);
      }
      void client.start().catch(() => {
        setMessage("Owner presence could not connect; retrying.");
      });
    });
  }

  useEffect(() => {
    let active = true;
    const wakeChoiceHandler: WakeSharingChoiceHandler = (cycleId, option) =>
      wakeChoiceHandlerRef.current(cycleId, option);
    window.__livePresenceWakeSharingChoice = wakeChoiceHandler;
    void Promise.all([
      window.livePresence.hasCredential(),
      window.livePresence.getServerUrl(),
      window.livePresence.indicatorReady(),
    ]).then(([hasCredential, url, indicatorAvailable]) => {
      if (!active) return;
      setCredentialSaved(hasCredential);
      setServerUrl(url);
      indicatorPreparedRef.current = indicatorAvailable;
      setIndicatorPrepared(indicatorAvailable);
      window.livePresence.reportWakeSharingChoiceHandlerReady();
      if (hasCredential) {
        ensureOwnerClient();
      }
    }).catch(() => {
      if (active) {
        setMessage("Desktop setup could not be loaded.");
        window.livePresence.reportWakeSharingChoiceHandlerReady();
      }
    });
    const timer = window.setInterval(() => {
      window.livePresence.reportHeartbeat();
      const current = capture.current;
      if (current.screen || current.preparingScreen) {
        if (current.client) setState(current.client.lifecycle);
      }
      if (current.client?.lifecycle === "FAILED" && !current.failureHandled) {
        const error = current.client.failure;
        handleTerminalCaptureFailure(
          current,
          new Error(error?.message ?? "The WebRTC session failed."),
          (reason) => { void stopCurrent(reason, true, "terminal_failure"); },
          setMessage,
        );
      }
    }, 750);
    const removeEvents = window.livePresence.onAppEvent((event) => {
      if (event.type === "stop-sharing") {
        void stopCurrent(
          "Sharing stopped for safety.",
          true,
          "safety_stop",
          event.wakeChoiceCycleId,
        );
      }
      if (event.type === "wake-sharing-choice-dismissed" &&
        wakeChoiceCycle.current === event.cycleId) {
        wakeChoiceCycle.current = undefined;
        wakeChoiceObserved.current = false;
        setWakeChoiceOpen(false);
      }
      if (event.type === "indicator-ready") {
        indicatorPreparedRef.current = event.ready;
        setIndicatorPrepared(event.ready);
      }
      if (event.type === "suspend") {
        wakeChoiceCycle.current = event.sharingActive ? event.cycleId : undefined;
        wakeChoiceObserved.current = false;
        sleepRecoveryCycle.current = event.cycleId;
        sleepRecoveryAttemptId.current = undefined;
        sleepRecoveryState.current = "idle";
        suspendStartedAt.current = performance.now();
        const client = capture.current.client;
        reportCaptureDiagnostic("sleep_marker_prepare_started", {
          cycleId: event.cycleId,
          screen: capture.current.screen?.readyState === "live",
          camera: capture.current.camera?.readyState === "live",
          screenReadyState: capture.current.screen?.readyState ?? "unavailable",
          cameraReadyState: capture.current.camera?.readyState ?? "unavailable",
          screenEnabled: capture.current.screen?.enabled,
          cameraEnabled: capture.current.camera?.enabled,
          screenMuted: capture.current.screen?.muted,
          cameraMuted: capture.current.camera?.muted,
          captureGeneration: capture.current.generation,
          sleepRecoveryState: sleepRecoveryState.current,
          signalingState: client?.getSignalingState(),
        }, capture.current.attemptId);
        if (!client) {
          reportCaptureDiagnostic("sleep_marker_prepare_failed", {
            ...captureTrackDiagnosticDetails(),
            cycleId: event.cycleId,
            signalingState: "not-connected",
            elapsedSinceSuspendMs: suspendStartedAt.current === undefined
              ? undefined
              : performance.now() - suspendStartedAt.current,
          }, capture.current.attemptId);
          window.livePresence.reportSleepMarker(event.cycleId, false);
          return;
        }
        void client.prepareForSleep(event.cycleId).then(
          () => {
            reportCaptureDiagnostic("sleep_marker_prepare_acknowledged", {
              ...captureTrackDiagnosticDetails(),
              cycleId: event.cycleId,
              signalingState: client.getSignalingState(),
              elapsedSinceSuspendMs: suspendStartedAt.current === undefined
                ? undefined
                : performance.now() - suspendStartedAt.current,
            }, capture.current.attemptId);
            window.livePresence.reportSleepMarker(event.cycleId, true);
          },
          () => {
            reportCaptureDiagnostic("sleep_marker_prepare_failed", {
              ...captureTrackDiagnosticDetails(),
              cycleId: event.cycleId,
              signalingState: client.getSignalingState(),
              elapsedSinceSuspendMs: suspendStartedAt.current === undefined
                ? undefined
                : performance.now() - suspendStartedAt.current,
            }, capture.current.attemptId);
          },
        );
      }
      if (event.type === "sleep-recovery-result") {
        if (
          !event.accepted ||
          sleepRecoveryCycle.current !== event.cycleId ||
          sleepRecoveryAttemptId.current !== event.recoveryAttemptId ||
          sleepRecoveryState.current !== "started"
        ) return;
        if (isDefinitiveSleepRecoveryFailure(event.phase)) {
          sleepRecoveryState.current = "failed";
          reportCaptureDiagnostic("sleep_recovery_result", {
            ...captureTrackDiagnosticDetails(),
            cycleId: event.cycleId,
            recoveryAttemptId: event.recoveryAttemptId,
            recoveryPhase: "failed",
          });
          setMessage("Unable to resume sharing after sleep.");
          void stopCurrent("Unable to resume sharing after sleep.", true, "resume_ineligible");
          return;
        }
        if (event.phase !== "completed") return;
        sleepRecoveryState.current = "completed";
        wakeChoiceCycle.current = undefined;
        wakeChoiceObserved.current = false;
        reportCaptureDiagnostic("sleep_recovery_result", {
          ...captureTrackDiagnosticDetails(),
          cycleId: event.cycleId,
          recoveryAttemptId: event.recoveryAttemptId,
          recoveryPhase: "completed",
        });
        setMessage("Connected / Sharing resumed");
        window.livePresence.notifySharingResumed();
      }
      if (event.type === "sleep-recovery-attempt-accepted") {
        if (
          sleepRecoveryCycle.current !== event.cycleId ||
          sleepRecoveryAttemptId.current !== event.recoveryAttemptId ||
          sleepRecoveryState.current !== "eligible"
        ) return;
        const client = capture.current.client;
        if (!client || capture.current.screen?.readyState !== "live") {
          sleepRecoveryState.current = "failed";
          reportCaptureDiagnostic("sleep_recovery_result", {
            ...captureTrackDiagnosticDetails(),
            cycleId: event.cycleId,
            recoveryAttemptId: event.recoveryAttemptId,
            recoveryPhase: "failed",
          });
          window.livePresence.reportSleepRecovery(event.cycleId, event.recoveryAttemptId, "failed");
          return;
        }
        sleepRecoveryState.current = "started";
        reportCaptureDiagnostic("sleep_recovery_started", {
          ...captureTrackDiagnosticDetails(),
          cycleId: event.cycleId,
          recoveryAttemptId: event.recoveryAttemptId,
          recoveryPhase: "started",
          screen: capture.current.screen.readyState === "live",
          signalingState: client.getSignalingState(),
        });
        window.livePresence.reportSleepRecovery(event.cycleId, event.recoveryAttemptId, "started");
        client.resumeAfterWake(event.recoveryAttemptId);
      }
      if (event.type === "wake-sharing-choice") {
        wakeChoiceCycle.current = event.cycleId;
        wakeChoiceObserved.current = true;
        showWakeSharingChoice(event.cycleId);
      }
      if (event.type === "resume") {
        const current = capture.current;
        const client = current.client;
        if (!client && !current.screen && !current.preparingScreen && current.generation === 0) return;
        wakeChoiceCycle.current = event.cycleId;
        wakeChoiceObserved.current = true;
        const eligible = Boolean(
          client &&
          current.screen &&
          current.screen.readyState === "live",
        );
        const elapsedSinceSuspendMs = suspendStartedAt.current === undefined
          ? undefined
          : performance.now() - suspendStartedAt.current;
        if (
          sleepRecoveryCycle.current === event.cycleId &&
          sleepRecoveryState.current !== "idle"
        ) return;
        sleepRecoveryCycle.current = event.cycleId;
        sleepRecoveryAttemptId.current = crypto.randomUUID();
        sleepRecoveryState.current = eligible ? "eligible" : "failed";
        reportCaptureDiagnostic("sleep_recovery_eligibility", {
          cycleId: event.cycleId,
          screen: current.screen?.readyState === "live",
          camera: current.camera?.readyState === "live",
          screenReadyState: current.screen?.readyState ?? "unavailable",
          cameraReadyState: current.camera?.readyState ?? "unavailable",
          screenEnabled: current.screen?.enabled,
          cameraEnabled: current.camera?.enabled,
          screenMuted: current.screen?.muted,
          cameraMuted: current.camera?.muted,
          captureGeneration: current.generation,
          sleepRecoveryState: sleepRecoveryState.current,
          elapsedSinceSuspendMs,
          signalingState: client?.getSignalingState(),
        }, current.attemptId);
        reportCaptureDiagnostic(
          eligible ? "sleep_recovery_started" : "sleep_recovery_track_unavailable",
          {
            cycleId: event.cycleId,
            recoveryPhase: eligible ? "eligible" : "failed",
            screen: current.screen?.readyState === "live",
            signalingState: client?.getSignalingState(),
          },
        );
        window.livePresence.reportSleepRecovery(
          event.cycleId,
          sleepRecoveryAttemptId.current,
          "eligible",
        );
        if (!eligible) {
          void stopCurrent("Screen sharing ended during sleep.", true, "resume_ineligible");
          return;
        }
      }
      if (event.type === "sleep-recovery-timeout") {
        if (sleepRecoveryCycle.current !== event.cycleId) return;
        if (sleepRecoveryState.current !== "started" && sleepRecoveryState.current !== "eligible") return;
        sleepRecoveryState.current = "timed_out";
        capture.current.client?.abandonSleepRecovery();
        setMessage("Connection interrupted; sharing remains active while reconnection continues.");
        reportCaptureDiagnostic("sleep_recovery_started", {
          ...captureTrackDiagnosticDetails(),
          cycleId: event.cycleId,
          recoveryPhase: "timed_out",
          screen: capture.current.screen?.readyState === "live",
          signalingState: capture.current.client?.getSignalingState(),
        });
      }
    });
    return () => {
      active = false;
      if (window.__livePresenceWakeSharingChoice === wakeChoiceHandler) {
        delete window.__livePresenceWakeSharingChoice;
      }
      window.clearInterval(timer);
      removeEvents();
    };
  }, []);

  async function stopCurrent(
    reason: string | undefined,
    stopClient: boolean,
    cleanupReason: CaptureCleanupReason,
    wakeChoiceCancellationCycleId?: number,
  ): Promise<void> {
    const current = capture.current;
    const wakeChoiceToOffer = wakeChoiceObserved.current &&
      wakeChoiceCycle.current !== undefined &&
      (cleanupReason === "track_ended" ||
        cleanupReason === "resume_ineligible" ||
        cleanupReason === "terminal_failure")
      ? wakeChoiceCycle.current
      : undefined;
    if (cleanupReason === "explicit_user_stop") {
      cancelWakeSharingChoice(wakeChoiceCycle.current);
    } else if (cleanupReason === "safety_stop") {
      cancelWakeSharingChoice(wakeChoiceCancellationCycleId);
    }
    reportCaptureDiagnostic("capture_cleanup", captureCleanupDiagnostic(
      current.screen,
      current.camera,
      current.generation,
      sleepRecoveryCycle.current,
      sleepRecoveryState.current,
      cleanupReason,
    ), current.attemptId);
    sleepRecoveryState.current = "idle";
    sleepRecoveryCycle.current = undefined;
    sleepRecoveryAttemptId.current = undefined;
    if (current.screen) {
      reportCaptureDiagnostic("screen_track_state_before_false_publish", {
        stage: "before_signaling_update",
        readyState: current.screen.readyState === "live"
          ? "live"
          : current.screen.readyState === "ended"
            ? "ended"
            : "unavailable",
        enabled: current.screen.enabled,
        muted: current.screen.muted,
        screen: false,
        camera: false,
        reason: reason === "The screen capture ended."
          ? "ended_event"
          : "capture_stop",
      }, current.attemptId);
    }
    const { screen, camera } = invalidateCapture(current);
    current.attemptId = undefined;
    current.cameraPending = false;
    current.preparingScreen = false;
    if (stopClient) {
      detachOwnerClientAfterCaptureStop(current, true, cleanupReason);
    }
    setScreenSharing(false);
    setCameraSharing(false);
    setState("IDLE");
    const cleanupFailed = await stopOwnerCapture(
      screen,
      camera,
      () => window.livePresence.setCameraIntent(false),
      () => window.livePresence.setScreenActive(false),
      () => window.livePresence.acknowledgeCleanup(),
      () => {
        if (wakeChoiceToOffer !== undefined) showWakeSharingChoice(wakeChoiceToOffer);
      },
    );
    if (cleanupFailed) {
      setMessage(reason
        ? `${reason} Local media stopped; main-process cleanup is being enforced.`
        : "Local media stopped; main-process cleanup is being enforced.");
    } else if (reason) {
      setMessage(reason);
    }
  }

  function dismissWakeSharingChoice(): void {
    cancelWakeSharingChoice(wakeChoiceCycle.current);
  }

  function startWakeSharingChoice(
    cycleId: number | undefined,
    option: WakeSharingChoiceOption,
    requireIndicatorReady = true,
  ): boolean {
    if (
      cycleId === undefined ||
      !Number.isSafeInteger(cycleId) ||
      wakeChoiceCycle.current !== cycleId ||
      (option !== "screen" && option !== "screen-camera") ||
      !canStartWakeSharingChoice(
        !requireIndicatorReady || indicatorPreparedRef.current,
        wakeChoiceSelectionInFlight.current,
      )
    ) return false;
    wakeChoiceSelectionInFlight.current = true;
    dismissWakeSharingChoice();
    const starting = option === "screen"
      ? startScreenShare()
      : startCameraAfterScreenActivation(startScreenShare, toggleCamera);
    void starting.finally(() => {
      wakeChoiceSelectionInFlight.current = false;
    });
    return true;
  }

  function chooseWakeSharingOption(option: WakeSharingChoiceOption): void {
    startWakeSharingChoice(wakeChoiceCycle.current, option);
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
      ensureOwnerClient();
    } catch {
      setMessage("The device credential could not be saved.");
    }
  }

  async function startScreenShare(): Promise<boolean> {
    if (!beginScreenCapturePreparation(capture.current, screenSharing)) return false;
    const generation = ++capture.current.generation;
    const attemptId = crypto.randomUUID();
    capture.current.attemptId = attemptId;
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
    reportCaptureDiagnostic("screen_capture_requested", {
      screen: false,
      camera: false,
      stage: "local_user_action",
    }, attemptId);
    let request: Promise<MediaStream>;
    try {
      window.livePresence.beginScreenCapture(attemptId);
      reportCaptureDiagnostic("screen_display_media_request_started", {
        screen: false,
        camera: false,
        stage: "display_media_request",
      }, attemptId);
      request = navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch (error) {
      reportCaptureDiagnostic("screen_display_media_request_failed", {
        stage: "display_media_request",
        errorCategory: "display_media_failed",
        errorCode: diagnosticErrorCode(error),
      }, attemptId);
      await stopCurrent("Screen sharing could not be started.", true, "setup_failure")
        .catch(() => setMessage("Screen sharing could not be started; local cleanup was requested."));
      return false;
    }
    try {
      return await finishScreenShare(request, generation, attemptId);
    } catch (error: unknown) {
      reportCaptureDiagnostic("screen_sharing_activation_failed", {
        stage: "capture_operation",
        errorCategory: "capture_unexpected_failure",
        errorCode: diagnosticErrorCode(error),
      }, attemptId);
      if (capture.current.generation !== generation) return false;
      await stopCurrent("Screen sharing could not be completed.", true, "setup_failure").catch(() => undefined);
      setMessage("Screen sharing could not be completed. Local media cleanup was requested.");
      return false;
    }
  }

  async function finishScreenShare(
    request: Promise<MediaStream>,
    generation: number,
    attemptId: string,
  ): Promise<boolean> {
    let screen: MediaStreamTrack;
    let stream: MediaStream;
    try {
      stream = await request;
    } catch (error) {
      reportCaptureDiagnostic("screen_stream_acquisition_failed", {
        stage: "get_display_media",
        errorCategory: diagnosticFailureCategory(error),
        errorCode: diagnosticErrorCode(error),
      }, attemptId);
      if (capture.current.generation === generation) {
        const category = displayCaptureFailureCategory(error);
        console.warn(JSON.stringify({
          source: "desktop-renderer",
          event: "screen-capture-failed",
          timestamp: new Date().toISOString(),
          category,
        }));
        const message = displayCaptureFailureMessage(error);
        await stopCurrent(message, true, "setup_failure").catch(() => setMessage(message));
      }
      return false;
    }

    try {
      const inspection = inspectScreenVideoTracks(stream);
      reportCaptureDiagnostic("screen_stream_acquisition_succeeded", {
        stage: "get_display_media",
        trackCount: inspection.videoTracks.length,
        readyState: inspection.readyState,
        enabled: inspection.enabled,
        muted: inspection.muted,
      }, attemptId);
      screen = await acquireLiveScreenTrack(() => Promise.resolve(stream));
      reportCaptureDiagnostic("screen_live_track_validation_succeeded", {
        stage: "live_track_validation",
        trackCount: inspection.videoTracks.length,
        readyState: screen.readyState,
        enabled: screen.enabled,
        muted: screen.muted,
      }, attemptId);
    } catch (error) {
      reportCaptureDiagnostic("screen_live_track_validation_failed", {
        stage: "live_track_validation",
        errorCategory: "live_track_validation_failed",
        errorCode: diagnosticErrorCode(error),
      }, attemptId);
      if (capture.current.generation === generation) {
        const category = displayCaptureFailureCategory(error);
        console.warn(JSON.stringify({
          source: "desktop-renderer",
          event: "screen-capture-failed",
          timestamp: new Date().toISOString(),
          category,
        }));
        const message = displayCaptureFailureMessage(error);
        await stopCurrent(message, true, "setup_failure").catch(() => setMessage(message));
      }
      return false;
    }
    if (capture.current.generation !== generation) {
      reportCaptureDiagnostic("screen_track_unavailable", {
        stage: "post_acquisition",
        reason: "capture_generation_changed",
        readyState: screen.readyState,
        enabled: screen.enabled,
        muted: screen.muted,
      }, attemptId);
      screen.stop();
      return false;
    }
    capture.current.screen = screen;
    capture.current.preparingScreen = false;
    setScreenSharing(true);
    screen.addEventListener("ended", () => {
      reportTrackLifecycle(screen, "screen", "ended", attemptId);
      if (capture.current.screen === screen) {
        void stopCurrent("The screen capture ended.", true, "track_ended");
      }
    }, { once: true });
    screen.addEventListener("mute", () => {
      reportTrackLifecycle(screen, "screen", "mute", attemptId);
      reportCaptureDiagnostic("screen_track_became_unavailable", {
        stage: "track_lifecycle",
        readyState: screen.readyState,
        enabled: screen.enabled,
        muted: screen.muted,
        reason: "track_muted",
      }, attemptId);
    });
    screen.addEventListener("unmute", () => {
      reportTrackLifecycle(screen, "screen", "unmute", attemptId);
    });

    try {
      reportCaptureDiagnostic("sharing_state_activation_requested", {
        screen: true,
        camera: false,
        stage: "before_main_capture_confirmation",
      }, attemptId);
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
        reportCaptureDiagnostic("screen_track_unavailable", {
          stage: "post_main_confirmation",
          reason: capture.current.generation !== generation ? "capture_generation_changed" : "track_not_live",
          readyState: screen.readyState,
          enabled: screen.enabled,
          muted: screen.muted,
        }, attemptId);
        await stopCurrent(
          "The screen capture ended before sharing could start.",
          true,
          screen.readyState === "ended" ? "track_ended" : "setup_failure",
        );
        return false;
      }
      const client = ensureOwnerClient();
      reportCaptureDiagnostic("sharing_state_activation_requested", {
        screen: true,
        camera: false,
        stage: "before_signaling_update",
      }, attemptId);
      await client.setSharingState(true, false);
      setState("CONNECTING");
      if (capture.current.generation !== generation) return false;
      setState(client.lifecycle);
      return true;
    } catch (error) {
      if (capture.current.generation === generation) {
        reportCaptureDiagnostic("screen_sharing_activation_failed", {
          stage: "sharing_state_activation",
          screen: false,
          camera: false,
          errorCategory: "sharing_activation_failed",
          errorCode: diagnosticErrorCode(error),
        }, attemptId);
        console.error(JSON.stringify({
          source: "desktop-renderer",
          event: "screen-sharing-activation-failed",
          lifecycle: capture.current.client?.lifecycle ?? state,
          signalingState: capture.current.client ? "unknown" : "not-connected",
          sharingState: { screen: false, camera: false },
          sent: false,
          category: "capture-or-signaling",
          errorCategory: "sharing_activation_failed",
          errorCode: diagnosticErrorCode(error),
        }));
        await stopCurrent("Sharing could not connect.", true, "setup_failure");
      }
      return false;
    }
  }

  async function toggleCamera(): Promise<void> {
    const current = capture.current;
    const generation = current.generation;
    if (
      !current.screen ||
      !current.client ||
      current.screen.readyState !== "live" ||
      current.cameraPending
    ) return;
    if (current.camera) {
      const camera = current.camera;
      current.cameraPending = true;
      setApprovedCameraTrack(current, undefined);
      await removeApprovedCameraTrack(
        current,
        generation,
        camera,
        (track) => current.client!.replaceOwnerTrack("camera", track),
        (enabled) => window.livePresence.setCameraIntent(enabled),
        (screen, cameraEnabled) => current.client!.setSharingState(screen, cameraEnabled),
        () => setCameraSharing(false),
      );
      if (capture.current.generation === generation) current.cameraPending = false;
      return;
    }

    current.cameraPending = true;
    let requestedCamera: MediaStreamTrack | undefined;
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
      requestedCamera = camera;
      setApprovedCameraTrack(current, camera);
      camera.addEventListener("ended", () => {
        reportTrackLifecycle(camera, "camera", "ended", current.attemptId);
        if (capture.current.camera === camera) void disableCameraAfterFailure(camera);
      }, { once: true });
      camera.addEventListener("mute", () => {
        reportTrackLifecycle(camera, "camera", "mute", current.attemptId);
      });
      camera.addEventListener("unmute", () => {
        reportTrackLifecycle(camera, "camera", "unmute", current.attemptId);
      });
      await replaceApprovedCameraTrack(
        current,
        generation,
        (track) => current.client!.replaceOwnerTrack("camera", track),
      );
      if (
        capture.current.generation !== generation ||
        current.screen?.readyState !== "live" ||
        !isCurrentCameraTrack(current, camera) ||
        !isLiveCameraTrack(current, camera)
      ) {
        camera.stop();
        return;
      }
      await current.client.setSharingState(true, true);
      setCameraSharing(true);
      setMessage("");
    } catch {
      if (requestedCamera && isCurrentCameraTrack(current, requestedCamera)) {
        setApprovedCameraTrack(current, undefined);
        requestedCamera.stop();
        await replaceApprovedCameraTrack(
          current,
          generation,
          (track) => current.client!.replaceOwnerTrack("camera", track),
        ).catch(() => undefined);
        await window.livePresence.setCameraIntent(false).catch(() => undefined);
      }
      if (capture.current.generation === generation) setMessage("Camera is unavailable or permission was denied.");
    } finally {
      if (capture.current.generation === generation) current.cameraPending = false;
    }
  }

  async function disableCameraAfterFailure(camera: MediaStreamTrack): Promise<void> {
    const current = capture.current;
    if (current.camera !== camera) return;
    const generation = current.generation;
    setApprovedCameraTrack(current, undefined);
    if (current.client) {
      await removeApprovedCameraTrack(
        current,
        generation,
        camera,
        (track) => current.client!.replaceOwnerTrack("camera", track),
        (enabled) => window.livePresence.setCameraIntent(enabled),
        (screen, cameraEnabled) => current.client!.setSharingState(screen, cameraEnabled),
        () => {
          setCameraSharing(false);
          setMessage("Camera stopped; screen sharing continues.");
        },
        () => {
          if (capture.current.generation === generation &&
            current.screen?.readyState === "live") {
            setMessage("Camera stopped; screen sharing continues.");
          }
        },
      );
    } else {
      camera.stop();
      if (capture.current.generation === generation &&
        current.screen?.readyState === "live" &&
        current.camera === undefined) {
        await window.livePresence.setCameraIntent(false).catch(() => undefined);
        if (capture.current.generation === generation &&
          current.screen?.readyState === "live") {
          setCameraSharing(false);
          setMessage("Camera stopped; screen sharing continues.");
        }
      }
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
          <button
            disabled={screenSharing || capture.current.preparingScreen || credentialSaved === false || !indicatorPrepared}
            onClick={() => void startScreenShare()}
          >
            Share Screen
          </button>
          <button className="secondary" disabled={!screenSharing} onClick={() => void toggleCamera()}>
            {cameraSharing ? "Turn camera off" : "Share camera"}
          </button>
          <button
            className="stop"
            disabled={!screenSharing}
            onClick={() => void stopCurrent(undefined, true, "explicit_user_stop")}
          >
            Stop sharing
          </button>
        </div>
        {cameraSharing && <p className="camera-note">Camera is sharing independently. Audio is not captured.</p>}
      </section>
      {wakeChoiceOpen && (
        <div className="wake-choice-backdrop">
          <section
            className="wake-choice"
            role="dialog"
            aria-modal="true"
            aria-labelledby="wake-choice-title"
            aria-describedby="wake-choice-description"
          >
            <h2 id="wake-choice-title">What would you like to share?</h2>
            <p id="wake-choice-description">Choose what to share again. Nothing starts until you choose.</p>
            <div className="wake-choice-actions">
              <button
                disabled={!canStartWakeSharingChoice(
                  indicatorPrepared,
                  wakeChoiceSelectionInFlight.current,
                )}
                onClick={() => void chooseWakeSharingOption("screen")}
              >
                Screen only
              </button>
              <button
                className="secondary"
                disabled={!canStartWakeSharingChoice(
                  indicatorPrepared,
                  wakeChoiceSelectionInFlight.current,
                )}
                onClick={() => void chooseWakeSharingOption("screen-camera")}
              >
                Screen + camera
              </button>
              <button className="stop" onClick={dismissWakeSharingChoice}>Not now</button>
            </div>
          </section>
        </div>
      )}
      <p className="notice" role="status">{message}</p>
      <footer>Media is sent peer-to-peer when possible. The server handles signaling only.</footer>
    </main>
  );
}
