import assert from "node:assert/strict";
import { test } from "node:test";
import { ResumeSessionStore } from "./resume.js";

const SESSION = "123e4567-e89b-12d3-a456-426614174000";

test("resume capabilities rotate atomically and allow idempotent retry after a lost response", async () => {
  const store = new ResumeSessionStore();
  const issued = store.create(SESSION, "owner", "viewer", 1_000, 300_000);
  const rotations = await Promise.all(Array.from({ length: 8 }, () =>
    Promise.resolve(store.rotate(SESSION, "owner", "owner", issued.owner, "same-operation", 2_000))));

  assert.ok(rotations.every((result) => result !== null));
  assert.equal(new Set(rotations.map((result) => result?.capability)).size, 1);
  const rotated = rotations[0]!;
  assert.equal(store.rotate(SESSION, "owner", "owner", issued.owner, "different-operation", 2_000), null);
  assert.ok(store.rotate(SESSION, "owner", "owner", rotated.capability, "next-operation", 2_100));
});

test("resume rejects replay, wrong endpoint, expiry, and invalidated sessions", () => {
  const store = new ResumeSessionStore();
  const issued = store.create(SESSION, "owner", "viewer", 1_000, 300_000);
  assert.equal(store.rotate(SESSION, "viewer", "owner", issued.viewer, "wrong-endpoint", 2_000), null);
  const accepted = store.rotate(SESSION, "owner", "owner", issued.owner, "owner-op", 2_000);
  assert.ok(accepted);
  assert.equal(store.rotate(SESSION, "owner", "owner", issued.owner, "replay", 2_000), null);
  assert.equal(store.rotate(SESSION, "viewer", "viewer", issued.viewer, "viewer-op", 301_000), null);
  store.invalidate(SESSION);
  assert.equal(store.rotate(SESSION, "owner", "owner", accepted.capability, "late", 2_000), null);
});

test("both endpoints must resume and Stop invalidation wins over concurrent attempts", async () => {
  const store = new ResumeSessionStore();
  const issued = store.create(SESSION, "owner", "viewer", 1_000, 300_000);
  const owner = store.rotate(SESSION, "owner", "owner", issued.owner, "owner-op", 2_000);
  assert.ok(owner);
  assert.equal(owner.bothReady, true);
  store.markDisconnected(SESSION, "viewer");
  assert.equal(store.rotate(SESSION, "owner", "owner", owner.capability, "owner-again", 2_001)?.bothReady, false);
  const viewer = store.rotate(SESSION, "viewer", "viewer", issued.viewer, "viewer-op", 2_001);
  assert.equal(viewer?.bothReady, true);

  const attempt = Promise.resolve().then(() =>
    store.rotate(SESSION, "viewer", "viewer", viewer!.capability, "stop-race", 2_002));
  store.invalidate(SESSION);
  assert.equal(await attempt, null);
});

test("sleep resume completes when either endpoint reconnects first", () => {
  for (const firstRole of ["owner", "viewer"] as const) {
    const store = new ResumeSessionStore();
    const sessionId = `${SESSION.slice(0, -1)}${firstRole === "owner" ? "1" : "2"}`;
    const issued = store.create(sessionId, "owner", "viewer", 1_000, 300_000);
    store.markDisconnected(sessionId, "owner");
    store.markDisconnected(sessionId, "viewer");

    const first = store.rotate(
      sessionId,
      firstRole,
      firstRole,
      issued[firstRole],
      `${firstRole}-first`,
      2_000,
    );
    assert.ok(first);
    assert.equal(first.bothReady, false, `${firstRole} alone must not resume the session`);

    const secondRole = firstRole === "owner" ? "viewer" : "owner";
    const second = store.rotate(
      sessionId,
      secondRole,
      secondRole,
      issued[secondRole],
      `${secondRole}-second`,
      2_001,
    );
    assert.ok(second);
    assert.equal(second.bothReady, true, `session must resume after ${secondRole} reconnects`);
  }
});

test("resume status reconciles retryable, pending, completed, expired, and invalid outcomes", () => {
  const store = new ResumeSessionStore();
  const issued = store.create(SESSION, "owner", "viewer", 0, 300_000, 7);

  assert.deepEqual(store.status(SESSION, "owner", "owner", 7, "owner-request", 1), { status: "retryable" });
  const owner = store.rotate(SESSION, "owner", "owner", issued.owner, "owner-request", 2);
  assert.ok(owner);
  assert.deepEqual(
    store.status(SESSION, "owner", "owner", 7, "owner-request", 3),
    { status: "pending", capability: owner.capability, expiresAt: owner.expiresAt },
  );
  const viewer = store.rotate(SESSION, "viewer", "viewer", issued.viewer, "viewer-request", 4);
  assert.ok(viewer?.bothReady);
  store.complete(SESSION, 5);
  assert.deepEqual(store.status(SESSION, "owner", "owner", 7, "owner-request", 6), { status: "completed" });
  assert.deepEqual(store.status(SESSION, "owner", "other", 7, "owner-request", 6), { status: "invalid" });
});

test("replaying a rotated capability with the same request re-marks the endpoint ready", () => {
  const store = new ResumeSessionStore();
  const issued = store.create(SESSION, "owner", "viewer", 0, 300_000, 7);
  store.markDisconnected(SESSION, "owner");
  const first = store.rotate(SESSION, "owner", "owner", issued.owner, "owner-request", 1);
  assert.ok(first);
  const replay = store.rotate(SESSION, "owner", "owner", first.capability, "owner-request", 2);
  assert.deepEqual(replay, first);
});

test("expired resume sessions report expired without exposing capabilities", () => {
  const store = new ResumeSessionStore();
  store.create(SESSION, "owner", "viewer", 0, 100, 2);
  store.expire(SESSION, 101);
  assert.deepEqual(store.status(SESSION, "owner", "owner", 2, "late-request", 102), { status: "expired" });
});
