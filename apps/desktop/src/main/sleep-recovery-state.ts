export type SleepRecoveryState = "idle" | "started" | "completed" | "failed" | "timed_out";
export type SleepRecoveryTerminalPhase = "completed" | "failed" | "timed_out";

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
