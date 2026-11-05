/**
 * How a run spends its function's time (the platform kills the function at
 * `deadline`). Two rules, the same for every run:
 *
 *   - A step starts only with at least NEW_STEP_MIN_MS left. Otherwise the run
 *     stops at the step boundary and a fresh function (/api/worker) continues
 *     the turn; nothing is lost, the log has everything so far.
 *   - Every call inside a step (the model, a tool) must end HANDOFF_MARGIN_MS
 *     before the deadline, so the run always has time to write the log and
 *     hand over instead of being killed mid-call.
 *
 * Sync channels can't continue elsewhere (the caller waits for this response),
 * so they keep a last step instead: below LAST_STEP_MIN_MS the model must reply.
 */

/** Below this, don't start a step: hand the turn to a fresh function. */
export const NEW_STEP_MIN_MS = 100_000;
/** Every call ends at least this long before the deadline: time to log and hand over. */
export const HANDOFF_MARGIN_MS = 20_000;
/** Sync channels: below this, the next step is the last one and must reply. */
export const LAST_STEP_MIN_MS = 90_000;
/** A tool isn't started with less time than this for it. */
export const MIN_CALL_MS = 5_000;

/** Milliseconds until the deadline. */
export function timeLeftMs(deadline: number): number {
  return deadline - Date.now();
}

/** How long a call started now may take: until HANDOFF_MARGIN_MS before the deadline. */
export function callBudgetMs(deadline: number): number {
  return Math.max(0, timeLeftMs(deadline) - HANDOFF_MARGIN_MS);
}
