import { BrowserWindow, desktopCapturer, session, type DesktopCapturerSource } from "electron";
import { join } from "node:path";
import { displayMediaSelection, selectedDisplaySource } from "../capture-utils.js";
import { safeCaptureErrorCode } from "./capture-diagnostics.js";
import type { CaptureDiagnosticReason } from "../ipc-contract.js";

type PickerItem = { id: string; name: string };
type PickerWindow = {
  webContents: Electron.WebContents;
  isDestroyed(): boolean;
  close(): void;
  on(event: "closed", listener: () => void): void;
  once(event: "ready-to-show", listener: () => void): void;
  loadURL(url: string): Promise<void>;
  show(): void;
};
type PendingPickerRequest = {
  requestId: number;
  attemptId?: string;
  resolve: (source: DesktopCapturerSource | null) => void;
  sources: Map<string, DesktopCapturerSource>;
};
type DisplayCapturePickerDependencies = {
  getSources: () => Promise<DesktopCapturerSource[]>;
  createWindow: (options: Electron.BrowserWindowConstructorOptions) => PickerWindow;
};
type DisplayCaptureDiagnosticLogger = (
  level: "info" | "warn" | "error",
  event: string,
  details: Record<string, unknown>,
) => void;

export class DisplayCapturePicker {
  private window: PickerWindow | undefined;
  private pending: PendingPickerRequest | undefined;
  private nextRequestId = 1;

  constructor(
    private readonly dependencies: DisplayCapturePickerDependencies = {
      getSources: () => desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false,
      }),
      createWindow: (options) => new BrowserWindow(options),
    },
    private readonly diagnosticLogger: DisplayCaptureDiagnosticLogger = (level, event, details) => {
      console[level](JSON.stringify({
        source: "desktop-main",
        event,
        timestamp: new Date().toISOString(),
        ...details,
      }));
    },
    private readonly getCaptureAttemptId: () => string | undefined = () => undefined,
  ) {}

  isPickerContents(contents: Electron.WebContents): boolean {
    return this.window?.webContents === contents;
  }

  install(): void {
    session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
      const requestId = this.nextRequestId++;
      const attemptId = this.getCaptureAttemptId();
      const identifiers = { requestId, ...(attemptId ? { attemptId } : {}) };
      this.log("info", "display_capture_request_started", identifiers);
      let source: DesktopCapturerSource | null;
      try {
        source = await this.choose(requestId, attemptId);
      } catch (error) {
        this.log("error", "display_capture_source_selection_failed", {
          ...identifiers,
          errorCategory: error instanceof Error && error.message === "a source selection is already pending"
            ? "request_already_pending"
            : "source_selection_failed",
          errorCode: safeCaptureErrorCode(error),
        });
        callback(displayMediaSelection<DesktopCapturerSource>(null));
        return;
      }
      callback(displayMediaSelection<DesktopCapturerSource>(source));
      this.log("info", "display_capture_callback_completed", {
        ...identifiers,
        sourceSelected: source !== null,
        reason: source ? "source_selected" : "cancelled_or_unavailable",
      });
      if (source) this.log("info", "display_capture_source_selected", identifiers);
      else this.log("warn", "display_capture_request_without_source", {
        ...identifiers,
        reason: "cancelled_or_unavailable",
      });
    });
  }

  async listSources(): Promise<PickerItem[]> {
    if (!this.pending) return [];
    return [...this.pending.sources.values()].map(({ id, name }) => ({ id, name }));
  }

  async chooseSource(sourceId: string): Promise<void> {
    const pending = this.pending;
    if (!pending) {
      this.log("warn", "display_capture_selection_ignored", { reason: "no_pending_request" });
      return;
    }
    const selected = selectedDisplaySource(pending.sources, sourceId);
    const selectionEvent = selected ? "display_capture_selection_received" : "display_capture_selection_unavailable";
    this.log(selected ? "info" : "warn", selectionEvent, {
      requestId: pending.requestId,
      ...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
      matchedSource: selected !== null,
      reason: selected ? "source_id_in_snapshot" : "source_id_not_in_snapshot",
    });
    this.resolvePending(pending.requestId, selected, selected ? "selection_accepted" : "selection_rejected");
  }

  cancel(): void {
    const pending = this.pending;
    if (!pending) {
      this.log("warn", "display_capture_selection_cancelled_without_pending", { reason: "no_pending_request" });
      return;
    }
    this.log("info", "display_capture_selection_cancelled", {
      requestId: pending.requestId,
      ...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
      reason: "user_cancelled",
    });
    this.resolvePending(pending.requestId, null, "user_cancelled");
  }

  private choose(
    requestId: number,
    attemptId = this.getCaptureAttemptId(),
  ): Promise<DesktopCapturerSource | null> {
    let resolveSelection!: (source: DesktopCapturerSource | null) => void;
    const selection = new Promise<DesktopCapturerSource | null>((resolve) => {
      resolveSelection = resolve;
    });
    const pending = this.reserveRequest(requestId, resolveSelection, attemptId);
    this.log("info", "display_capture_source_enumeration_started", {
      requestId,
      ...(attemptId ? { attemptId } : {}),
    });
    void this.loadSourcesAndOpenPicker(pending);
    return selection;
  }

  private async loadSourcesAndOpenPicker(pending: PendingPickerRequest): Promise<void> {
    const { requestId } = pending;
    let sources: DesktopCapturerSource[];
    try {
      sources = await this.dependencies.getSources();
    } catch (error) {
      this.log("error", "display_capture_source_enumeration_failed", {
        requestId,
        ...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
        reason: this.isCurrentRequest(pending) ? "enumeration_failed" : "request_no_longer_active",
        errorCategory: "source_enumeration_failed",
        errorCode: safeCaptureErrorCode(error),
      });
      if (!this.isCurrentRequest(pending)) return;
      this.resolvePending(requestId, null, "source_enumeration_failed");
      return;
    }

    this.log("info", "display_capture_source_enumeration_completed", {
      requestId,
      ...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
      sourceCount: sources.length,
      reason: this.isCurrentRequest(pending) ? "request_active" : "request_no_longer_active",
    });
    if (!this.isCurrentRequest(pending)) return;
    if (sources.length === 0) {
      this.log("warn", "display_capture_sources_empty", {
        requestId,
        ...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
        sourceCount: 0,
      });
      this.resolvePending(requestId, null, "sources_empty");
      return;
    }

    pending.sources = new Map(sources.map((source) => [source.id, source]));
    try {
      if (!this.isCurrentRequest(pending)) return;
      const window = this.dependencies.createWindow({
        width: 440,
        height: 480,
        title: "Choose what to share",
        show: false,
        resizable: false,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          preload: this.preloadPath(),
        },
      });
      this.window = window;
      this.log("info", "display_capture_picker_opened", {
        requestId,
        ...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
      });
      window.on("closed", () => {
        if (this.window !== window) return;
        this.window = undefined;
        const pendingRequest = this.pending;
        if (pendingRequest && pendingRequest.requestId === requestId) {
          this.log("info", "display_capture_picker_closed", {
            requestId,
            ...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
            reason: "window_closed",
          });
          this.resolvePending(requestId, null, "picker_closed");
        }
      });
      void window.loadURL("app://bundle/picker").catch((error) => {
        if (this.pending?.requestId !== requestId) {
          this.log("warn", "display_capture_picker_load_failed_ignored", {
            requestId,
            ...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
            reason: "stale_request",
            activeRequestId: this.pending?.requestId ?? null,
          });
          return;
        }
        this.log("error", "display_capture_picker_load_failed", {
          requestId,
          ...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
          errorCategory: "picker_load_failed",
          errorCode: safeCaptureErrorCode(error),
        });
        this.resolvePending(requestId, null, "picker_load_failed");
      });
      window.once("ready-to-show", () => window.show());
    } catch (error) {
      if (!this.isCurrentRequest(pending)) return;
      this.log("error", "display_capture_picker_creation_failed", {
        requestId,
        ...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
        errorCategory: "picker_creation_failed",
        errorCode: safeCaptureErrorCode(error),
      });
      this.resolvePending(requestId, null, "picker_creation_failed");
    }
  }

  private reserveRequest(
    requestId: number,
    resolve: (source: DesktopCapturerSource | null) => void,
    attemptId?: string,
  ): PendingPickerRequest {
    if (this.pending) throw new Error("a source selection is already pending");
    const pending: PendingPickerRequest = {
      requestId,
      ...(attemptId ? { attemptId } : {}),
      resolve,
      sources: new Map(),
    };
    this.pending = pending;
    return pending;
  }

  private isCurrentRequest(pending: PendingPickerRequest): boolean {
    return this.pending === pending;
  }

  private resolvePending(requestId: number, source: DesktopCapturerSource | null, reason: CaptureDiagnosticReason): void {
    const pending = this.pending;
    if (!pending || pending.requestId !== requestId) {
      this.log("warn", "display_capture_selection_skipped", {
        requestId,
        ...(pending?.attemptId ? { attemptId: pending.attemptId } : {}),
        reason,
        activeRequestId: pending?.requestId ?? null,
      });
      return;
    }
    this.pending = undefined;
    this.closePicker();
    pending.resolve(source);
    this.log("info", "display_capture_selection_resolved", {
      requestId,
      ...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
      reason,
      sourceSelected: source !== null,
    });
  }

  private closePicker(): void {
    const window = this.window;
    this.window = undefined;
    if (window && !window.isDestroyed()) window.close();
  }

  private preloadPath(): string {
    return join(__dirname, "preload.js");
  }

  private log(
    level: "info" | "warn" | "error",
    event: string,
    details: Record<string, unknown> = {},
  ): void {
    try {
      this.diagnosticLogger(level, event, details);
    } catch {
      // Capture must continue even if diagnostic output is unavailable.
    }
  }
}
