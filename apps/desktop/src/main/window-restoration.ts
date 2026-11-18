export type RestorableWindow = {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
};

export class WindowRestorer<T extends RestorableWindow> {
  private creation: Promise<T> | undefined;

  constructor(
    private readonly getWindow: () => T | undefined,
    private readonly createWindow: () => Promise<T>,
  ) {}

  async restore(): Promise<T> {
    const creation = this.creation;
    if (creation) {
      const window = await creation;
      this.focus(window);
      return window;
    }

    const existing = this.getWindow();
    if (existing && !existing.isDestroyed()) {
      this.focus(existing);
      return existing;
    }

    const pending = this.createWindow();
    this.creation = pending;
    try {
      const window = await pending;
      this.focus(window);
      return window;
    } finally {
      if (this.creation === pending) this.creation = undefined;
    }
  }

  private focus(window: T): void {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    if (!window.isVisible()) window.show();
    window.focus();
  }
}
