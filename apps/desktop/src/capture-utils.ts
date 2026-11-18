export type DisplayCaptureSource = { id: string };

export function selectedDisplaySource<T extends DisplayCaptureSource>(
  sources: ReadonlyMap<string, T>,
  sourceId: string,
): T | null {
  return sources.get(sourceId) ?? null;
}

export function displayMediaSelection<T>(
  source: T | null,
): { video: T } | Record<string, never> {
  return source === null ? {} : { video: source };
}

export function displayCaptureFailureMessage(error: unknown): string {
  if (error instanceof Error && error.name === "TypeError" &&
    error.message === "Video was requested, but no video stream was provided") {
    return "Screen capture returned no video stream. Check macOS Screen & System Audio Recording permission and try again.";
  }
  if (error instanceof Error && error.name === "NotAllowedError") {
    return "Screen sharing was canceled or macOS denied screen-capture access.";
  }
  return "Screen sharing was canceled or unavailable.";
}

export function displayCaptureFailureCategory(error: unknown): string {
  if (error instanceof Error && error.name === "TypeError" &&
    error.message === "Video was requested, but no video stream was provided") {
    return "video_stream_not_provided";
  }
  if (error instanceof Error && error.name === "NotAllowedError") return "permission_or_consent_denied";
  if (error instanceof Error && error.name === "NotFoundError") return "no_capture_source";
  if (error instanceof Error && error.name === "AbortError") return "capture_cancelled";
  return "capture_failed";
}
