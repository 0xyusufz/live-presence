import assert from "node:assert/strict";
import { test } from "node:test";
import type { DesktopCapturerSource } from "electron";
import { DisplayCapturePicker } from "./display-capture.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function source(id: string): DesktopCapturerSource {
  return { id, name: id } as DesktopCapturerSource;
}

class FakePickerWindow {
  webContents = {} as Electron.WebContents;
  private closedListeners: Array<() => void> = [];
  private readyListeners: Array<() => void> = [];
  closeCalls = 0;

  isDestroyed(): boolean {
    return false;
  }

  close(): void {
    this.closeCalls += 1;
    for (const listener of this.closedListeners) listener();
  }

  on(_event: "closed", listener: () => void): void {
    this.closedListeners.push(listener);
  }

  once(_event: "ready-to-show", listener: () => void): void {
    this.readyListeners.push(listener);
  }

  loadURL(): Promise<void> {
    return Promise.resolve();
  }

  show(): void {}
}

type PickerTestAccess = {
  choose(requestId: number): Promise<DesktopCapturerSource | null>;
};

function choose(picker: DisplayCapturePicker, requestId: number): Promise<DesktopCapturerSource | null> {
  return (picker as unknown as PickerTestAccess).choose(requestId);
}

function makePickerState() {
  const picker = new DisplayCapturePicker() as any;
  const closeCalls: string[] = [];
  const fakeWindow = {
    isDestroyed: () => false,
    close: () => closeCalls.push("close"),
    webContents: { id: "window" },
  };
  picker.window = fakeWindow;
  return { picker, closeCalls };
}

test("stale source IDs are rejected without leaving a pending request", async () => {
  const { picker, closeCalls } = makePickerState();
  const resolved: Array<{ id: string } | null> = [];
  picker.pending = {
    requestId: 4,
    resolve: (value: { id: string } | null) => resolved.push(value),
    sources: new Map([["screen:1", { id: "screen:1" }]]),
  };

  await picker.chooseSource("stale-source");

  assert.deepEqual(resolved, [null]);
  assert.equal(picker.pending, undefined);
  assert.deepEqual(closeCalls, ["close"]);
});

test("user cancellation resolves exactly once and clears pending selection", () => {
  const { picker, closeCalls } = makePickerState();
  const resolved: Array<{ id: string } | null> = [];
  picker.pending = {
    requestId: 7,
    resolve: (value: { id: string } | null) => resolved.push(value),
    sources: new Map([["screen:2", { id: "screen:2" }]]),
  };

  picker.cancel();
  picker.cancel();

  assert.deepEqual(resolved, [null]);
  assert.equal(picker.pending, undefined);
  assert.deepEqual(closeCalls, ["close"]);
});

test("stale selection IDs cannot resolve a newer pending request", () => {
  const { picker, closeCalls } = makePickerState();
  const resolved: Array<{ id: string } | null> = [];
  picker.pending = {
    requestId: 9,
    resolve: (value: { id: string } | null) => resolved.push(value),
    sources: new Map([["screen:3", { id: "screen:3" }]]),
  };

  (picker as any).resolvePending(8, null, "stale_request");

  assert.deepEqual(resolved, []);
  assert.equal(picker.pending?.requestId, 9);
  assert.deepEqual(closeCalls, []);
});

test("cancellation during enumeration resolves once and late completion cannot affect the next request", async () => {
  const firstEnumeration = deferred<DesktopCapturerSource[]>();
  const secondEnumeration = deferred<DesktopCapturerSource[]>();
  const windows: FakePickerWindow[] = [];
  let enumerationCount = 0;
  const picker = new DisplayCapturePicker({
    getSources: () => (++enumerationCount === 1 ? firstEnumeration.promise : secondEnumeration.promise),
    createWindow: () => {
      const window = new FakePickerWindow();
      windows.push(window);
      return window;
    },
  });

  let firstResolutionCount = 0;
  const firstResult = choose(picker, 1).then((value) => {
    firstResolutionCount += 1;
    return value;
  });
  picker.cancel();
  picker.cancel();
  assert.equal(await firstResult, null);
  assert.equal(firstResolutionCount, 1);

  const secondResult = choose(picker, 2);
  firstEnumeration.resolve([source("source-a")]);
  await Promise.resolve();
  assert.equal(windows.length, 0);
  assert.throws(() => choose(picker, 3), /already pending/);

  secondEnumeration.resolve([source("source-b")]);
  await Promise.resolve();
  assert.equal(windows.length, 1);
  await picker.chooseSource("source-b");
  assert.equal((await secondResult)?.id, "source-b");
  assert.equal(firstResolutionCount, 1);
  assert.equal(windows[0]?.closeCalls, 1);
});

test("a second request during enumeration is rejected without replacing the first", async () => {
  const enumeration = deferred<DesktopCapturerSource[]>();
  const windows: FakePickerWindow[] = [];
  const picker = new DisplayCapturePicker({
    getSources: () => enumeration.promise,
    createWindow: () => {
      const window = new FakePickerWindow();
      windows.push(window);
      return window;
    },
  });

  const firstResult = choose(picker, 1);
  assert.throws(() => choose(picker, 2), /already pending/);
  enumeration.resolve([source("source-a")]);
  await Promise.resolve();
  assert.equal(windows.length, 1);
  await picker.chooseSource("source-a");
  assert.equal((await firstResult)?.id, "source-a");
});

test("enumeration rejection resolves its request and releases the reservation", async () => {
  const failedEnumeration = deferred<DesktopCapturerSource[]>();
  const windows: FakePickerWindow[] = [];
  let enumerationCount = 0;
  const picker = new DisplayCapturePicker({
    getSources: () => {
      enumerationCount += 1;
      return enumerationCount === 1
        ? failedEnumeration.promise
        : Promise.resolve([source("source-b")]);
    },
    createWindow: () => {
      const window = new FakePickerWindow();
      windows.push(window);
      return window;
    },
  });

  const failedResult = choose(picker, 1);
  failedEnumeration.reject(new Error("enumeration failed"));
  assert.equal(await failedResult, null);

  const nextResult = choose(picker, 2);
  await Promise.resolve();
  assert.equal(windows.length, 1);
  await picker.chooseSource("source-b");
  assert.equal((await nextResult)?.id, "source-b");
});

test("stale picker load failure cannot cancel a newer active request", () => {
  const { picker, closeCalls } = makePickerState();
  const resolved: Array<{ id: string } | null> = [];
  const newWindow = {
    isDestroyed: () => false,
    close: () => closeCalls.push("new-close"),
    webContents: { id: "new-window" },
  };
  picker.pending = {
    requestId: 2,
    resolve: (value: { id: string } | null) => resolved.push(value),
    sources: new Map([["screen:4", { id: "screen:4" }]]),
  };
  picker.window = newWindow;

  const staleLoadFailure = () => {
    if (picker.pending?.requestId !== 1) return;
    (picker as any).resolvePending(1, null, "picker_load_failed");
  };
  staleLoadFailure();

  assert.deepEqual(resolved, []);
  assert.equal(picker.pending?.requestId, 2);
  assert.deepEqual(closeCalls, []);
});

test("stale close events cannot mutate the active picker window", () => {
  const { picker } = makePickerState();
  const resolved: Array<{ id: string } | null> = [];
  const activeWindow = {
    isDestroyed: () => false,
    close: () => resolved.push({ id: "screen:5" }),
    webContents: { id: "active-window" },
  };
  const staleWindow = {
    isDestroyed: () => false,
    close: () => resolved.push(null),
    webContents: { id: "stale-window" },
  };
  picker.window = activeWindow;
  picker.pending = {
    requestId: 11,
    resolve: (value: { id: string } | null) => resolved.push(value),
    sources: new Map([["screen:5", { id: "screen:5" }]]),
  };

  const staleClosedHandler = () => {
    if (picker.window !== staleWindow) return;
    picker.window = undefined;
    (picker as any).resolvePending(11, null, "picker_closed");
  };

  staleClosedHandler();

  assert.deepEqual(resolved, []);
  assert.equal(picker.pending?.requestId, 11);
  assert.equal(picker.window, activeWindow);
});
