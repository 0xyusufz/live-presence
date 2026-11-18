export const SIGNALLING_CONNECT_ERROR_PREFIX = "SIGNALLING_CONNECT_DIAGNOSTIC:";

export const SIGNALLING_CONNECT_FAILURE_CATEGORIES = [
  "sender_validation_rejected",
  "transport_initialization_failed",
  "transport_connect_rejected",
  "authenticated_reuse_failed",
  "connection_setup_timeout",
  "device_credential_unavailable",
  "invalid_configuration",
  "socket_hang_up",
  "websocket_closed_before_connection",
  "connection_refused",
  "connection_reset",
  "connection_timed_out",
  "host_resolution_failed",
  "host_unreachable",
  "network_unreachable",
  "connection_write_failed",
] as const;

export type SignalingConnectFailureCategory =
  (typeof SIGNALLING_CONNECT_FAILURE_CATEGORIES)[number];

export type SignalingConnectDiagnosticEvent =
  | "signaling_connect_sender_rejected"
  | "signaling_connect_transport_initialization_failed"
  | "signaling_connect_transport_rejected"
  | "signaling_connect_authenticated_reuse_succeeded";

export type SignalingConnectDiagnostic = {
  event: SignalingConnectDiagnosticEvent;
  correlationId: string | null;
  level: "info" | "warn" | "error";
  connectErrorName?: string;
  connectErrorCategory?: SignalingConnectFailureCategory;
  connectErrorMessage?: string;
};

type HandlerDependencies<Event, Transport> = {
  isSenderAllowed(event: Event): boolean;
  getTransport(): Transport | undefined;
  createTransport(): Transport;
  setTransport(transport: Transport): void;
  isAuthenticatedReuse(transport: Transport): boolean;
  connect(transport: Transport): Promise<number>;
  log(diagnostic: SignalingConnectDiagnostic): void;
};

const CORRELATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ERROR_NAMES = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "AbortError"]);
const SAFE_MESSAGE_CAUSES = new Map<string, {
  category: SignalingConnectFailureCategory;
  message: string;
}>([
  ["signaling connection setup timed out", {
    category: "connection_setup_timeout",
    message: "Signaling connection setup timed out",
  }],
  ["device is not enrolled", {
    category: "device_credential_unavailable",
    message: "Device credential is unavailable",
  }],
  ["invalid URL", {
    category: "invalid_configuration",
    message: "Signaling URL configuration is invalid",
  }],
  ["socket hang up", { category: "socket_hang_up", message: "WebSocket connection closed unexpectedly" }],
  ["websocket was closed before the connection was established", {
    category: "websocket_closed_before_connection",
    message: "WebSocket closed before connection",
  }],
]);
const SAFE_ERROR_CODES = new Map<string, {
  category: SignalingConnectFailureCategory;
  message: string;
}>([
  ["ECONNREFUSED", { category: "connection_refused", message: "Connection was refused" }],
  ["ECONNRESET", { category: "connection_reset", message: "Connection was reset" }],
  ["ETIMEDOUT", { category: "connection_timed_out", message: "Connection timed out" }],
  ["ENOTFOUND", { category: "host_resolution_failed", message: "Host resolution failed" }],
  ["EHOSTUNREACH", { category: "host_unreachable", message: "Host is unreachable" }],
  ["ENETUNREACH", { category: "network_unreachable", message: "Network is unreachable" }],
  ["EPIPE", { category: "connection_write_failed", message: "Connection write failed" }],
]);

export function readSignalingConnectFailureCategory(
  error: unknown,
): SignalingConnectFailureCategory | undefined {
  if (!(error instanceof Error) || !error.message.startsWith(SIGNALLING_CONNECT_ERROR_PREFIX)) {
    return undefined;
  }
  const category = error.message.slice(SIGNALLING_CONNECT_ERROR_PREFIX.length);
  return SIGNALLING_CONNECT_FAILURE_CATEGORIES.includes(
    category as SignalingConnectFailureCategory,
  )
    ? category as SignalingConnectFailureCategory
    : undefined;
}

export function createSignalingConnectHandler<Event, Transport>(
  dependencies: HandlerDependencies<Event, Transport>,
): (event: Event, correlationId: unknown) => Promise<number> {
  return async (event, requestedCorrelationId) => {
    const correlationId =
      typeof requestedCorrelationId === "string" && CORRELATION_ID.test(requestedCorrelationId)
        ? requestedCorrelationId
        : null;

    if (!dependencies.isSenderAllowed(event)) {
      report({
        event: "signaling_connect_sender_rejected",
        correlationId,
        level: "warn",
        connectErrorName: "Error",
        connectErrorCategory: "sender_validation_rejected",
        connectErrorMessage: "Signaling IPC sender validation rejected",
      });
      throw ipcError("sender_validation_rejected");
    }

    let transport: Transport;
    try {
      const currentTransport = dependencies.getTransport();
      if (currentTransport) {
        transport = currentTransport;
      } else {
        transport = dependencies.createTransport();
        dependencies.setTransport(transport);
      }
    } catch (error) {
      const safeDetails = safeErrorDetails(error, "transport_initialization_failed");
      report({
        event: "signaling_connect_transport_initialization_failed",
        correlationId,
        level: "error",
        ...safeDetails,
      });
      throw ipcError(safeDetails.connectErrorCategory);
    }

    let authenticatedReuse = false;
    try {
      authenticatedReuse = dependencies.isAuthenticatedReuse(transport);
      const generation = await dependencies.connect(transport);
      if (authenticatedReuse) {
        report({
          event: "signaling_connect_authenticated_reuse_succeeded",
          correlationId,
          level: "info",
        });
      }
      return generation;
    } catch (error) {
      const defaultCategory = authenticatedReuse
        ? "authenticated_reuse_failed"
        : "transport_connect_rejected";
      const safeDetails = safeErrorDetails(error, defaultCategory);
      report({
        event: "signaling_connect_transport_rejected",
        correlationId,
        level: "error",
        ...safeDetails,
      });
      throw ipcError(safeDetails.connectErrorCategory);
    }

    function report(diagnostic: SignalingConnectDiagnostic): void {
      try {
        dependencies.log(diagnostic);
      } catch {
        // Diagnostics must not change signaling behavior.
      }
    }
  };
}

function ipcError(category: SignalingConnectFailureCategory): Error {
  return new Error(`${SIGNALLING_CONNECT_ERROR_PREFIX}${category}`);
}

function safeErrorDetails(
  error: unknown,
  category: SignalingConnectFailureCategory,
): {
  connectErrorName: string;
  connectErrorCategory: SignalingConnectFailureCategory;
  connectErrorMessage: string;
} {
  let name = "UnknownError";
  let safeCause: { category: SignalingConnectFailureCategory; message: string } | undefined;
  try {
    if (error && typeof error === "object") {
      if ("name" in error && typeof error.name === "string" && ERROR_NAMES.has(error.name)) {
        name = error.name;
      }
      if ("message" in error && typeof error.message === "string") {
        safeCause = SAFE_MESSAGE_CAUSES.get(error.message);
      }
      if (!safeCause && "code" in error && typeof error.code === "string") {
        safeCause = SAFE_ERROR_CODES.get(error.code);
      }
    }
  } catch {
    // Error metadata is untrusted; retain only the fixed fallback category and message.
  }
  const resolvedCategory = safeCause?.category ?? category;
  const message = safeCause?.message ?? (category === "transport_initialization_failed"
    ? "Signaling transport initialization failed"
    : category === "authenticated_reuse_failed"
      ? "Authenticated transport reuse failed"
      : "Signaling transport connection rejected");
  return {
    connectErrorName: name,
    connectErrorCategory: resolvedCategory,
    connectErrorMessage: message,
  };
}
