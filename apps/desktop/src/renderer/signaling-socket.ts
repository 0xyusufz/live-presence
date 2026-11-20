import type { SignalingSocket } from "../../../../shared/src/client.js";
import { parseServerMessage } from "../../../../shared/src/protocol.js";
import type { LivePresenceBridge, SocketEvent } from "../ipc-contract.js";
import { readSignalingConnectFailureCategory } from "../main/signaling-connect-handler.js";

type SignalingBridge = Pick<
  LivePresenceBridge,
  "connectSignaling" | "sendSignaling" | "closeSignaling" | "onSocketEvent"
> & Partial<Pick<
  LivePresenceBridge,
  "registerSignalingPeerGeneration" | "clearSignalingPeerGeneration"
>>;
type DiagnosticLogger = (level: "info" | "warn" | "error", entry: Record<string, unknown>) => void;

let nextRendererAttemptId = 0;
const rendererOwnerByBridge = new WeakMap<SignalingBridge, number>();
const cancelPeerRegistrationWaitByBridge = new WeakMap<SignalingBridge, () => void>();

function closeReasonCategory(code: number): string {
  if (code === 1008) return "policy_or_authentication";
  if (code === 1013) return "retryable_service_unavailable";
  if (code === 1000) return "normal";
  if (code === 1006) return "abnormal_transport_loss";
  return "other";
}

function isAuthenticationMessage(data: unknown): boolean {
  if (typeof data !== "string") return false;
  try {
    const message = JSON.parse(data) as { type?: unknown };
    return message.type === "authenticated";
  } catch {
    return false;
  }
}

export function createSignalingSocket(
  bridge: SignalingBridge,
  diagnosticLogger: DiagnosticLogger = (level, entry) => {
    console[level](JSON.stringify(entry));
  },
): SignalingSocket {
  let readyState = 0;
  let connectionGeneration: number | undefined;
  let associationReady = false;
  let connectStarted = false;
  let localClosed = false;
  let closeDelivered = false;
  let attemptEnded = false;
  let rendererAttemptId: number | undefined;
  let connectCorrelationId: string | undefined;
  let connectPromise: Promise<number> | undefined;
  let activePeerGeneration: number | undefined;
  let activePeerRegistrationId: string | undefined;
  let peerRegistrationRevision = 0;
  let authenticatedConnectionGeneration: number | undefined;
  let activeSessionId: string | undefined;
  let sessionEventRevision = 0;
  let peerGenerationUpdates: Promise<void> = Promise.resolve();
  let unsubscribe: (() => void) | undefined;
  const pendingEvents: SocketEvent[] = [];
  const readinessWaiters = new Set<{
    revision: number;
    sessionRevision: number;
    sessionId: string;
    generation: number;
    resolve: () => void;
    reject: (error: Error) => void;
  }>();

  const log = (
    level: "info" | "warn" | "error",
    event: string,
    details: Record<string, unknown> = {},
  ): void => {
    try {
      diagnosticLogger(level, {
        source: "desktop-renderer",
        event,
        timestamp: new Date().toISOString(),
        ...(rendererAttemptId === undefined ? {} : { rendererAttemptId }),
        ...details,
      });
    } catch {
      // Diagnostics are best-effort and must not interrupt signaling.
    }
  };

  const endAttempt = (outcome: string, generation = connectionGeneration): void => {
    if (attemptEnded) return;
    attemptEnded = true;
    log("info", "renderer_connection_attempt_ended", {
      socketConnectionGeneration: generation ?? null,
      outcome,
    });
  };

  const isCurrentRendererOwner = (): boolean =>
    rendererAttemptId !== undefined &&
    rendererOwnerByBridge.get(bridge) === rendererAttemptId;

  const rejectReadinessWaiters = (reason: string): void => {
    for (const waiter of readinessWaiters) {
      readinessWaiters.delete(waiter);
      waiter.reject(new Error(reason));
    }
  };

  const settleReadinessWaiters = (): void => {
    for (const waiter of readinessWaiters) {
      if (waiter.revision !== peerRegistrationRevision ||
        waiter.generation !== connectionGeneration ||
        !isCurrentRendererOwner() ||
        localClosed ||
        closeDelivered) {
        readinessWaiters.delete(waiter);
        waiter.reject(new Error("signaling peer registration was superseded"));
      } else if (authenticatedConnectionGeneration === waiter.generation &&
        activeSessionId === waiter.sessionId) {
        readinessWaiters.delete(waiter);
        log("info", "peer_registration_readiness_satisfied", {
          socketConnectionGeneration: waiter.generation,
          peerGeneration: activePeerGeneration ?? null,
        });
        waiter.resolve();
      } else if (sessionEventRevision > waiter.sessionRevision) {
        readinessWaiters.delete(waiter);
        log("warn", "peer_registration_rejected_as_stale", {
          socketConnectionGeneration: waiter.generation,
          peerGeneration: activePeerGeneration ?? null,
          reason: "server-observed session changed before registration",
        });
        waiter.reject(new Error("signaling peer registration session changed"));
      }
    }
  };

  const waitForPeerRegistrationReady = (
    sessionId: string,
    generation: number,
    revision: number,
  ): Promise<void> => {
    if (revision !== peerRegistrationRevision ||
      generation !== connectionGeneration ||
      !isCurrentRendererOwner() ||
      localClosed ||
      closeDelivered) {
      return Promise.reject(new Error("signaling peer registration was superseded"));
    }
    if (authenticatedConnectionGeneration === generation && activeSessionId === sessionId) {
      return Promise.resolve();
    }
    log("info", "peer_registration_deferred", {
      socketConnectionGeneration: generation,
      peerGeneration: activePeerGeneration ?? null,
      waitingForAuthentication: authenticatedConnectionGeneration !== generation,
      waitingForSession: activeSessionId !== sessionId,
    });
    return new Promise<void>((resolve, reject) => {
      readinessWaiters.add({
        revision,
        sessionRevision: sessionEventRevision,
        sessionId,
        generation,
        resolve,
        reject,
      });
      settleReadinessWaiters();
    });
  };

  log("info", "renderer_socket_adapter_created");

  const socket: SignalingSocket = {
    get readyState() { return readyState; },
    get connectionGeneration() { return connectionGeneration; },
    authenticationManaged: true,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    connect: () => {
      log("info", "renderer_socket_connect_invoked", {
        socketConnectionGeneration: connectionGeneration ?? null,
        alreadyStarted: connectStarted,
        locallyClosed: localClosed,
      });
      if (connectStarted || localClosed) return;
      connectStarted = true;
      connectCorrelationId = crypto.randomUUID();
      rendererAttemptId = ++nextRendererAttemptId;
      cancelPeerRegistrationWaitByBridge.get(bridge)?.();
      rendererOwnerByBridge.set(bridge, rendererAttemptId);
      cancelPeerRegistrationWaitByBridge.set(bridge, () =>
        rejectReadinessWaiters("signaling socket was superseded"),
      );
      log("info", "renderer_connection_attempt_started");
      log("info", "renderer_signaling_connect_requested", {
        correlationId: connectCorrelationId,
      });
      const handleEvent = (event: SocketEvent): void => {
        if (localClosed || !isCurrentRendererOwner()) return;
        if (!associationReady) {
          pendingEvents.push(event);
          return;
        }
        if (event.connectionGeneration !== connectionGeneration) {
          if (event.type === "open") {
            rejectReadinessWaiters("signaling connection generation changed");
          }
          return;
        }

        if (event.type === "authentication-started") {
          log("info", "owner_authentication_started", {
            socketConnectionGeneration: event.connectionGeneration,
          });
        } else if (event.type === "open") {
          readyState = 1;
          authenticatedConnectionGeneration = event.connectionGeneration;
          socket.authenticatedOnOpen =
            event.authenticatedTransportReuse === true && typeof event.deviceId === "string";
          socket.authenticatedDeviceId = socket.authenticatedOnOpen ? event.deviceId : undefined;
          log("info", "renderer_socket_open_received", {
            socketConnectionGeneration: event.connectionGeneration,
            authenticatedTransportReuse: socket.authenticatedOnOpen,
          });
          settleReadinessWaiters();
          endAttempt("open", event.connectionGeneration);
          socket.onopen?.();
        } else if (event.type === "message") {
          let message: ReturnType<typeof parseServerMessage> | undefined;
          try {
            message = typeof event.data === "string"
              ? parseServerMessage(JSON.parse(event.data))
              : undefined;
          } catch {
            message = undefined;
          }
          if (message && (
            message.type === "viewer_joined" ||
            message.type === "viewer_rejoined" ||
            message.type === "session_recovery" ||
            message.type === "session_resumed"
          )) {
            activeSessionId = message.session_id;
            sessionEventRevision += 1;
            settleReadinessWaiters();
          } else if (message?.type === "viewer_left" &&
            message.session_id === activeSessionId &&
            message.reason !== "temporary_disconnect") {
            activeSessionId = undefined;
            sessionEventRevision += 1;
            settleReadinessWaiters();
          } else if (message?.type === "session_retired" &&
            message.session_id === activeSessionId) {
            activeSessionId = undefined;
            sessionEventRevision += 1;
            settleReadinessWaiters();
          } else if (message?.type === "sharing_state_updated" && !message.screen) {
            activeSessionId = undefined;
            sessionEventRevision += 1;
            settleReadinessWaiters();
          }
          if (isAuthenticationMessage(event.data)) {
            log("info", "renderer_authentication_received", {
              socketConnectionGeneration: event.connectionGeneration,
            });
          }
          socket.onmessage?.({ data: event.data });
        } else if (event.type === "close") {
          closeDelivered = true;
          readyState = 3;
          authenticatedConnectionGeneration = undefined;
          activeSessionId = undefined;
          sessionEventRevision += 1;
          rejectReadinessWaiters("signaling socket closed before peer registration");
          log("warn", "renderer_socket_close_received", {
            socketConnectionGeneration: event.connectionGeneration,
            closeCode: event.code,
            closeReasonCategory: closeReasonCategory(event.code ?? 1006),
          });
          log("warn", "renderer_signaling_socket_closed", {
            socketConnectionGeneration: event.connectionGeneration,
            closeCode: event.code,
            closeReasonCategory: closeReasonCategory(event.code ?? 1006),
          });
          endAttempt("socket_closed", event.connectionGeneration);
          socket.onclose?.({ code: event.code });
          unsubscribe?.();
          unsubscribe = undefined;
        } else if (event.type === "error") {
          socket.onerror?.();
        }
      };

      unsubscribe = bridge.onSocketEvent(handleEvent);
      connectPromise = bridge.connectSignaling(connectCorrelationId);
      void connectPromise.then((generation) => {
        if (!isCurrentRendererOwner()) {
          log("warn", "renderer_connection_generation_association_rejected", {
            socketConnectionGeneration: generation,
            reason: "renderer adapter was superseded before association",
          });
          log("warn", "renderer_stale_connection_resolution_ignored", {
            socketConnectionGeneration: generation,
          });
          pendingEvents.length = 0;
          closeLocally(1006, "superseded_before_connection_association");
          return;
        }
        if (localClosed) {
          log("warn", "renderer_connection_generation_association_rejected", {
            socketConnectionGeneration: generation,
            reason: "renderer adapter closed before association",
          });
          log("warn", "renderer_connection_closed_while_connect_pending", {
            socketConnectionGeneration: generation,
          });
          if (isCurrentRendererOwner()) {
            bridge.closeSignaling(generation);
            log("info", "renderer_close_dispatched", {
              socketConnectionGeneration: generation,
              deferredUntilConnectionGeneration: true,
            });
          } else {
            log("info", "renderer_stale_close_skipped", {
              socketConnectionGeneration: generation,
              deferredUntilConnectionGeneration: true,
            });
          }
          return;
        }
        connectionGeneration = generation;
        associationReady = true;
        log("info", "renderer_connection_generation_associated", {
          socketConnectionGeneration: generation,
        });
        const queued = pendingEvents.splice(0);
        for (const event of queued) handleEvent(event);
      }).catch((error: unknown) => {
        const connectFailureCategory = readSignalingConnectFailureCategory(error) ?? "unknown";
        log("error", "renderer_connection_generation_association_rejected", {
          socketConnectionGeneration: connectionGeneration ?? null,
          reason: "connect_signaling_rejected",
          correlationId: connectCorrelationId,
          connectFailureCategory,
        });
        if (localClosed) {
          endAttempt("closed_while_connect_pending");
          return;
        }
        log("error", "renderer_connection_attempt_failed", {
          outcome: "connect_signaling_rejected",
          correlationId: connectCorrelationId,
          connectFailureCategory,
        });
        socket.onerror?.();
        if (!closeDelivered && readyState !== 3) closeLocally(1006, "connect_failed");
      });
    },
    setPeerGeneration: (peerGeneration, sessionId) => {
      if (!Number.isSafeInteger(peerGeneration) || peerGeneration < 0) {
        return Promise.reject(new Error("invalid signaling peer generation"));
      }
      if (!isCurrentRendererOwner() || localClosed || closeDelivered) {
        return Promise.reject(new Error("signaling socket is no longer active"));
      }
      activePeerGeneration = peerGeneration;
      const revision = ++peerRegistrationRevision;
      settleReadinessWaiters();
      const previousRegistrationId = activePeerRegistrationId;
      activePeerRegistrationId = undefined;
      let clearPrevious = Promise.resolve();
      if (previousRegistrationId) {
        if (!bridge.clearSignalingPeerGeneration) {
          clearPrevious = Promise.reject(new Error("signaling peer cleanup is unavailable"));
        } else {
          clearPrevious = bridge.clearSignalingPeerGeneration(previousRegistrationId);
        }
      }
      const registration = (async () => {
        await clearPrevious;
        if (sessionId === undefined) return;
        if (!bridge.registerSignalingPeerGeneration) {
          throw new Error("signaling peer registration is unavailable");
        }
        const opening = connectPromise;
        if (!opening) throw new Error("signaling connection is not starting");
        const generation = await opening;
        await waitForPeerRegistrationReady(sessionId, generation, revision);
        if (localClosed || !isCurrentRendererOwner() ||
          activePeerGeneration !== peerGeneration ||
          peerRegistrationRevision !== revision ||
          authenticatedConnectionGeneration !== generation ||
          activeSessionId !== sessionId) {
          throw new Error("signaling peer generation was superseded");
        }
        const registrationId = await bridge.registerSignalingPeerGeneration(sessionId, generation);
        if (localClosed || !isCurrentRendererOwner() || activePeerGeneration !== peerGeneration) {
          if (!bridge.clearSignalingPeerGeneration) {
            throw new Error("signaling peer cleanup is unavailable");
          }
          await bridge.clearSignalingPeerGeneration(registrationId);
          throw new Error("signaling peer generation was superseded");
        }
        if (peerRegistrationRevision !== revision ||
          authenticatedConnectionGeneration !== generation ||
          activeSessionId !== sessionId) {
          if (!bridge.clearSignalingPeerGeneration) {
            throw new Error("signaling peer cleanup is unavailable");
          }
          await bridge.clearSignalingPeerGeneration(registrationId);
          throw new Error("signaling peer generation was superseded");
        }
        activePeerRegistrationId = registrationId;
      })();
      peerGenerationUpdates = registration;
      void registration.catch(() => undefined);
      return registration;
    },
    send: (data, peerGeneration, isCurrent) => {
      if (isCurrent && !isCurrent()) {
        return Promise.reject(new Error("signaling message belongs to a superseded peer"));
      }
      if (!isCurrentRendererOwner()) {
        return Promise.reject(new Error("signaling socket is no longer the active renderer owner"));
      }
      if (localClosed || closeDelivered) {
        return Promise.reject(new Error("signaling socket is closed"));
      }
      if (connectionGeneration === undefined) {
        return Promise.reject(new Error("signaling generation is unavailable"));
      }
      const generation = connectionGeneration;
      const send = async (): Promise<void> => {
        if (peerGeneration !== undefined) {
          await peerGenerationUpdates;
          if (activePeerGeneration !== peerGeneration) {
            throw new Error("signaling message belongs to a superseded peer");
          }
          if (!activePeerRegistrationId) {
            throw new Error("signaling peer registration is unavailable");
          }
          if (isCurrent && !isCurrent()) {
            throw new Error("signaling message belongs to a superseded peer");
          }
        }
        await bridge.sendSignaling(data, generation, peerGeneration === undefined
          ? undefined
          : activePeerRegistrationId);
      };
      return send().catch((error) => {
        socket.onerror?.();
        throw error;
      });
    },
    close: () => {
      if (localClosed) return;
      localClosed = true;
      peerRegistrationRevision += 1;
      rejectReadinessWaiters("signaling socket closed before peer registration");
      log("info", "renderer_close_requested", {
        socketConnectionGeneration: connectionGeneration ?? null,
        connectPending: connectStarted && connectionGeneration === undefined,
      });
      if (connectionGeneration !== undefined) {
        if (isCurrentRendererOwner()) {
          bridge.closeSignaling(connectionGeneration);
          log("info", "renderer_close_dispatched", {
            socketConnectionGeneration: connectionGeneration,
          });
        } else {
          log("info", "renderer_stale_close_skipped", {
            socketConnectionGeneration: connectionGeneration,
          });
        }
      }
      closeLocally(1000, "renderer_close");
    },
  };

  function closeLocally(code: number, outcome: string): void {
    if (closeDelivered) return;
    closeDelivered = true;
    readyState = 3;
    authenticatedConnectionGeneration = undefined;
    activeSessionId = undefined;
    peerRegistrationRevision += 1;
    rejectReadinessWaiters("signaling socket closed before peer registration");
    endAttempt(outcome);
    pendingEvents.length = 0;
    unsubscribe?.();
    unsubscribe = undefined;
    socket.onclose?.({ code });
  }

  return socket;
}
