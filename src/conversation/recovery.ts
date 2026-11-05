import { isEvent, type NewEvent, type SessionEvent } from "./events.js";

/** A turn the next run should continue (it ended "paused" or "interrupted"). */
export interface UnfinishedTurn {
  turn: number;
  trigger: "direct" | "ambient";
  /**
   * Interrupted turns in a row at the end of the log. A paused turn finished
   * its steps (progress), so it ends the count.
   */
  interruptions: number;
}

/**
 * The turn to continue, when the last turn ended unfinished: "paused" (out of
 * time at a step boundary) or "interrupted" (cut off mid-step). Continuations
 * keep the original trigger, so an ambient turn stays ambient.
 */
export function unfinishedTurn(events: SessionEvent[]): UnfinishedTurn | undefined {
  const ends = events.filter((e): e is SessionEvent<"turn/end"> => isEvent(e, "turn/end"));
  const last = ends.at(-1);
  if (!last || (last.data.reason !== "paused" && last.data.reason !== "interrupted")) return undefined;
  const start = events.findLast((e): e is SessionEvent<"turn/start"> => isEvent(e, "turn/start") && e.data.turn === last.data.turn);
  let interruptions = 0;
  for (let i = ends.length - 1; i >= 0 && ends[i]!.data.reason === "interrupted"; i--) interruptions++;
  return { turn: last.data.turn, trigger: start?.data.trigger ?? "direct", interruptions };
}

/**
 * Close a turn the previous run never finished (the function was killed):
 * give every unanswered tool call an "interrupted" result and end the turn.
 * Like dsh, the cut-off turn is closed, not truncated. Returns the events to append.
 */
export function recoverOpenTurn(events: SessionEvent[]): NewEvent[] {
  const lastStart = events.findLast((e) => isEvent(e, "turn/start")) as SessionEvent<"turn/start"> | undefined;
  if (!lastStart) return [];
  const turn = lastStart.data.turn;
  const inTurn = events.filter((e) => e.seq > lastStart.seq);
  if (inTurn.some((e) => isEvent(e, "turn/end") && e.data.turn === turn)) return [];

  const fixes: NewEvent[] = [];
  const answered = new Set(inTurn.filter((e) => isEvent(e, "tool/result")).map((e) => (e as SessionEvent<"tool/result">).data.callId));
  const started = new Set(inTurn.filter((e) => isEvent(e, "tool/call")).map((e) => (e as SessionEvent<"tool/call">).data.callId));
  let step = 0;
  for (const e of inTurn) {
    if (isEvent(e, "step/start")) step = e.data.step;
    if (!isEvent(e, "assistant/message")) continue;
    for (const item of e.data.output) {
      if (item.type !== "function_call") continue;
      const callId = (item as { call_id: string }).call_id;
      if (answered.has(callId)) continue;
      fixes.push({
        type: "tool/result",
        data: {
          turn,
          step: e.data.step,
          callId,
          interrupted: true,
          output: started.has(callId)
            ? "interrupted: the run was cut off while this was running; it may or may not have taken effect"
            : "interrupted: the run was cut off before this ran",
        },
      });
    }
  }
  const lastStep = inTurn.findLast((e) => isEvent(e, "step/start") || isEvent(e, "step/end"));
  if (lastStep && isEvent(lastStep, "step/start")) fixes.push({ type: "step/end", data: { turn, step } });
  fixes.push({ type: "turn/end", data: { turn, reason: "interrupted" } });
  return fixes;
}
