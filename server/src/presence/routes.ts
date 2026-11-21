import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { WebSocket, WebSocketServer } from "ws";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { AuthService } from "../auth/service.js";
import {
  MAX_PRESENCE_REVOCATION_RECORDS,
  type AppDatabase,
} from "../db/index.js";
import { DeviceAuthError, DeviceService } from "../devices/service.js";
import { PresenceService, type PresenceConnectionCloseCause } from "./service.js";
import {
  AuthorizationError,
  ViewerAuthorizationService,
} from "../authorization/service.js";
import { ResumeSessionStore } from "./resume.js";
import {
  presenceAuthorizationBindings,
  presenceRevocationOutbox,
  presenceRevocationTombstones,
} from "../db/schema.js";
import {
  parseClientMessage,
  type ClientMessage,
  type ServerMessage,
} from "../../../shared/src/protocol.js";
import { candidateTypeFromCandidate } from "../../../shared/src/webrtc.js";

const AUTH_TIMEOUT_MS = 5_000;
export const PRESENCE_EXPIRED_CLOSE_CODE = 1013;
export const VIEWER_DISCONNECT_GRACE_MS = 180_000;
export const SLEEP_RESUME_WINDOW_MS = 5 * 60_000;

export type PresenceCloseIntentSource = "stale-presence-expiry" | "heartbeat-expiry";

export function isLatestOwnerSocket<T extends object>(
  deviceId: string,
  socket: T,
  latestOwnerSockets: ReadonlyMap<string, T>,
): boolean {
  return latestOwnerSockets.get(deviceId) === socket;
}

export function closeExpiredPresenceSocket(
  socket: Pick<WebSocket, "readyState" | "close">,
  source: PresenceCloseIntentSource,
  details: {
    deviceId?: string;
    socketConnectionGeneration?: number;
  } = {},
): void {
  const closeAttempted = socket.readyState === WebSocket.OPEN;
  console.info(JSON.stringify({
    source: "backend",
    event: source === "stale-presence-expiry"
      ? "stale_presence_close_intent"
      : "heartbeat_expiry_close_intent",
    timestamp: new Date().toISOString(),
    ...details,
    closeCode: PRESENCE_EXPIRED_CLOSE_CODE,
    closeReasonCategory: source === "stale-presence-expiry"
      ? "stale_presence_retryable"
      : "heartbeat_expired_retryable",
    closeAttempted,
    socketReadyState: socket.readyState,
  }));
  if (closeAttempted) {
    socket.close(PRESENCE_EXPIRED_CLOSE_CODE, "presence expired");
  }
}

function closeReasonCategory(code: number): string {
  if (code === PRESENCE_EXPIRED_CLOSE_CODE) return "stale_presence_retryable";
  if (code === 1008) return "policy_or_authentication";
  if (code === 1001) return "server_shutdown";
  if (code === 1006) return "abnormal_transport_loss";
  if (code === 1000) return "normal";
  return "other";
}

function noStore(reply: FastifyReply): void {
  reply.header("cache-control", "no-store");
  reply.header("referrer-policy", "no-referrer");
}

function browserUser(request: FastifyRequest, auth: AuthService) {
  const token = request.cookies.live_presence_session;
  return token ? auth.getSession(token) : null;
}

function browserUserFromUpgrade(request: IncomingMessage, auth: AuthService) {
  const header = request.headers.cookie;
  if (!header || header.length > 8_192) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== "live_presence_session") continue;
    try {
      return auth.getSession(decodeURIComponent(part.slice(separator + 1).trim()));
    } catch {
      return null;
    }
  }
  return null;
}

function originAllowed(request: IncomingMessage, allowedOrigin: string): boolean {
  return request.headers.origin === allowedOrigin;
}

export async function registerPresenceRoutes(
  app: FastifyInstance,
  auth: AuthService,
  devices: DeviceService,
  presence: PresenceService,
  authorization: ViewerAuthorizationService,
  allowedOrigin: string,
  db: AppDatabase,
  networkRecoveryGraceMs = VIEWER_DISCONNECT_GRACE_MS,
): Promise<void> {
  app.get("/presence", async (request, reply) => {
    noStore(reply);
    const user = browserUser(request, auth);
    if (!user) {
      return reply.code(401).send({ error: "not authenticated" });
    }

    const devices = presence.getUserPresence(user.id).map((device) => ({
      ...device,
      ...(shareStates.get(device.deviceId) ?? { screen: false, camera: false }),
    }));
    return reply.send({
      devices,
      online: devices.length > 0,
    });
  });

  const webSocketServer = new WebSocketServer({ noServer: true });
  const sockets = new Map<string, WebSocket>();
  const socketConnectionGenerations = new WeakMap<WebSocket, number>();
  let nextSocketConnectionGeneration = 0;
  type Connection = { socket: WebSocket; userId: string; deviceId?: string; presenceId?: string; role: "owner" | "viewer" };
  type Session = {
    id: string;
    owner?: Connection;
    viewer?: Connection;
    ownerUserId: string;
    deviceId: string;
    viewerUserId: string;
    requests: Map<string, "screen" | "camera">;
    viewerGraceTimer?: NodeJS.Timeout;
    ownerGraceTimer?: NodeJS.Timeout;
    ownerGraceExpiresAt?: number;
    sleepTimer?: NodeJS.Timeout;
    sleepEpoch: number;
    sleepRequestId?: string;
    sleepCapabilities?: { owner: string; viewer: string; epoch: number; expiresAt: number };
  };
  const notifySessionRecovery = (session: Session): void => {
    if (!authorization.canAccess(session.ownerUserId, session.viewerUserId)) {
      authorization.revoke(session.ownerUserId, session.viewerUserId);
      return;
    }
    const recoveryAttemptId = randomUUID();
    const message = {
      type: "session_recovery" as const,
      session_id: session.id,
      recovery_attempt_id: recoveryAttemptId,
    };
    for (const [role, connection] of [
      ["owner", session.owner],
      ["viewer", session.viewer],
    ] as const) {
      if (!connection) continue;
      console.info(JSON.stringify({
        source: "backend",
        event: "session_recovery_notification_attempted",
        timestamp: new Date().toISOString(),
        deviceId: session.deviceId,
        sessionId: session.id,
        recoveryAttemptId,
        targetRole: role,
        socketConnectionGeneration: socketConnectionGenerations.get(connection.socket),
        messageType: message.type,
        socketReadyState: connection.socket.readyState,
      }));
    }
    const ownerSent = session.owner ? send(session.owner.socket, message) : false;
    const viewerSent = session.viewer ? send(session.viewer.socket, message) : false;
    for (const [role, connection, sent] of [
      ["owner", session.owner, ownerSent],
      ["viewer", session.viewer, viewerSent],
    ] as const) {
      if (!connection) continue;
      console.info(JSON.stringify({
        source: "backend",
        event: "session_recovery_notification_sent",
        timestamp: new Date().toISOString(),
        deviceId: session.deviceId,
        sessionId: session.id,
        recoveryAttemptId,
        targetRole: role,
        socketConnectionGeneration: socketConnectionGenerations.get(connection.socket),
        messageType: message.type,
        sent,
      }));
    }
  };
  const connections = new Map<WebSocket, Connection>();
  const latestOwnerSockets = new Map<string, WebSocket>();
  const ownerSharingStateSockets = new WeakSet<WebSocket>();
  const sessions = new Map<string, Session>();
  const sessionByDevice = new Map<string, string>();
  const shareStates = new Map<string, { screen: boolean; camera: boolean }>();
  const resumeStore = new ResumeSessionStore();
  let serverClosing = false;

  const closeConnection = (
    connectionId: string,
    cause: PresenceConnectionCloseCause,
  ): void => {
    const socket = sockets.get(connectionId);
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (cause === "stale") {
      const connection = connections.get(socket);
      closeExpiredPresenceSocket(socket, "stale-presence-expiry", {
        ...(connection?.deviceId ? { deviceId: connection.deviceId } : {}),
        socketConnectionGeneration: socketConnectionGenerations.get(socket),
      });
    }
    else if (cause === "revoked") socket.close(1008, "device revoked");
    else socket.close(1001, "server shutting down");
  };

  const send = (socket: WebSocket, message: ServerMessage | ClientMessage): boolean => {
    if (socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch (error) {
      console.warn(JSON.stringify({
        source: "backend",
        event: "websocket-send-failed",
        error: error instanceof Error ? error.message : "unknown error",
      }));
      return false;
    }
  };
  const getRevocationTombstone = (sessionId: string) =>
    db.select()
      .from(presenceRevocationTombstones)
      .where(eq(presenceRevocationTombstones.sessionId, sessionId))
      .get();
  const clearRevocationTombstone = (
    sessionId: string,
    ownerUserId: string,
    deviceId: string,
  ): void => {
    const operation = db.select()
      .from(presenceRevocationOutbox)
      .where(and(
        eq(presenceRevocationOutbox.sessionId, sessionId),
        eq(presenceRevocationOutbox.ownerUserId, ownerUserId),
        eq(presenceRevocationOutbox.deviceId, deviceId),
      ))
      .get();
    if (!operation || operation.processedAt === null) return;
    db.delete(presenceRevocationTombstones)
      .where(and(
        eq(presenceRevocationTombstones.sessionId, sessionId),
        eq(presenceRevocationTombstones.ownerUserId, ownerUserId),
        eq(presenceRevocationTombstones.deviceId, deviceId),
      ))
      .run();
  };
  const notifyAuthorizedViewers = (
    ownerUserId: string,
    deviceId: string,
    state: { screen: boolean; camera: boolean },
  ): void => {
    let delivered = 0;
    for (const viewer of connections.values()) {
      if (
        viewer.role === "viewer" &&
        authorization.canAccess(ownerUserId, viewer.userId)
      ) {
        send(viewer.socket, {
          type: "device_sharing_state",
          device_id: deviceId,
          ...state,
        });
        delivered += 1;
      }
    }
    console.info(JSON.stringify({
      source: "backend",
      event: "sharing-state-notified",
      deviceId,
      sessionId: sessionByDevice.get(deviceId),
      sharingState: state,
      authorizedViewerCount: delivered,
    }));
  };
  const setSharingState = (
    deviceId: string,
    state: { screen: boolean; camera: boolean },
    reason: string,
    socket?: WebSocket,
    sessionId?: string,
  ): void => {
    const previous = shareStates.get(deviceId) ?? { screen: false, camera: false };
    shareStates.set(deviceId, state);
    if (previous.screen === state.screen && previous.camera === state.camera) return;
    console.info(JSON.stringify({
      source: "backend",
      event: "sharing_state_transition",
      timestamp: new Date().toISOString(),
      deviceId,
      sessionId: sessionId ?? sessionByDevice.get(deviceId),
      previousSharingState: previous,
      newSharingState: state,
      reason,
      ...(socket ? { socketConnectionGeneration: socketConnectionGenerations.get(socket) } : {}),
    }));
  };
  const endSession = (
    sessionId: string,
    reason: string,
    preserveSharingState = false,
    viewerLeftReason = reason,
  ): void => {
    const session = sessions.get(sessionId);
    if (!session) return;
    if (reason === "sharing_stopped" || (reason === "closed" && !preserveSharingState)) {
      db.delete(presenceAuthorizationBindings)
        .where(and(
          eq(presenceAuthorizationBindings.deviceId, session.deviceId),
          eq(presenceAuthorizationBindings.viewerUserId, session.viewerUserId),
          eq(presenceAuthorizationBindings.sessionId, session.id),
        ))
        .run();
    }
    sessions.delete(sessionId);
    if (sessionByDevice.get(session.deviceId) === sessionId) sessionByDevice.delete(session.deviceId);
    if (session.viewerGraceTimer) clearTimeout(session.viewerGraceTimer);
    if (session.ownerGraceTimer) clearTimeout(session.ownerGraceTimer);
    if (session.sleepTimer) clearTimeout(session.sleepTimer);
    if (reason === "sleep_expired") resumeStore.expire(sessionId, Date.now());
    else resumeStore.invalidate(sessionId);
    const retainCaptureAfterSleepExpiry = reason === "sleep_expired";
    if (!preserveSharingState && !retainCaptureAfterSleepExpiry) {
      const previousSharingState = shareStates.get(session.deviceId);
      const inactive = { screen: false, camera: false };
      setSharingState(session.deviceId, inactive, `session-ended:${reason}`, undefined, sessionId);
      if (previousSharingState?.screen || previousSharingState?.camera) {
        notifyAuthorizedViewers(session.ownerUserId, session.deviceId, inactive);
      }
    }
    console.info(JSON.stringify({
      source: "backend",
      event: "session_ended",
      timestamp: new Date().toISOString(),
      deviceId: session.deviceId,
      sessionId,
      reason,
      sharingStateCleared: !preserveSharingState && !retainCaptureAfterSleepExpiry,
    }));
    const left = {
      type: "viewer_left" as const,
      session_id: sessionId,
      viewer_user_id: session.viewerUserId,
      reason: viewerLeftReason,
    };
    if (session.owner) send(session.owner.socket, left);
    if (session.viewer) send(session.viewer.socket, left);
  };
  const processPendingRevocations = (): Set<string> => {
    const completed = new Set<string>();
    let operations;
    try {
      operations = db.select()
        .from(presenceRevocationOutbox)
        .where(isNull(presenceRevocationOutbox.processedAt))
        .orderBy(
          asc(presenceRevocationOutbox.createdAt),
          asc(presenceRevocationOutbox.sessionId),
        )
        .limit(100)
        .all();
    } catch (error) {
      console.error(JSON.stringify({
        source: "backend",
        event: "presence_revocation_outbox_read_failed",
        error: error instanceof Error ? error.message : "unknown error",
      }));
      return completed;
    }
    for (const operation of operations) {
      try {
        const session = sessions.get(operation.sessionId);
        if (session) {
          if (
            session.ownerUserId !== operation.ownerUserId ||
            session.deviceId !== operation.deviceId ||
            session.viewerUserId !== operation.viewerUserId
          ) {
            console.error(JSON.stringify({
              source: "backend",
              event: "presence_revocation_outbox_identity_mismatch",
              sessionId: operation.sessionId,
            }));
            continue;
          }
          endSession(session.id, "authorization_revoked");
        }
        db.update(presenceRevocationOutbox)
          .set({ processedAt: Date.now() })
          .where(and(
            eq(presenceRevocationOutbox.sessionId, operation.sessionId),
            isNull(presenceRevocationOutbox.processedAt),
          ))
          .run();
        completed.add(operation.sessionId);
        const ownerSocket = latestOwnerSockets.get(operation.deviceId);
        const ownerConnection = ownerSocket ? connections.get(ownerSocket) : undefined;
        if (
          ownerSocket &&
          ownerConnection?.userId === operation.ownerUserId &&
          ownerConnection.deviceId === operation.deviceId
        ) {
          send(ownerSocket, {
            type: "session_retired",
            session_id: operation.sessionId,
            outcome: "authorization_revoked",
          });
        }
      } catch (error) {
        console.error(JSON.stringify({
          source: "backend",
          event: "presence_revocation_outbox_retry",
          sessionId: operation.sessionId,
          error: error instanceof Error ? error.message : "unknown error",
        }));
      }
    }
    return completed;
  };
  authorization.setRevocationHandler(() => {
    processPendingRevocations();
  });
  const revocationRetryTimer = setInterval(processPendingRevocations, 1_000);
  revocationRetryTimer.unref();
  processPendingRevocations();
  app.addHook("onClose", async () => clearInterval(revocationRetryTimer));

  const upgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    const requestUrl = new URL(
      request.url ?? "",
      `http://${request.headers.host ?? "localhost"}`,
    );
    if (
      requestUrl.pathname !== "/ws" ||
      requestUrl.search.length > 0 ||
      !originAllowed(request, allowedOrigin)
    ) {
      socket.destroy();
      return;
    }

    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      webSocketServer.emit("connection", client, request);
    });
  };

  const onConnection = (socket: WebSocket, request: IncomingMessage): void => {
    socketConnectionGenerations.set(socket, ++nextSocketConnectionGeneration);
    let connectionId: string | undefined;
    let authenticated = false;
    const authTimer = setTimeout(() => {
      if (!authenticated) {
        socket.close(1008, "authentication required");
      }
    }, AUTH_TIMEOUT_MS);
    const browser = browserUserFromUpgrade(request, auth);
    if (browser) {
      authenticated = true;
      clearTimeout(authTimer);
      connections.set(socket, { socket, userId: browser.id, role: "viewer" });
      send(socket, { type: "authenticated", role: "viewer" });
    }

    socket.on("message", (raw) => {
      if (raw.toString().length > 128 * 1024) {
        socket.close(1009, "message too large");
        return;
      }
      let message: ClientMessage | null;
      try {
        message = parseClientMessage(JSON.parse(raw.toString()));
      } catch {
        socket.close(1008, "invalid message");
        return;
      }

      if (!message) {
        socket.close(1008, "invalid message");
        return;
      }
      if (!authenticated) {
        if (
          !message ||
          typeof message !== "object" ||
          message.type !== "auth"
        ) {
          socket.close(1008, "authentication required");
          return;
        }

        try {
          const token = message.token;
          let connection: Connection;
          try {
            const device = devices.authenticateDevice(token);
            const record = presence.connect(device.userId, device.deviceId);
            connectionId = record.connectionId;
            sockets.set(connectionId, socket);
            connection = { socket, userId: device.userId, deviceId: device.deviceId, presenceId: connectionId, role: "owner" };
          } catch (error) {
              const user = auth.getSession(token);
              if (!user) throw new DeviceAuthError("authentication failed");
            connection = { socket, userId: user.id, role: "viewer" };
          }
          connections.set(socket, connection);
          authenticated = true;
          clearTimeout(authTimer);
          send(socket, { type: "authenticated", role: connection.role, ...(connection.deviceId ? { device_id: connection.deviceId } : {}) });
          if (connection.role === "owner" && connection.deviceId) {
            latestOwnerSockets.set(connection.deviceId, socket);
            const previousOwners = [...connections.values()].filter(
              (candidate) =>
                candidate.role === "owner" &&
                candidate.deviceId === connection.deviceId &&
                candidate.socket !== socket,
            );
            const previousOwnerSockets = new Set(previousOwners.map((candidate) => candidate.socket));
            const recoverableSessions = [...sessions.values()].filter(
              (recoverable) =>
                recoverable.deviceId === connection.deviceId &&
                !recoverable.sleepCapabilities &&
                (!recoverable.owner || previousOwnerSockets.has(recoverable.owner.socket)),
            );
            console.info(JSON.stringify({
              source: "backend",
              event: "owner-authenticated",
              timestamp: new Date().toISOString(),
              deviceId: connection.deviceId,
              socketConnectionGeneration: socketConnectionGenerations.get(socket),
              signalingState: "open",
              replacementSocketCount: previousOwners.length,
              reattachmentAttempted: recoverableSessions.length > 0,
              originalSessionIds: recoverableSessions.map((session) => session.id),
            }));
            if (recoverableSessions.length === 0) {
              console.info(JSON.stringify({
                source: "backend",
                event: "owner_session_reattachment",
                timestamp: new Date().toISOString(),
                deviceId: connection.deviceId,
                socketConnectionGeneration: socketConnectionGenerations.get(socket),
                originalSessionId: null,
                reattachmentSucceeded: false,
              }));
            }
            const processedRevocations = processPendingRevocations();
            const tombstones = db.select()
              .from(presenceRevocationTombstones)
              .where(and(
                eq(presenceRevocationTombstones.ownerUserId, connection.userId),
                eq(presenceRevocationTombstones.deviceId, connection.deviceId),
              ))
              .all();
            for (const tombstone of tombstones) {
              if (processedRevocations.has(tombstone.sessionId)) continue;
              send(socket, {
                type: "session_retired",
                session_id: tombstone.sessionId,
                outcome: "authorization_revoked",
              });
            }
            for (const recoverable of recoverableSessions) {
              if (recoverable.ownerGraceTimer) clearTimeout(recoverable.ownerGraceTimer);
              recoverable.ownerGraceTimer = undefined;
              recoverable.ownerGraceExpiresAt = undefined;
              recoverable.owner = connection;
              console.info(JSON.stringify({
                source: "backend",
                event: "owner_session_reattachment",
                timestamp: new Date().toISOString(),
                deviceId: connection.deviceId,
                socketConnectionGeneration: socketConnectionGenerations.get(socket),
                originalSessionId: recoverable.id,
                reattachmentSucceeded: true,
              }));
              console.info(JSON.stringify({
                source: "backend",
                event: "owner-session-recovered",
                timestamp: new Date().toISOString(),
                deviceId: connection.deviceId,
                sessionId: recoverable.id,
                originalSessionId: recoverable.id,
                socketConnectionGeneration: socketConnectionGenerations.get(socket),
                reattachmentSucceeded: true,
              }));
              notifySessionRecovery(recoverable);
            }
            for (const previousOwner of previousOwners) {
              previousOwner.socket.close(1008, "owner connection replaced");
            }
          } else if (connection.role === "viewer") {
            console.info(JSON.stringify({
              source: "backend",
              event: "viewer-authenticated",
              signalingState: "open",
            }));
          }
        } catch (error) {
          if (error instanceof DeviceAuthError) {
            socket.close(1008, "authentication failed");
            return;
          }
          socket.close(1011, "authentication unavailable");
        }
        return;
      }

      const connection = connections.get(socket);
      if (!connection || !message || typeof message !== "object") return;
      const type = message.type;
      if (type === "heartbeat" && connection.presenceId) {
        try {
          presence.heartbeat(connection.presenceId);
          send(socket, { type: "heartbeat_ack" });
        } catch {
          closeExpiredPresenceSocket(socket, "heartbeat-expiry", {
            ...(connection.deviceId ? { deviceId: connection.deviceId } : {}),
            socketConnectionGeneration: socketConnectionGenerations.get(socket),
          });
        }
      } else if (type === "sharing_state" && connection.role === "owner" && connection.deviceId) {
        const replacementOwner = !isLatestOwnerSocket(
          connection.deviceId,
          socket,
          latestOwnerSockets,
        );
        const attachedSessionId = sessionByDevice.get(connection.deviceId);
        if (replacementOwner) {
          console.info(JSON.stringify({
            source: "backend",
            event: "stale-owner-sharing-state-ignored",
            timestamp: new Date().toISOString(),
            deviceId: connection.deviceId,
            sessionId: attachedSessionId,
            socketConnectionGeneration: socketConnectionGenerations.get(socket),
            replacementSocketExists: true,
            sharingState: { screen: message.screen, camera: message.camera },
          }));
          return;
        }
        ownerSharingStateSockets.add(socket);
        setSharingState(
          connection.deviceId,
          { screen: message.screen, camera: message.camera },
          "owner-sharing-state-message",
          socket,
        );
        notifyAuthorizedViewers(connection.userId, connection.deviceId, {
          screen: message.screen,
          camera: message.camera,
        });
        console.info(JSON.stringify({
          source: "backend",
          event: "sharing-state-received",
          deviceId: connection.deviceId,
          sessionId: sessionByDevice.get(connection.deviceId),
          sharingState: { screen: message.screen, camera: message.camera },
        }));
        send(socket, {
          type: "sharing_state_updated",
          device_id: connection.deviceId,
          screen: message.screen,
          camera: message.camera,
          ...(sessionByDevice.get(connection.deviceId)
            ? { session_id: sessionByDevice.get(connection.deviceId)! }
            : {}),
        });
        if (!message.screen) {
          const currentSessionId = sessionByDevice.get(connection.deviceId);
          if (currentSessionId) endSession(currentSessionId, "sharing_stopped");
        }
      } else if (type === "create_session" && connection.role === "viewer") {
          const deviceId = message.device_id;
          const ownerPresence = presence.getDevicePresence(deviceId);
        const currentSessionId = sessionByDevice.get(deviceId);
        const currentSession = currentSessionId ? sessions.get(currentSessionId) : undefined;
        const ownerUserId =
          ownerPresence?.userId ??
          currentSession?.ownerUserId ??
          devices.getActiveDeviceOwner(deviceId);
        if (
          !ownerUserId ||
          (currentSession && ownerPresence && currentSession.ownerUserId !== ownerPresence.userId) ||
          !authorization.canAccess(ownerUserId, connection.userId)
        ) {
          send(socket, { type: "error", code: "NOT_AUTHORIZED" }); return;
        }
        if (!ownerPresence && !currentSession) {
          send(socket, { type: "error", code: "DEVICE_OFFLINE" }); return;
        }
        if (message.active_session_id !== undefined && message.active_session_id !== currentSession?.id) {
          send(socket, { type: "error", code: "SESSION_NOT_FOUND" }); return;
        }
          const currentSharingState = shareStates.get(deviceId) ?? { screen: false, camera: false };
          const ownerRecoveryRemainingMs =
            currentSession &&
            !currentSession.owner &&
            !currentSession.sleepCapabilities &&
            currentSession.ownerGraceExpiresAt &&
            currentSession.ownerGraceExpiresAt > Date.now()
              ? Math.ceil(currentSession.ownerGraceExpiresAt - Date.now())
              : undefined;
          if (currentSession) {
            console.info(JSON.stringify({
              source: "backend",
              event: "session-recovery-request",
              deviceId,
              sessionId: currentSession.id,
              viewerMatched: currentSession.viewerUserId === connection.userId,
              viewerAttached: currentSession.viewer !== undefined,
              ownerAttached: currentSession.owner !== undefined,
              viewerGraceActive: currentSession.viewerGraceTimer !== undefined,
              screenSharing: currentSharingState.screen,
            }));
          }
          if (!currentSharingState.screen) {
            send(socket, {
              type: "device_sharing_state",
              device_id: deviceId,
              ...currentSharingState,
            });
            console.info(JSON.stringify({
              source: "backend",
              event: "create-session-waiting",
              deviceId,
              sharingState: currentSharingState,
              result: "SHARING_INACTIVE",
            }));
            return;
          }
          if (currentSession) {
            const previousViewer = currentSession.viewer;
            const knownSessionReconnect =
              message.active_session_id === currentSession.id ||
              previousViewer?.socket === socket;
            if (
              currentSession.viewerUserId !== connection.userId ||
              (!previousViewer && !currentSession.viewerGraceTimer && !currentSession.sleepCapabilities)
            ) {
              send(socket, { type: "error", code: "DEVICE_BUSY" }); return;
            }
            if (currentSession.viewerGraceTimer) clearTimeout(currentSession.viewerGraceTimer);
            currentSession.viewerGraceTimer = undefined;
            currentSession.viewer = connection;
            send(socket, {
              type: "device_sharing_state",
              device_id: deviceId,
              ...currentSharingState,
            });
            send(socket, {
              type: "session_attached",
              session_id: currentSession.id,
              device_id: deviceId,
              ...currentSharingState,
              ...(ownerRecoveryRemainingMs === undefined
                ? {}
                : { owner_recovery_remaining_ms: ownerRecoveryRemainingMs }),
              ...(message.request_id === undefined ? {} : { request_id: message.request_id }),
            });
            if (knownSessionReconnect) {
              notifySessionRecovery(currentSession);
            } else if (currentSession.owner) {
              send(currentSession.owner.socket, {
                type: "viewer_rejoined",
                session_id: currentSession.id,
                viewer_user_id: connection.userId,
              });
            }
            if (previousViewer && previousViewer.socket !== socket) {
              previousViewer.socket.close(1008, "viewer connection replaced");
            }
            return;
          }
          const owner = [...connections.values()].find((candidate) => candidate.role === "owner" && candidate.deviceId === deviceId);
          if (!owner) { send(socket, { type: "error", code: "DEVICE_OFFLINE" }); return; }
          if (!ownerSharingStateSockets.has(owner.socket)) {
            send(socket, {
              type: "device_sharing_state",
              device_id: deviceId,
              screen: false,
              camera: false,
            });
            console.info(JSON.stringify({
              source: "backend",
              event: "create-session-waiting",
              deviceId,
              result: "OWNER_SHARING_STATE_UNCONFIRMED",
            }));
            return;
          }
          const sessionId = randomUUID();
          console.info(JSON.stringify({
            source: "backend",
            event: "create-session-accepted",
            deviceId,
            sessionId,
            sharingState: { screen: true, camera: shareStates.get(deviceId)?.camera ?? false },
            result: "session_created",
          }));
          const session = {
            id: sessionId,
            owner,
            viewer: connection,
            ownerUserId: owner.userId,
            deviceId,
            viewerUserId: connection.userId,
            requests: new Map<string, "screen" | "camera">(),
            sleepEpoch: 0,
          };
          try {
            authorization.bindAuthorizedSession(
              session.ownerUserId,
              session.deviceId,
              session.viewerUserId,
              session.id,
            );
          } catch (error) {
            if (error instanceof AuthorizationError) {
              send(socket, { type: "error", code: "NOT_AUTHORIZED" });
              return;
            }
            const capacityExhausted = error instanceof Error &&
              error.message.includes("PRESENCE_REVOCATION_CAPACITY_EXHAUSTED");
            if (capacityExhausted) {
              console.warn(JSON.stringify({
                source: "backend",
                event: "presence_revocation_capacity_exhausted",
                capacity: MAX_PRESENCE_REVOCATION_RECORDS,
                remediation: "acknowledge pending revocations or reduce active authorized relationships",
              }));
              send(socket, { type: "error", code: "PRESENCE_CAPACITY_EXHAUSTED" });
            } else {
              console.error(JSON.stringify({
                source: "backend",
                event: "presence_authorization_binding_failed",
                error: error instanceof Error ? error.message : "unknown error",
              }));
              send(socket, { type: "error", code: "SERVER_ERROR" });
            }
            return;
          }
          sessions.set(sessionId, session); sessionByDevice.set(deviceId, sessionId);
          send(socket, {
            type: "device_sharing_state",
            device_id: deviceId,
            ...currentSharingState,
          });
          send(socket, {
            type: "session_created",
            session_id: sessionId,
            device_id: deviceId,
            ...(message.request_id === undefined ? {} : { request_id: message.request_id }),
          });
          send(owner.socket, { type: "viewer_joined", session_id: sessionId, viewer_user_id: connection.userId });
          console.info(JSON.stringify({
            source: "backend",
            event: "session-created",
            deviceId,
            sessionId,
            ownerAttached: true,
            viewerAttached: true,
          }));
        } else if (type === "create_session") {
          send(socket, { type: "error", code: "WRONG_ROLE" });
        } else if (type === "prepare_sleep") {
          const session = sessions.get(message.session_id);
          if (
            !session || session.owner?.socket !== socket || !session.viewer ||
            !shareStates.get(session.deviceId)?.screen
          ) {
            send(socket, {
              type: "error",
              code: "SLEEP_NOT_ALLOWED",
              session_id: message.session_id,
              request_id: message.request_id,
            });
            return;
          }
          if (session.sleepCapabilities) {
            if (session.sleepRequestId !== message.request_id) {
              send(socket, { type: "error", code: "SLEEP_ALREADY_PREPARED" }); return;
            }
          } else {
            session.sleepEpoch += 1;
            const capabilities = resumeStore.create(
              session.id,
              session.ownerUserId,
              session.viewerUserId,
              Date.now(),
              SLEEP_RESUME_WINDOW_MS,
              session.sleepEpoch,
              session.deviceId,
            );
            session.sleepRequestId = message.request_id;
            session.sleepCapabilities = {
              owner: capabilities.owner,
              viewer: capabilities.viewer,
              epoch: capabilities.epoch,
              expiresAt: capabilities.expiresAt,
            };
            session.sleepTimer = setTimeout(
              () => endSession(session.id, "sleep_expired"),
              SLEEP_RESUME_WINDOW_MS,
            );
            session.sleepTimer.unref();
          }
          const sleep = session.sleepCapabilities!;
          send(socket, {
            type: "sleep_marked",
            session_id: session.id,
            epoch: sleep.epoch,
            capability: sleep.owner,
            expires_at: sleep.expiresAt,
            request_id: message.request_id,
          });
          if (session.viewer) send(session.viewer.socket, {
            type: "sleep_marked",
            session_id: session.id,
            epoch: sleep.epoch,
            capability: sleep.viewer,
            expires_at: sleep.expiresAt,
            request_id: message.request_id,
          });
        } else if (type === "resume_status" || type === "resume_session") {
          const session = sessions.get(message.session_id);
          const role = session && connection.role === "owner" &&
            connection.deviceId === session.deviceId
            ? "owner"
            : session && connection.role === "viewer" &&
              connection.userId === session.viewerUserId
              ? "viewer"
              : undefined;
          if (type === "resume_status") {
            const status = resumeStore.status(
              message.session_id,
              role ?? (connection.role === "owner" ? "owner" : "viewer"),
              connection.userId,
              message.epoch,
              message.request_id,
              Date.now(),
              connection.deviceId,
            );
            send(socket, {
              type: "resume_status",
              session_id: message.session_id,
              epoch: message.epoch,
              request_id: message.request_id,
              status: status.status,
              ...("capability" in status
                ? { capability: status.capability, expires_at: status.expiresAt }
                : {}),
            });
            return;
          }
          if (
            !session || !role || !session.sleepCapabilities ||
            session.sleepCapabilities.epoch !== message.epoch ||
            !resumeStore.isActive(session.id, message.epoch, Date.now())
          ) {
            send(socket, { type: "error", code: "RESUME_INVALID" }); return;
          }
          const rotated = resumeStore.rotate(
            session.id,
            role,
            connection.userId,
            message.capability,
            message.request_id,
            Date.now(),
          );
          if (!rotated) {
            send(socket, { type: "error", code: "RESUME_INVALID" }); return;
          }
          if (role === "owner") session.owner = connection;
          else session.viewer = connection;
          send(socket, {
            type: "resume_pending",
            session_id: session.id,
            epoch: rotated.epoch,
            capability: rotated.capability,
            expires_at: rotated.expiresAt,
            request_id: message.request_id,
          });
          if (rotated.bothReady && session.owner && session.viewer) {
            if (session.sleepTimer) clearTimeout(session.sleepTimer);
            session.sleepTimer = undefined;
            resumeStore.complete(session.id, Date.now());
            session.sleepCapabilities = undefined;
            session.sleepRequestId = undefined;
            send(session.owner.socket, { type: "session_resumed", session_id: session.id, epoch: rotated.epoch });
            send(session.viewer.socket, { type: "session_resumed", session_id: session.id, epoch: rotated.epoch });
          }
        } else if (type === "retire_session" || type === "retire_session_ack" || type === "leave_session" || type === "offer" || type === "answer" || type === "ice_candidate" || type === "share_request" || type === "share_request_cancel" || type === "share_request_decision") {
          const sessionId = message.session_id;
          if (type === "retire_session_ack") {
            if (connection.role !== "owner") {
              send(socket, { type: "error", code: "WRONG_ROLE" });
              return;
            }
            if (
              connection.deviceId &&
              latestOwnerSockets.get(connection.deviceId) === socket &&
              message.outcome === "authorization_revoked"
            ) {
              clearRevocationTombstone(sessionId, connection.userId, connection.deviceId);
            }
            return;
          }
          const session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
          if (type === "retire_session" && !session) {
            if (connection.role !== "owner") {
              send(socket, { type: "error", code: "WRONG_ROLE" });
              return;
            }
            const tombstone = getRevocationTombstone(sessionId);
            if (tombstone &&
              tombstone.ownerUserId === connection.userId &&
              tombstone.deviceId === connection.deviceId) {
              send(socket, {
                type: "session_retired",
                session_id: sessionId,
                outcome: "authorization_revoked",
              });
              return;
            }
            send(socket, { type: "session_retired", session_id: sessionId, outcome: "not_found" });
            return;
          }
          if (!session || (session.owner?.socket !== socket && session.viewer?.socket !== socket)) {
            send(socket, { type: "error", code: "NOT_AUTHORIZED" }); return;
          }
          if (type === "retire_session" && session.owner?.socket !== socket) {
            send(socket, { type: "error", code: "WRONG_ROLE" });
            return;
          }
          if (!authorization.canAccess(session.ownerUserId, session.viewerUserId)) {
            authorization.revoke(session.ownerUserId, session.viewerUserId);
            return;
          }
          if (type === "retire_session") {
            endSession(session.id, "recovery_timeout", true, "temporary_disconnect");
            send(socket, { type: "session_retired", session_id: session.id, outcome: "retired" });
            return;
          }
          if (type === "leave_session") {
            const preserveSharingState =
              session.viewer?.socket === socket &&
              session.owner !== undefined &&
              shareStates.get(session.deviceId)?.screen === true;
            endSession(session.id, "closed", preserveSharingState);
            return;
          }
          if (type === "offer" || type === "answer" || type === "ice_candidate") {
            const permitted =
              type === "ice_candidate" ||
              (type === "offer" && session.owner?.socket === socket) ||
              (type === "answer" && session.viewer?.socket === socket);
            if (!permitted) {
              send(socket, { type: "error", code: "WRONG_ROLE" });
              return;
            }
            const peer = session.owner?.socket === socket ? session.viewer?.socket : session.owner?.socket;
            if (!peer) return;
            const sent = send(peer, message);
            const messageType = type === "offer" ? "offer_relayed" :
              type === "answer" ? "answer_relayed" : "ice_candidate_relayed";
            console.info(JSON.stringify({
              source: "backend",
              event: messageType,
              timestamp: new Date().toISOString(),
              deviceId: session.deviceId,
              sessionId: session.id,
              negotiationId: message.negotiation_id,
              socketConnectionGeneration: socketConnectionGenerations.get(socket),
              recipientSocketConnectionGeneration: socketConnectionGenerations.get(peer),
              messageType: type,
              ...(type === "ice_candidate"
                ? { candidateType: candidateTypeFromCandidate(message.candidate) }
                : {}),
              sent,
            }));
          } else if (type === "share_request" && session.viewer?.socket === socket) {
            if (session.requests.has(message.request_id)) {
              send(socket, { type: "error", code: "REQUEST_EXISTS" }); return;
            }
            session.requests.set(message.request_id, message.kind);
            if (session.owner) send(session.owner.socket, { type: "share_request", session_id: sessionId, request_id: message.request_id, kind: message.kind, viewer_user_id: connection.userId });
          } else if (type === "share_request_cancel" && session.viewer?.socket === socket) {
            if (session.owner) send(session.owner.socket, message);
            const kind = session.requests.get(message.request_id);
            session.requests.delete(message.request_id);
            if (kind && session.viewer) send(session.viewer.socket, { type: "share_request_state", session_id: sessionId, request_id: message.request_id, kind, state: "CANCELLED" });
          } else if (type === "share_request_decision" && session.owner?.socket === socket) {
            const kind = session.requests.get(message.request_id);
            if (!kind) { send(socket, { type: "error", code: "REQUEST_NOT_FOUND" }); return; }
            session.requests.delete(message.request_id);
            if (session.viewer) send(session.viewer.socket, { type: "share_request_state", session_id: sessionId, request_id: message.request_id, kind, state: message.decision === "allow" ? "ALLOWED" : "DENIED" });
          }
      }
    });

    socket.on("close", (code) => {
      clearTimeout(authTimer);
      if (connectionId) {
        sockets.delete(connectionId);
        presence.disconnect(connectionId);
      }
      const connection = connections.get(socket);
      if (connection) {
        const affectedSessionIds = [...sessions.values()]
          .filter((session) => session.owner?.socket === socket || session.viewer?.socket === socket)
          .map((session) => session.id);
        const sleepContinuityActive = connection.role === "owner" && [...sessions.values()].some(
          (session) =>
            session.owner?.socket === socket &&
            session.sleepCapabilities !== undefined &&
            session.sleepCapabilities.expiresAt > Date.now(),
        );
        let ownerSessionRecoverable = false;
        let ownerSessionEnded = false;
        for (const [id, session] of [...sessions]) {
          if (session.owner?.socket === socket) {
            if (code === 1008) {
              endSession(id, "disconnected");
              ownerSessionEnded = true;
            } else if (session.sleepCapabilities && session.sleepCapabilities.expiresAt > Date.now()) {
              resumeStore.markDisconnected(session.id, "owner");
              session.owner = undefined;
            } else {
              session.owner = undefined;
              ownerSessionRecoverable = true;
              console.info(JSON.stringify({
                source: "backend",
                event: "owner-session-recovery-started",
                timestamp: new Date().toISOString(),
                deviceId: session.deviceId,
                sessionId: session.id,
                recoveryGraceMs: networkRecoveryGraceMs,
              }));
              if (!session.ownerGraceTimer) {
                session.ownerGraceExpiresAt = Date.now() + networkRecoveryGraceMs;
                session.ownerGraceTimer = setTimeout(
                  () => endSession(id, "recovery_timeout"),
                  Math.max(0, session.ownerGraceExpiresAt - Date.now()),
                );
                session.ownerGraceTimer.unref();
              }
            }
          } else if (session.viewer?.socket === socket) {
            if (session.sleepCapabilities && session.sleepCapabilities.expiresAt > Date.now()) {
              resumeStore.markDisconnected(session.id, "viewer");
              session.viewer = undefined;
            } else {
              session.viewer = undefined;
              if (session.owner) {
                send(session.owner.socket, {
                  type: "viewer_left",
                  session_id: session.id,
                  viewer_user_id: session.viewerUserId,
                  reason: "temporary_disconnect",
                });
              }
              if (!session.viewerGraceTimer) {
                session.viewerGraceTimer = setTimeout(
                  () => endSession(
                    id,
                    "viewer_grace_expired",
                    Boolean(session.owner),
                  ),
                  networkRecoveryGraceMs,
                );
                session.viewerGraceTimer.unref();
              }
            }
          }
        }
        const replacementOwnerConnected = connection.role === "owner" && connection.deviceId &&
          [...connections.values()].some(
            (candidate) =>
              candidate.role === "owner" &&
              candidate.deviceId === connection.deviceId &&
              candidate.socket !== socket &&
              candidate.socket.readyState === WebSocket.OPEN,
          );
        const ownerSessionPreserved = !ownerSessionEnded &&
          (ownerSessionRecoverable || sleepContinuityActive || Boolean(replacementOwnerConnected));
        if (connection.role === "owner") {
          console.info(JSON.stringify({
            source: "backend",
            event: "owner-socket-disconnected",
            timestamp: new Date().toISOString(),
            deviceId: connection.deviceId,
            sessionIds: affectedSessionIds,
            closeCode: code,
            closeReasonCategory: closeReasonCategory(code),
            socketConnectionGeneration: socketConnectionGenerations.get(socket),
            replacementSocketExists: Boolean(replacementOwnerConnected),
            sessionPreserved: ownerSessionPreserved,
            sessionEnded: ownerSessionEnded,
          }));
        }
        if (
          connection.role === "owner" &&
          connection.deviceId &&
          !sleepContinuityActive &&
          !ownerSessionRecoverable &&
          !replacementOwnerConnected
        ) {
          const inactive = { screen: false, camera: false };
          const previous = shareStates.get(connection.deviceId);
          setSharingState(
            connection.deviceId,
            inactive,
            "owner-socket-disconnected",
            socket,
            affectedSessionIds[0],
          );
          if (previous?.screen || previous?.camera) {
            notifyAuthorizedViewers(connection.userId, connection.deviceId, inactive);
          }
          console.info(JSON.stringify({
            source: "backend",
            event: "owner-disconnected-sharing-cleared",
            timestamp: new Date().toISOString(),
            deviceId: connection.deviceId,
            sessionIds: affectedSessionIds,
            closeCode: code,
            closeReasonCategory: closeReasonCategory(code),
            socketConnectionGeneration: socketConnectionGenerations.get(socket),
            replacementSocketExists: Boolean(replacementOwnerConnected),
            sessionPreserved: ownerSessionPreserved,
            sessionEnded: ownerSessionEnded,
            reason: "owner-socket-disconnected",
            sharingState: inactive,
          }));
        }
        console.info(JSON.stringify({
          source: "backend",
          event: "signaling-socket-closed",
          role: connection.role,
          ...(connection.deviceId ? { deviceId: connection.deviceId } : {}),
          sessionIds: affectedSessionIds,
          closeCode: code,
          closeReasonCategory: closeReasonCategory(code),
          socketConnectionGeneration: socketConnectionGenerations.get(socket),
        }));
        if (
          connection.role === "owner" &&
          connection.deviceId &&
          latestOwnerSockets.get(connection.deviceId) === socket
        ) {
          latestOwnerSockets.delete(connection.deviceId);
        }
        connections.delete(socket);
      }
    });
    socket.on("error", () => {
      socket.close();
    });
  };

  presence.setConnectionCloser(closeConnection);
  webSocketServer.on("connection", (socket, request) => onConnection(socket, request));
  app.server.on("upgrade", upgrade);
  webSocketServer.on("close", () => {
    serverClosing = true;
  });
  app.addHook("onClose", async () => {
    if (serverClosing) {
      return;
    }
    serverClosing = true;
    app.server.off("upgrade", upgrade);
    for (const session of sessions.values()) {
      if (session.ownerGraceTimer) clearTimeout(session.ownerGraceTimer);
      if (session.viewerGraceTimer) clearTimeout(session.viewerGraceTimer);
      if (session.sleepTimer) clearTimeout(session.sleepTimer);
    }

    for (const socket of webSocketServer.clients) {
      if (socket.readyState === WebSocket.OPEN) socket.close(1001, "server shutting down");
    }
    webSocketServer.close();
    presence.close();
  });
}
