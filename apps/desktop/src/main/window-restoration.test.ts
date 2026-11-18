import assert from "node:assert/strict";
import { test } from "node:test";
import { WindowRestorer, type RestorableWindow } from "./window-restoration.js";

class FakeWindow implements RestorableWindow {
  destroyed = false;
  minimized = false;
  visible = false;
  restoreCount = 0;
  showCount = 0;
  focusCount = 0;

  isDestroyed(): boolean { return this.destroyed; }
  isMinimized(): boolean { return this.minimized; }
  isVisible(): boolean { return this.visible; }
  restore(): void { this.restoreCount += 1; this.minimized = false; }
  show(): void { this.showCount += 1; this.visible = true; }
  focus(): void { this.focusCount += 1; }
}

test("restoration restores a minimized hidden window, shows it, and focuses it", async () => {
  const window = new FakeWindow();
  window.minimized = true;
  window.visible = false;
  const restorer = new WindowRestorer(() => window, async () => new FakeWindow());

  assert.equal(await restorer.restore(), window);
  assert.equal(window.restoreCount, 1);
  assert.equal(window.showCount, 1);
  assert.equal(window.focusCount, 1);
});

test("concurrent restoration requests share one window creation", async () => {
  let resolveCreation!: (window: FakeWindow) => void;
  const creation = new Promise<FakeWindow>((resolve) => { resolveCreation = resolve; });
  let window: FakeWindow | undefined;
  let createCount = 0;
  const restorer = new WindowRestorer(
    () => window,
    () => {
      createCount += 1;
      return creation.then((created) => {
        window = created;
        return created;
      });
    },
  );

  const first = restorer.restore();
  const second = restorer.restore();
  assert.equal(createCount, 1);

  const created = new FakeWindow();
  resolveCreation(created);
  assert.equal(await first, created);
  assert.equal(await second, created);
  assert.equal(created.showCount, 1);
  assert.equal(created.focusCount, 2);
});

test("a destroyed window is replaced", async () => {
  const destroyed = new FakeWindow();
  destroyed.destroyed = true;
  const replacement = new FakeWindow();
  let createCount = 0;
  const restorer = new WindowRestorer(() => destroyed, async () => {
    createCount += 1;
    return replacement;
  });

  assert.equal(await restorer.restore(), replacement);
  assert.equal(createCount, 1);
  assert.equal(replacement.showCount, 1);
  assert.equal(replacement.focusCount, 1);
});
