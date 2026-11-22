import assert from "node:assert/strict";
import test from "node:test";
import {
  canAcceptRecoveryStart,
  canAcceptRecoveryTerminal,
  cancelWakeSharingChoiceCycle,
  completeWakeSharingChoice,
  isDefinitiveSleepRecoveryFailure,
  isNewWakeSharingChoiceCycle,
  isValidRecoveryAttemptId,
  queueWakeSharingChoice,
  queueWakeSharingChoiceCandidate,
  registerDisplayedWakeSharingChoice,
  registerWakeSharingChoiceCandidate,
  resetWakeSharingChoiceDelivery,
  shouldOfferWakeSharingChoice,
  takeWakeSharingChoiceForDelivery,
  type WakeSharingChoiceDeliveryState,
} from "./sleep-recovery-state.js";

test("wake sharing choice requires sharing before sleep and an ended capture", () => {
  assert.equal(shouldOfferWakeSharingChoice(true, true, false, false), true);
  assert.equal(shouldOfferWakeSharingChoice(false, true, false, false), false);
  assert.equal(shouldOfferWakeSharingChoice(true, false, false, false), false);
  assert.equal(shouldOfferWakeSharingChoice(true, true, true, false), false);
});

test("duplicate and stale wake-choice cycles are ignored", () => {
  assert.equal(isNewWakeSharingChoiceCycle(4, undefined), true);
  assert.equal(isNewWakeSharingChoiceCycle(4, 4), false);
  assert.equal(isNewWakeSharingChoiceCycle(3, 4), false);
  assert.equal(isNewWakeSharingChoiceCycle(-1, undefined), false);
  assert.equal(shouldOfferWakeSharingChoice(true, true, false, true), false);
});

test("wake choice queued before renderer readiness is delivered once readiness arrives", () => {
  const state: WakeSharingChoiceDeliveryState = {};
  assert.equal(queueWakeSharingChoice(state, 4), true);
  assert.equal(takeWakeSharingChoiceForDelivery(state, false), undefined);
  assert.equal(takeWakeSharingChoiceForDelivery(state, true), 4);
  assert.equal(takeWakeSharingChoiceForDelivery(state, true), undefined);
  assert.equal(queueWakeSharingChoice(state, 4), false);
  assert.equal(completeWakeSharingChoice(state, 4), true);
  assert.equal(takeWakeSharingChoiceForDelivery(state, true), undefined);
});

test("pending wake choice is redelivered after renderer reload and cleared only by a matching choice", () => {
  const state: WakeSharingChoiceDeliveryState = {};
  assert.equal(queueWakeSharingChoice(state, 8), true);
  assert.equal(takeWakeSharingChoiceForDelivery(state, true), 8);
  resetWakeSharingChoiceDelivery(state);
  assert.equal(takeWakeSharingChoiceForDelivery(state, true), 8);
  assert.equal(completeWakeSharingChoice(state, 7), false);
  assert.equal(takeWakeSharingChoiceForDelivery(state, true), undefined);
  assert.equal(completeWakeSharingChoice(state, 8), true);
  assert.equal(queueWakeSharingChoice(state, 8), false);
});

test("wake-choice cancellation clears only its matching cycle", () => {
  const state: WakeSharingChoiceDeliveryState = {};
  assert.equal(registerDisplayedWakeSharingChoice(state, 10), true);
  assert.equal(completeWakeSharingChoice(state, 9), false);
  resetWakeSharingChoiceDelivery(state);
  assert.equal(takeWakeSharingChoiceForDelivery(state, true), 10);
  assert.equal(completeWakeSharingChoice(state, 10), true);

  assert.equal(registerDisplayedWakeSharingChoice(state, 11), true);
  assert.equal(completeWakeSharingChoice(state, 10), false);
  resetWakeSharingChoiceDelivery(state);
  assert.equal(takeWakeSharingChoiceForDelivery(state, true), 11);
  assert.equal(registerDisplayedWakeSharingChoice(state, 10), false);
});

test("candidate cancellation works before a pending delivery is registered", () => {
  const state: WakeSharingChoiceDeliveryState = {};
  const candidateCycleId = cancelWakeSharingChoiceCycle(state, 24, 24);
  assert.equal(candidateCycleId, undefined);
  assert.equal(state.pendingCycleId, undefined);
});

test("stale candidate cancellation cannot clear a newer candidate or pending choice", () => {
  const state: WakeSharingChoiceDeliveryState = {};
  assert.equal(registerWakeSharingChoiceCandidate(state, 26, 26), true);
  assert.equal(cancelWakeSharingChoiceCycle(state, 26, 25), 26);
  assert.equal(state.pendingCycleId, 26);
});

test("cancelling a registered pending choice clears both delivery and candidate state", () => {
  const state: WakeSharingChoiceDeliveryState = {};
  assert.equal(registerWakeSharingChoiceCandidate(state, 27, 27), true);
  const candidateCycleId = cancelWakeSharingChoiceCycle(state, 27, 27);
  assert.equal(candidateCycleId, undefined);
  assert.equal(state.pendingCycleId, undefined);
  assert.equal(takeWakeSharingChoiceForDelivery(state, true), undefined);
});

test("a cancelled candidate cannot be registered, queued, or delivered later", () => {
  const state: WakeSharingChoiceDeliveryState = {};
  const candidateCycleId = cancelWakeSharingChoiceCycle(state, 28, 28);
  assert.equal(registerWakeSharingChoiceCandidate(state, candidateCycleId, 28), false);
  assert.equal(queueWakeSharingChoiceCandidate(state, candidateCycleId, 28), false);
  assert.equal(state.pendingCycleId, undefined);
  assert.equal(takeWakeSharingChoiceForDelivery(state, true), undefined);
});

test("a stopped sharing session and a successfully recovered session do not offer a wake choice", () => {
  assert.equal(shouldOfferWakeSharingChoice(false, true, false, false), false);
  assert.equal(shouldOfferWakeSharingChoice(true, true, true, false), false);
});

test("only a definitive failed recovery result is terminal for capture cleanup", () => {
  assert.equal(isDefinitiveSleepRecoveryFailure("failed"), true);
  assert.equal(isDefinitiveSleepRecoveryFailure("completed"), false);
  assert.equal(isDefinitiveSleepRecoveryFailure("timed_out"), false);
});

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
