export type SleepRecoveryState = "idle" | "started" | "completed" | "failed" | "timed_out";
export type SleepRecoveryTerminalPhase = "completed" | "failed" | "timed_out";

export type WakeSharingChoiceDeliveryState = {
  pendingCycleId?: number;
  lastQueuedCycleId?: number;
  deliveryCycleId?: number;
};

export function queueWakeSharingChoice(
  state: WakeSharingChoiceDeliveryState,
  cycleId: number,
): boolean {
  if (
    state.pendingCycleId !== undefined ||
    !isNewWakeSharingChoiceCycle(cycleId, state.lastQueuedCycleId)
  ) return false;
  state.pendingCycleId = cycleId;
  state.lastQueuedCycleId = cycleId;
  state.deliveryCycleId = undefined;
  return true;
}

export function queueWakeSharingChoiceCandidate(
  state: WakeSharingChoiceDeliveryState,
  candidateCycleId: number | undefined,
  cycleId: number,
): boolean {
  if (candidateCycleId !== cycleId) return false;
  return queueWakeSharingChoice(state, cycleId);
}

export function registerDisplayedWakeSharingChoice(
  state: WakeSharingChoiceDeliveryState,
  cycleId: number,
): boolean {
  if (state.pendingCycleId === cycleId) {
    state.deliveryCycleId = cycleId;
    return true;
  }
  if (
    state.pendingCycleId !== undefined ||
    !isNewWakeSharingChoiceCycle(cycleId, state.lastQueuedCycleId)
  ) return false;
  state.pendingCycleId = cycleId;
  state.lastQueuedCycleId = cycleId;
  state.deliveryCycleId = cycleId;
  return true;
}

export function registerWakeSharingChoiceCandidate(
  state: WakeSharingChoiceDeliveryState,
  candidateCycleId: number | undefined,
  cycleId: number,
): boolean {
  if (candidateCycleId !== cycleId) return false;
  return registerDisplayedWakeSharingChoice(state, cycleId);
}

export function takeWakeSharingChoiceForDelivery(
  state: WakeSharingChoiceDeliveryState,
  rendererReady: boolean,
): number | undefined {
  if (
    !rendererReady ||
    state.pendingCycleId === undefined ||
    state.deliveryCycleId === state.pendingCycleId
  ) return undefined;
  state.deliveryCycleId = state.pendingCycleId;
  return state.pendingCycleId;
}

export function resetWakeSharingChoiceDelivery(state: WakeSharingChoiceDeliveryState): void {
  state.deliveryCycleId = undefined;
}

export function completeWakeSharingChoice(
  state: WakeSharingChoiceDeliveryState,
  cycleId: number,
): boolean {
  if (state.pendingCycleId !== cycleId) return false;
  state.pendingCycleId = undefined;
  state.deliveryCycleId = undefined;
  return true;
}

export function cancelWakeSharingChoiceCycle(
  state: WakeSharingChoiceDeliveryState,
  candidateCycleId: number | undefined,
  cycleId: number,
): number | undefined {
  completeWakeSharingChoice(state, cycleId);
  return candidateCycleId === cycleId ? undefined : candidateCycleId;
}

export function shouldOfferWakeSharingChoice(
  sharingWasActive: boolean,
  captureEnded: boolean,
  recoverySucceeded: boolean,
  alreadyOffered: boolean,
): boolean {
  return sharingWasActive && captureEnded && !recoverySucceeded && !alreadyOffered;
}

export function isDefinitiveSleepRecoveryFailure(
  phase: SleepRecoveryTerminalPhase,
): boolean {
  return phase === "failed";
}

export function isNewWakeSharingChoiceCycle(
  cycleId: number,
  lastOfferedCycleId: number | undefined,
): boolean {
  return Number.isSafeInteger(cycleId) &&
    cycleId >= 0 &&
    (lastOfferedCycleId === undefined || cycleId > lastOfferedCycleId);
}

export function isValidRecoveryAttemptId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function canAcceptRecoveryStart(
  state: SleepRecoveryState,
  activeAttemptId: string | undefined,
  attemptId: unknown,
): attemptId is string {
  return state === "started" && activeAttemptId === undefined && isValidRecoveryAttemptId(attemptId);
}

export function canAcceptRecoveryTerminal(
  state: SleepRecoveryState,
  cycleId: number,
  activeCycleId: number,
  activeAttemptId: string | undefined,
  attemptId: unknown,
  phase: unknown,
): phase is SleepRecoveryTerminalPhase {
  return state === "started" &&
    cycleId === activeCycleId &&
    isValidRecoveryAttemptId(activeAttemptId) &&
    attemptId === activeAttemptId &&
    (phase === "completed" || phase === "failed" || phase === "timed_out");
}
