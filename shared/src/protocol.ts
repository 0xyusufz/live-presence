export type MediaKind = "screen" | "camera";
export type SessionRole = "owner" | "viewer";
export type TrackMapEntry = { mid: string; kind: MediaKind };
export type TrackMap = [TrackMapEntry, TrackMapEntry];

export type ClientMessage =
  | { type: "auth"; token: string }
  | { type: "heartbeat" }
  | { type: "create_session"; device_id: string }
  | { type: "leave_session"; session_id: string }
  | { type: "offer" | "answer"; session_id: string; sdp: string; track_map?: TrackMap }
  | { type: "ice_candidate"; session_id: string; candidate: unknown }
  | { type: "share_request"; session_id: string; request_id: string; kind: MediaKind }
  | { type: "share_request_cancel"; session_id: string; request_id: string }
  | { type: "share_request_decision"; session_id: string; request_id: string; decision: "allow" | "deny" };

export type ServerMessage =
  | { type: "authenticated"; role: SessionRole; device_id?: string }
  | { type: "session_created"; session_id: string; device_id: string }
  | { type: "viewer_joined"; session_id: string; viewer_user_id: string }
  | { type: "viewer_left"; session_id: string; viewer_user_id: string; reason: string }
  | { type: "share_request"; session_id: string; request_id: string; kind: MediaKind; viewer_user_id: string }
  | { type: "share_request_cancel"; session_id: string; request_id: string }
  | { type: "share_request_state"; session_id: string; request_id: string; kind: MediaKind; state: "ALLOWED" | "DENIED" | "CANCELLED" }
  | { type: "error"; code: string }
  | { type: "offer" | "answer"; session_id: string; sdp: string; track_map?: TrackMap }
  | { type: "ice_candidate"; session_id: string; candidate: unknown };

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SESSION_ID = /^[0-9a-f-]{36}$/i;
const DEVICE_ID = SESSION_ID;
const MAX_SDP = 64 * 1024;
const MAX_CANDIDATE = 32 * 1024;

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
    case "create_session": return string(item.device_id, 128) && DEVICE_ID.test(item.device_id)
      ? { type: "create_session", device_id: item.device_id } : null;
    case "leave_session": return validSession(item.session_id)
      ? { type: "leave_session", session_id: item.session_id } : null;
    case "offer":
    case "answer":
      return validSession(item.session_id) && string(item.sdp, MAX_SDP) &&
        item.sdp.length <= MAX_SDP && validTrackMap(item.track_map)
        ? { type: item.type, session_id: item.session_id, sdp: item.sdp, ...(item.track_map === undefined ? {} : { track_map: item.track_map }) } : null;
    case "ice_candidate":
      return validSession(item.session_id) && record(item.candidate) !== null &&
        JSON.stringify(item.candidate).length <= MAX_CANDIDATE
        ? { type: "ice_candidate", session_id: item.session_id, candidate: item.candidate } : null;
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
      case "authenticated":
        return exactKeys(item, item.device_id === undefined ? ["type", "role"] : ["type", "role", "device_id"]) &&
          (item.role === "owner" || item.role === "viewer") &&
          (item.device_id === undefined || string(item.device_id, 128))
          ? { type: "authenticated", role: item.role, ...(item.device_id === undefined ? {} : { device_id: item.device_id }) }
          : null;
      case "session_created":
        return exactKeys(item, ["type", "session_id", "device_id"]) &&
          validSession(session) && string(item.device_id, 128) && DEVICE_ID.test(item.device_id)
          ? { type: "session_created", session_id: session, device_id: item.device_id } : null;
      case "viewer_joined":
        return exactKeys(item, ["type", "session_id", "viewer_user_id"]) &&
          validSession(session) && string(item.viewer_user_id, 128)
          ? { type: "viewer_joined", session_id: session, viewer_user_id: item.viewer_user_id } : null;
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
        return exactKeys(item, ["type", "code"]) && string(item.code, 128) ? { type: "error", code: item.code } : null;
      case "offer":
      case "answer":
        return exactKeys(item, item.track_map === undefined ? ["type", "session_id", "sdp"] : ["type", "session_id", "sdp", "track_map"]) &&
          validSession(session) && string(item.sdp, MAX_SDP) && validTrackMap(item.track_map)
          ? { type: item.type, session_id: session, sdp: item.sdp, ...(item.track_map === undefined ? {} : { track_map: item.track_map }) } : null;
      case "ice_candidate":
        return exactKeys(item, ["type", "session_id", "candidate"]) &&
          validSession(session) && record(item.candidate) !== null &&
          JSON.stringify(item.candidate).length <= MAX_CANDIDATE
          ? { type: "ice_candidate", session_id: session, candidate: item.candidate } : null;
      default:
        return null;
  }
}
