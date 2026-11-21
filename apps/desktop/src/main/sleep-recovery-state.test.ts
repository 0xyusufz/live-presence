import assert from "node:assert/strict";
import test from "node:test";
import {
  canAcceptRecoveryStart,
  canAcceptRecoveryTerminal,
  isValidRecoveryAttemptId,
} from "./sleep-recovery-state.js";

test("recovery attempts require a non-empty ID", () => {
  assert.equal(isValidRecoveryAttemptId(undefined), false);
  assert.equal(isValidRecoveryAttemptId(""), false);
  assert.equal(isValidRecoveryAttemptId("attempt-1"), true);
  assert.equal(canAcceptRecoveryStart("started", undefined, undefined), false);
  assert.equal(canAcceptRecoveryStart("started", undefined, "attempt-1"), true);
});

test("terminal results require the active cycle and attempt", () => {
  assert.equal(
    canAcceptRecoveryTerminal("started", 2, 2, "attempt-2", "attempt-1", "completed"),
    false,
  );
  assert.equal(
    canAcceptRecoveryTerminal("timed_out", 2, 2, "attempt-2", "attempt-2", "completed"),
    false,
  );
  assert.equal(
    canAcceptRecoveryTerminal("started", 1, 2, "attempt-2", "attempt-2", "completed"),
    false,
  );
  assert.equal(
    canAcceptRecoveryTerminal("started", 2, 2, "attempt-2", "attempt-2", "completed"),
    true,
  );
  assert.equal(
    canAcceptRecoveryTerminal("started", 2, 2, "attempt-2", "attempt-2", "failed"),
    true,
  );
  assert.equal(
    canAcceptRecoveryTerminal("failed", 2, 2, "attempt-2", "attempt-2", "completed"),
    false,
  );
  assert.equal(
    canAcceptRecoveryTerminal("started", 2, 2, "attempt-2", "attempt-2", "timed_out"),
    true,
  );
});
