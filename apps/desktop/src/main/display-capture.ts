import { BrowserWindow, desktopCapturer, session, type DesktopCapturerSource } from "electron";
import { join } from "node:path";

type PickerItem = { id: string; name: string };

export class DisplayCapturePicker {
  private window: BrowserWindow | undefined;
  private pending: {
    resolve: (source: DesktopCapturerSource | null) => void;
    sources: Map<string, DesktopCapturerSource>;
  } | undefined;

  isPickerContents(contents: Electron.WebContents): boolean {
    return this.window?.webContents === contents;
  }

  install(): void {
    session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
      try {
        const source = await this.choose();
        callback(source ? { video: source } : {});
      } catch {
        callback({});
      }
    });
  }

  async listSources(): Promise<PickerItem[]> {
    if (!this.pending) return [];
    return [...this.pending.sources.values()].map(({ id, name }) => ({ id, name }));
  }

  async chooseSource(sourceId: string): Promise<void> {
    const pending = this.pending;
    if (!pending || !pending.sources.has(sourceId)) return;
    const current = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false,
    });
    if (this.pending !== pending) return;
    const selected = current.find((source) => source.id === sourceId);
    pending.resolve(selected ?? null);
    this.pending = undefined;
    this.closePicker();
  }

  cancel(): void {
    this.pending?.resolve(null);
    this.pending = undefined;
    this.closePicker();
  }

  private async choose(): Promise<DesktopCapturerSource | null> {
    if (this.pending) throw new Error("a source selection is already pending");
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false,
    });
    if (sources.length === 0) return null;
    return new Promise((resolve) => {
      this.pending = { resolve, sources: new Map(sources.map((source) => [source.id, source])) };
      const window = new BrowserWindow({
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
      window.on("closed", () => {
        if (this.window !== window) return;
        this.window = undefined;
        this.pending?.resolve(null);
        this.pending = undefined;
      });
      void window.loadURL("app://bundle/picker").catch(() => this.cancel());
      window.once("ready-to-show", () => window.show());
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
}
