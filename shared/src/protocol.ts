export type MediaKind = "screen" | "camera";
export type SessionRole = "owner" | "viewer";
export type TrackMapEntry = { mid: string; kind: MediaKind };
export type TrackMap = [TrackMapEntry, TrackMapEntry];

export type ClientMessage =
  | { type: "auth"; token: string }
  | { type: "heartbeat" }
  | { type: "sharing_state"; screen: boolean; camera: boolean }
  | { type: "create_session"; device_id: string; active_session_id?: string; request_id?: string }
  | { type: "retire_session"; session_id: string }
  | { type: "retire_session_ack"; session_id: string; outcome: "retired" | "authorization_revoked" }
  | { type: "leave_session"; session_id: string }
  | { type: "prepare_sleep"; session_id: string; request_id: string }
  | { type: "resume_session"; session_id: string; epoch: number; capability: string; request_id: string }
  | { type: "resume_status"; session_id: string; epoch: number; request_id: string }
  | { type: "offer"; session_id: string; negotiation_id: string; sdp: string; track_map?: TrackMap }
  | { type: "answer"; session_id: string; negotiation_id: string; sdp: string; track_map?: TrackMap }
  | { type: "ice_candidate"; session_id: string; negotiation_id: string; candidate: unknown }
  | { type: "share_request"; session_id: string; request_id: string; kind: MediaKind }
  | { type: "share_request_cancel"; session_id: string; request_id: string }
  | { type: "share_request_decision"; session_id: string; request_id: string; decision: "allow" | "deny" };

export type ServerMessage =
  | { type: "authenticated"; role: SessionRole; device_id?: string }
  | { type: "heartbeat_ack" }
  | { type: "session_retired"; session_id: string; outcome: "retired" | "not_found" | "authorization_revoked" }
  | { type: "sharing_state_updated"; device_id: string; screen: boolean; camera: boolean; session_id?: string }
  | { type: "device_sharing_state"; device_id: string; screen: boolean; camera: boolean }
  | { type: "sleep_marked"; session_id: string; epoch: number; capability: string; expires_at: number; request_id: string }
  | { type: "resume_pending"; session_id: string; epoch: number; capability: string; expires_at: number; request_id: string }
  | {
    type: "resume_status";
    session_id: string;
    epoch: number;
    request_id: string;
    status: "retryable" | "pending" | "completed" | "expired" | "invalid";
    capability?: string;
    expires_at?: number;
  }
  | { type: "session_resumed"; session_id: string; epoch: number }
  | { type: "session_recovery"; session_id: string; recovery_attempt_id?: string }
  | { type: "session_created"; session_id: string; device_id: string; request_id?: string }
  | {
    type: "session_attached";
    session_id: string;
    device_id: string;
    screen: boolean;
    camera: boolean;
    owner_recovery_remaining_ms?: number;
    request_id?: string;
  }
  | { type: "viewer_joined"; session_id: string; viewer_user_id: string }
  | { type: "viewer_rejoined"; session_id: string; viewer_user_id: string }
  | { type: "viewer_left"; session_id: string; viewer_user_id: string; reason: string }
  | { type: "share_request"; session_id: string; request_id: string; kind: MediaKind; viewer_user_id: string }
  | { type: "share_request_cancel"; session_id: string; request_id: string }
  | { type: "share_request_state"; session_id: string; request_id: string; kind: MediaKind; state: "ALLOWED" | "DENIED" | "CANCELLED" }
  | { type: "error"; code: string; session_id?: string; request_id?: string }
  | { type: "offer"; session_id: string; negotiation_id: string; sdp: string; track_map?: TrackMap }
  | { type: "answer"; session_id: string; negotiation_id: string; sdp: string; track_map?: TrackMap }
  | { type: "ice_candidate"; session_id: string; negotiation_id: string; candidate: unknown };

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SESSION_ID = /^[0-9a-f-]{36}$/i;
const DEVICE_ID = SESSION_ID;
const MAX_SDP = 64 * 1024;
const MAX_CANDIDATE = 32 * 1024;
const MAX_CAPABILITY = 256;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function string(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
function validSession(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID.test(value);
}
function exactKeys(item: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(item).every((key) => allowed.has(key)) && keys.every((key) => key in item);
}
export function validTrackMap(value: unknown): value is TrackMap {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length !== 2) return false;
  const entries = value as unknown[];
  if (entries[0] === entries[1]) return false;
  return entries.every((entry) => {
    const item = record(entry);
    return item !== null && string(item.mid, 32) && (item.kind === "screen" || item.kind === "camera");
  }) && entries[0] !== undefined && entries[1] !== undefined
    && (entries[0] as Record<string, unknown>).kind === "screen"
    && (entries[1] as Record<string, unknown>).kind === "camera"
    && new Set(entries.map((entry) => (entry as Record<string, unknown>).mid)).size === 2
    && new Set(entries.map((entry) => (entry as Record<string, unknown>).kind)).size === 2;
}

export function parseClientMessage(value: unknown): ClientMessage | null {
  const item = record(value);
  if (!item || typeof item.type !== "string") return null;
  switch (item.type) {
    case "auth": return string(item.token, 512) ? { type: "auth", token: item.token } : null;
    case "heartbeat": return Object.keys(item).length === 1 ? { type: "heartbeat" } : null;
    case "sharing_state":
      return exactKeys(item, ["type", "screen", "camera"]) &&
        typeof item.screen === "boolean" && typeof item.camera === "boolean" &&
        (!item.camera || item.screen)
        ? { type: "sharing_state", screen: item.screen, camera: item.camera } : null;
    case "create_session":
      return exactKeys(
        item,
        [
          "type",
          "device_id",
          ...(item.active_session_id === undefined ? [] : ["active_session_id"]),
          ...(item.request_id === undefined ? [] : ["request_id"]),
        ],
      ) &&
        string(item.device_id, 128) && DEVICE_ID.test(item.device_id) &&
        (item.active_session_id === undefined || validSession(item.active_session_id)) &&
        (item.request_id === undefined || (string(item.request_id, 128) && ID.test(item.request_id)))
        ? {
          type: "create_session",
          device_id: item.device_id,
          ...(item.active_session_id === undefined ? {} : { active_session_id: item.active_session_id }),
          ...(item.request_id === undefined ? {} : { request_id: item.request_id }),
        }
        : null;
    case "retire_session":
      return exactKeys(item, ["type", "session_id"]) && validSession(item.session_id)
        ? { type: "retire_session", session_id: item.session_id }
        : null;
    case "retire_session_ack":
      return exactKeys(item, ["type", "session_id", "outcome"]) &&
        validSession(item.session_id) &&
        (item.outcome === "retired" || item.outcome === "authorization_revoked")
        ? { type: "retire_session_ack", session_id: item.session_id, outcome: item.outcome }
        : null;
    case "leave_session":
      return exactKeys(item, ["type", "session_id"]) && validSession(item.session_id)
        ? { type: item.type, session_id: item.session_id }
        : null;
    case "prepare_sleep":
      return exactKeys(item, ["type", "session_id", "request_id"]) &&
        validSession(item.session_id) && string(item.request_id, 128) && ID.test(item.request_id)
        ? { type: "prepare_sleep", session_id: item.session_id, request_id: item.request_id } : null;
    case "resume_session":
      return exactKeys(item, ["type", "session_id", "epoch", "capability", "request_id"]) &&
        validSession(item.session_id) && Number.isSafeInteger(item.epoch) && (item.epoch as number) > 0 &&
        string(item.capability, MAX_CAPABILITY) && string(item.request_id, 128) && ID.test(item.request_id)
        ? { type: "resume_session", session_id: item.session_id, epoch: item.epoch as number, capability: item.capability, request_id: item.request_id } : null;
    case "resume_status":
      return exactKeys(item, ["type", "session_id", "epoch", "request_id"]) &&
        validSession(item.session_id) && Number.isSafeInteger(item.epoch) && (item.epoch as number) > 0 &&
        string(item.request_id, 128) && ID.test(item.request_id)
        ? { type: "resume_status", session_id: item.session_id, epoch: item.epoch as number, request_id: item.request_id } : null;
    case "offer":
    case "answer":
      return validSession(item.session_id) &&
        string(item.negotiation_id, 128) && ID.test(item.negotiation_id) &&
        string(item.sdp, MAX_SDP) &&
        item.sdp.length <= MAX_SDP && validTrackMap(item.track_map)
        ? {
          type: item.type,
          session_id: item.session_id,
          negotiation_id: item.negotiation_id,
          sdp: item.sdp,
          ...(item.track_map === undefined ? {} : { track_map: item.track_map }),
        } : null;
    case "ice_candidate":
      return validSession(item.session_id) &&
        string(item.negotiation_id, 128) && ID.test(item.negotiation_id) &&
        record(item.candidate) !== null &&
        JSON.stringify(item.candidate).length <= MAX_CANDIDATE
        ? {
          type: "ice_candidate",
          session_id: item.session_id,
          negotiation_id: item.negotiation_id,
          candidate: item.candidate,
        } : null;
    case "share_request":
      return validSession(item.session_id) && string(item.request_id, 128) && ID.test(item.request_id) &&
        (item.kind === "screen" || item.kind === "camera")
        ? { type: "share_request", session_id: item.session_id, request_id: item.request_id, kind: item.kind } : null;
    case "share_request_cancel":
      return validSession(item.session_id) && string(item.request_id, 128) && ID.test(item.request_id)
        ? { type: "share_request_cancel", session_id: item.session_id, request_id: item.request_id } : null;
    case "share_request_decision":
      return validSession(item.session_id) && string(item.request_id, 128) && ID.test(item.request_id) &&
        (item.decision === "allow" || item.decision === "deny")
        ? { type: "share_request_decision", session_id: item.session_id, request_id: item.request_id, decision: item.decision } : null;
    default: return null;
  }
}

export function parseServerMessage(value: unknown): ServerMessage | null {
    const item = record(value);
    if (!item || typeof item.type !== "string") return null;
    const session = item.session_id;
    switch (item.type) {
      case "heartbeat_ack":
        return exactKeys(item, ["type"]) ? { type: "heartbeat_ack" } : null;
      case "session_retired":
        return exactKeys(item, ["type", "session_id", "outcome"]) &&
          validSession(session) &&
          (item.outcome === "retired" || item.outcome === "not_found" || item.outcome === "authorization_revoked")
          ? { type: "session_retired", session_id: session, outcome: item.outcome }
          : null;
      case "authenticated":
        return exactKeys(item, item.device_id === undefined ? ["type", "role"] : ["type", "role", "device_id"]) &&
          (item.role === "owner" || item.role === "viewer") &&
          (item.device_id === undefined || string(item.device_id, 128))
          ? { type: "authenticated", role: item.role, ...(item.device_id === undefined ? {} : { device_id: item.device_id }) }
          : null;
      case "sharing_state_updated":
      case "device_sharing_state":
        return exactKeys(
          item,
          item.session_id === undefined
            ? ["type", "device_id", "screen", "camera"]
            : ["type", "device_id", "screen", "camera", "session_id"],
        ) &&
          string(item.device_id, 128) && DEVICE_ID.test(item.device_id) &&
          typeof item.screen === "boolean" && typeof item.camera === "boolean" &&
          (item.session_id === undefined || validSession(item.session_id)) &&
          (!item.camera || item.screen)
          ? {
            type: item.type,
            device_id: item.device_id,
            screen: item.screen,
            camera: item.camera,
            ...(item.session_id === undefined ? {} : { session_id: item.session_id }),
          }
          : null;
      case "sleep_marked":
      case "resume_pending":
        return exactKeys(item, ["type", "session_id", "epoch", "capability", "expires_at", "request_id"]) &&
          validSession(session) && Number.isSafeInteger(item.epoch) && (item.epoch as number) > 0 &&
          string(item.capability, MAX_CAPABILITY) && Number.isSafeInteger(item.expires_at) &&
          (item.expires_at as number) > 0 && string(item.request_id, 128) && ID.test(item.request_id)
          ? { type: item.type, session_id: session, epoch: item.epoch as number, capability: item.capability, expires_at: item.expires_at as number, request_id: item.request_id }
          : null;
      case "session_resumed":
        return exactKeys(item, ["type", "session_id", "epoch"]) &&
          validSession(session) && Number.isSafeInteger(item.epoch) && (item.epoch as number) > 0
          ? { type: "session_resumed", session_id: session, epoch: item.epoch as number }
          : null;
      case "resume_status":
        return exactKeys(
          item,
          item.capability === undefined
            ? ["type", "session_id", "epoch", "request_id", "status"]
            : ["type", "session_id", "epoch", "request_id", "status", "capability", "expires_at"],
        ) &&
          validSession(session) &&
          Number.isSafeInteger(item.epoch) && (item.epoch as number) > 0 &&
          string(item.request_id, 128) && ID.test(item.request_id) &&
          (item.status === "retryable" || item.status === "pending" ||
            item.status === "completed" || item.status === "expired" || item.status === "invalid") &&
          (item.capability === undefined ||
            (string(item.capability, MAX_CAPABILITY) && Number.isSafeInteger(item.expires_at) && (item.expires_at as number) > 0))
          ? {
            type: "resume_status",
            session_id: session,
            epoch: item.epoch as number,
            request_id: item.request_id,
            status: item.status,
            ...(item.capability === undefined ? {} : { capability: item.capability, expires_at: item.expires_at as number }),
          }
          : null;
      case "session_recovery":
        return exactKeys(
          item,
          item.recovery_attempt_id === undefined
            ? ["type", "session_id"]
            : ["type", "session_id", "recovery_attempt_id"],
        ) && validSession(session) &&
          (item.recovery_attempt_id === undefined ||
            (string(item.recovery_attempt_id, 128) && ID.test(item.recovery_attempt_id)))
          ? {
            type: "session_recovery",
            session_id: session,
            ...(item.recovery_attempt_id === undefined
              ? {}
              : { recovery_attempt_id: item.recovery_attempt_id }),
          }
          : null;
      case "session_created":
        return exactKeys(
          item,
          item.request_id === undefined
            ? ["type", "session_id", "device_id"]
            : ["type", "session_id", "device_id", "request_id"],
        ) &&
          validSession(session) && string(item.device_id, 128) && DEVICE_ID.test(item.device_id) &&
          (item.request_id === undefined || (string(item.request_id, 128) && ID.test(item.request_id)))
          ? {
            type: "session_created",
            session_id: session,
            device_id: item.device_id,
            ...(item.request_id === undefined ? {} : { request_id: item.request_id }),
          } : null;
      case "session_attached":
        return exactKeys(
          item,
          [
            "type",
            "session_id",
            "device_id",
            "screen",
            "camera",
            ...(item.owner_recovery_remaining_ms === undefined ? [] : ["owner_recovery_remaining_ms"]),
            ...(item.request_id === undefined ? [] : ["request_id"]),
          ],
        ) &&
          validSession(session) && string(item.device_id, 128) && DEVICE_ID.test(item.device_id) &&
          typeof item.screen === "boolean" && typeof item.camera === "boolean" &&
          (item.request_id === undefined || (string(item.request_id, 128) && ID.test(item.request_id))) &&
          (item.owner_recovery_remaining_ms === undefined ||
            (Number.isSafeInteger(item.owner_recovery_remaining_ms) && (item.owner_recovery_remaining_ms as number) > 0)) &&
          (!item.camera || item.screen)
          ? {
            type: "session_attached",
            session_id: session,
            device_id: item.device_id,
            screen: item.screen,
            camera: item.camera,
            ...(item.owner_recovery_remaining_ms === undefined
              ? {}
              : { owner_recovery_remaining_ms: item.owner_recovery_remaining_ms as number }),
            ...(item.request_id === undefined ? {} : { request_id: item.request_id }),
          }
          : null;
      case "viewer_joined":
      case "viewer_rejoined":
        return exactKeys(item, ["type", "session_id", "viewer_user_id"]) &&
          validSession(session) && string(item.viewer_user_id, 128)
          ? { type: item.type, session_id: session, viewer_user_id: item.viewer_user_id } : null;
      case "viewer_left":
        return exactKeys(item, ["type", "session_id", "viewer_user_id", "reason"]) &&
          validSession(session) && string(item.viewer_user_id, 128) && string(item.reason, 128)
          ? { type: "viewer_left", session_id: session, viewer_user_id: item.viewer_user_id, reason: item.reason } : null;
      case "share_request":
        return exactKeys(item, ["type", "session_id", "request_id", "kind", "viewer_user_id"]) &&
          validSession(session) && string(item.request_id, 128) && ID.test(item.request_id) &&
          (item.kind === "screen" || item.kind === "camera") && string(item.viewer_user_id, 128)
          ? { type: "share_request", session_id: session, request_id: item.request_id, kind: item.kind, viewer_user_id: item.viewer_user_id } : null;
      case "share_request_cancel":
        return exactKeys(item, ["type", "session_id", "request_id"]) &&
          validSession(session) && string(item.request_id, 128) && ID.test(item.request_id)
          ? { type: "share_request_cancel", session_id: session, request_id: item.request_id } : null;
      case "share_request_state":
        return exactKeys(item, ["type", "session_id", "request_id", "kind", "state"]) &&
          validSession(session) && string(item.request_id, 128) && ID.test(item.request_id) &&
          (item.kind === "screen" || item.kind === "camera") &&
          (item.state === "ALLOWED" || item.state === "DENIED" || item.state === "CANCELLED")
          ? { type: "share_request_state", session_id: session, request_id: item.request_id, kind: item.kind, state: item.state } : null;
      case "error":
        return (
          exactKeys(
            item,
            [
              "type",
              "code",
              ...(item.session_id === undefined ? [] : ["session_id"]),
              ...(item.request_id === undefined ? [] : ["request_id"]),
            ],
          ) &&
          string(item.code, 128) &&
          (item.session_id === undefined || validSession(item.session_id)) &&
          (item.request_id === undefined ||
            (string(item.request_id, 128) && ID.test(item.request_id)))
        )
          ? {
            type: "error",
            code: item.code,
            ...(item.session_id === undefined ? {} : { session_id: item.session_id as string }),
            ...(item.request_id === undefined ? {} : { request_id: item.request_id as string }),
          }
          : null;
      case "offer":
      case "answer":
        return exactKeys(
          item,
          item.track_map === undefined
            ? ["type", "session_id", "negotiation_id", "sdp"]
            : ["type", "session_id", "negotiation_id", "sdp", "track_map"],
        ) &&
          validSession(session) &&
          string(item.negotiation_id, 128) && ID.test(item.negotiation_id) &&
          string(item.sdp, MAX_SDP) && validTrackMap(item.track_map)
          ? {
            type: item.type,
            session_id: session,
            negotiation_id: item.negotiation_id,
            sdp: item.sdp,
            ...(item.track_map === undefined ? {} : { track_map: item.track_map }),
          } : null;
      case "ice_candidate":
        return exactKeys(item, ["type", "session_id", "negotiation_id", "candidate"]) &&
          validSession(session) &&
          string(item.negotiation_id, 128) && ID.test(item.negotiation_id) &&
          record(item.candidate) !== null &&
          JSON.stringify(item.candidate).length <= MAX_CANDIDATE
          ? {
            type: "ice_candidate",
            session_id: session,
            negotiation_id: item.negotiation_id,
            candidate: item.candidate,
          } : null;
      default:
        return null;
  }
}
