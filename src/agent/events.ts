/**
 * Per-chat event log: the single source of truth for a conversation, after
 * the session log of DeepSeek's dsh (deepseek-ai/deepseek-harness).
 *
 *   - Append-only. Incoming messages, every model output (reasoning items
 *     included, verbatim), every tool call and result, and the per-turn
 *     system notes are appended as events and never rewritten.
 *   - The model input is *derived* from the log (deriveInput), so whatever the
 *     model saw can be rebuilt, and each request extends the previous one —
 *     the provider's prompt cache keeps hitting.
 *   - Compaction appends a `compaction/summary` that stands in for everything
 *     before `fromSeq`; unlike dsh (which keeps its log on disk forever), the
 *     events it replaces are then deleted, because Redis space is limited.
 *
 * Storage: a Redis list `ev:{chat}` of `{type, time, data}` JSON. An event's
 * `seq` is its position counted from the start of the log, i.e. `base` (how
 * many events were deleted from the front) + list index; it is not stored.
 * Webhooks only append; reading, recovery and trimming happen in the single
 * agent run that holds the chat's lock (see handle.ts), so `base` only changes
 * under that lock.
 */
import type { Store } from "../store/index.js";

/** A Responses API output item, stored and replayed untouched. */
export type OutputItem =
  | { type: "message"; role: string; content?: Array<{ type: string; text?: string }> }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: string; [key: string]: unknown };

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

export type TurnEndReason = "completed" | "max-steps" | "out-of-time" | "error" | "interrupted";

export interface EventMap {
  /** A message from the chat. `header` is the context line without its "第N条" id, which comes from `seq`. */
  "user/message": {
    eventId: string;
    header: string;
    text: string;
    sender: string;
    /** A DM, or a group message that @-mentions the bot. */
    mentioned: boolean;
    /** Store keys of the images, shrunk to what the model looks at. */
    images?: string[];
    imagesFailed?: number;
    /** The channel's reply context (msg_id, chat_id, …) as received; not model-visible. */
    reply: Record<string, string>;
  };
  /** The same platform message arrived again as an @ (QQ can send both). Log-only. */
  "user/mentioned": { eventId: string };
  /** `/reset`: the model sees nothing before this. Log-only. */
  "session/reset": Record<string, never>;
  "turn/start": { turn: number; trigger: "direct" | "ambient" };
  "turn/end": { turn: number; reason: TurnEndReason; error?: string };
  "step/start": { turn: number; step: number };
  "step/end": { turn: number; step: number };
  /** A system note ("（系统提示）第 N 轮开始…"); model-visible, kept like everything else. */
  "developer/message": { turn: number; text: string };
  /** The model's whole output for one step, verbatim (reasoning with encrypted_content, messages, calls). */
  "assistant/message": { turn: number; step: number; output: OutputItem[]; usage?: Usage };
  /** A model call that failed; no output. Log-only. */
  "assistant/attempt": { turn: number; step: number; error: string };
  /** A tool is about to run. A call with this marker but no result was cut off mid-run. Log-only. */
  "tool/call": { turn: number; step: number; callId: string; name: string };
  "tool/result": { turn: number; step: number; callId: string; output: string; interrupted?: true };
  /** Images a tool opened for the model (read_file), shown after the step's tool results. */
  "tool/images": { turn: number; step: number; images: string[] };
  /** Stands in for every event before `fromSeq`. */
  "compaction/summary": { fromSeq: number; summary: string; usage?: Usage };
}

export type EventType = keyof EventMap;
export type NewEvent = { [K in EventType]: { type: K; data: EventMap[K] } }[EventType];
export type SessionEvent<K extends EventType = EventType> = {
  [T in K]: { seq: number; type: T; time: number; data: EventMap[T] };
}[K];

export const isEvent = <K extends EventType>(e: SessionEvent, type: K): e is Extract<SessionEvent, { type: K }> =>
  e.type === type;

export class EventLog {
  readonly key: string;
  readonly baseKey: string;

  constructor(
    private store: Store,
    readonly chatKey: string,
    private ttlSeconds: number,
  ) {
    this.key = `ev:${chatKey}`;
    this.baseKey = `ev:base:${chatKey}`;
  }

  /**
   * Append in order; safe to call from any instance at any time. Returns the
   * log's new length (excluding base). Webhooks refresh the log's TTL; a run's
   * own appends skip that (`touch: false`), since a message always precedes them.
   */
  async append(...events: NewEvent[]): Promise<number> {
    return this.appendWith({ touch: true }, ...events);
  }

  async appendWith(opts: { touch: boolean }, ...events: NewEvent[]): Promise<number> {
    if (!events.length) return 0;
    const now = Date.now();
    return this.store.rpush(
      this.key,
      events.map((e) => JSON.stringify({ type: e.type, time: now, data: e.data })),
      opts.touch ? this.ttlSeconds : 0,
    );
  }

  async base(): Promise<number> {
    return Number((await this.store.get(this.baseKey)) ?? 0);
  }

  /** Events with seq >= `from` (clamped to what still exists), given the current `base`. */
  async read(from: number, base: number): Promise<SessionEvent[]> {
    const start = Math.max(from, base);
    const raw = await this.store.lrange(this.key, start - base, -1);
    return raw.map((item, i) => ({ seq: start + i, ...(JSON.parse(item) as Omit<SessionEvent, "seq">) }) as SessionEvent);
  }

  /** Delete the events before `seq` (and the images they reference). Only under the chat's lock. */
  async trimBefore(seq: number, base: number, dropped: SessionEvent[]): Promise<number> {
    const count = seq - base;
    if (count <= 0) return base;
    const images = dropped.flatMap((e) =>
      isEvent(e, "user/message") ? (e.data.images ?? []) : isEvent(e, "tool/images") ? e.data.images : [],
    );
    await this.store.lpop(this.key, count);
    await this.store.set(this.baseKey, String(seq), this.ttlSeconds * 1000);
    if (images.length) await this.store.del(...images);
    return seq;
  }
}

/** The model-visible message number of a user/message: its seq. */
export const messageLabel = (seq: number) => `第${seq}条`;

export function userMessageText(e: SessionEvent<"user/message">): string {
  const body = [e.data.text, ...(e.data.images ?? []).map(() => "[图片]")].filter(Boolean).join("\n");
  return `[${messageLabel(e.seq)}｜${e.data.header}]\n${body}`;
}

const SUMMARY_PREFIX = "（系统提示）以下是更早对话的摘要，原文已经删除：\n";

/**
 * The events the model currently sees: after the latest `/reset`, starting
 * from the latest compaction summary (which stands in for what came before).
 */
export function visibleWindow(events: SessionEvent[]): { summary?: SessionEvent<"compaction/summary">; events: SessionEvent[] } {
  let start = 0;
  let summary: SessionEvent<"compaction/summary"> | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (isEvent(e, "session/reset")) {
      start = i + 1;
      break;
    }
    if (!summary && isEvent(e, "compaction/summary")) summary = e;
  }
  const from = summary ? summary.data.fromSeq : -1;
  const window = events.slice(start).filter((e) => e.seq >= from && e.type !== "compaction/summary");
  return { summary: summary && summary.seq >= (events[start]?.seq ?? 0) ? summary : undefined, events: window };
}

type Loader = (key: string) => Promise<string | null>;

/**
 * Responses API input for the visible window, in log order. Two adjustments
 * keep the request valid without touching the log:
 *   - a message that arrived while a step was running (between its
 *     step/start and step/end) is shown after that step's tool results, so a
 *     function_call is always followed directly by its output;
 *   - a function_call whose result never made it into the log (the run was
 *     killed) gets a synthetic "interrupted" output. Recovery normally
 *     appends a real tool/result first (see recoverOpenTurn).
 */
export async function deriveInput(events: SessionEvent[], loadImage: Loader): Promise<unknown[]> {
  const { summary, events: window } = visibleWindow(events);
  const input: unknown[] = [];
  if (summary) input.push({ role: "user", content: SUMMARY_PREFIX + summary.data.summary });

  const results = new Set(window.filter((e) => isEvent(e, "tool/result")).map((e) => (e as SessionEvent<"tool/result">).data.callId));
  let openStep = false;
  let deferred: unknown[] = [];
  const emit = (item: unknown) => (openStep ? deferred.push(item) : input.push(item));

  for (const e of window) {
    switch (e.type) {
      case "step/start":
        openStep = true;
        break;
      case "step/end":
        openStep = false;
        input.push(...deferred);
        deferred = [];
        break;
      case "user/message":
        emit(await userMessageItem(e as SessionEvent<"user/message">, loadImage));
        break;
      case "developer/message":
        emit({ role: "developer", content: e.data.text });
        break;
      case "assistant/message":
        input.push(...e.data.output);
        for (const item of e.data.output) {
          if (item.type === "function_call" && !results.has((item as { call_id: string }).call_id)) {
            input.push({
              type: "function_call_output",
              call_id: (item as { call_id: string }).call_id,
              output: "interrupted: the turn was cut off before this ran",
            });
          }
        }
        break;
      case "tool/result":
        input.push({ type: "function_call_output", call_id: e.data.callId, output: e.data.output });
        break;
      case "tool/images": {
        const parts = await imageParts(e.data.images, loadImage, "auto");
        if (parts.length) {
          input.push({ role: "user", content: [{ type: "input_text", text: "（系统提示）read_file 打开的图片：" }, ...parts] });
        }
        break;
      }
    }
  }
  input.push(...deferred);
  return input;
}

async function imageParts(keys: string[], loadImage: Loader, detail: "low" | "auto") {
  const urls = await Promise.all(keys.map(loadImage));
  return urls.filter((u): u is string => Boolean(u)).map((url) => ({ type: "input_image", image_url: url, detail }));
}

async function userMessageItem(e: SessionEvent<"user/message">, loadImage: Loader) {
  let text = userMessageText(e);
  const keys = e.data.images ?? [];
  if (e.data.imagesFailed) text += "\n（有图片没加载出来）";
  if (!keys.length) return { role: "user", content: text };
  const parts = await imageParts(keys, loadImage, "low");
  if (parts.length < keys.length) text += "\n（有图片已过期，看不到了）";
  return { role: "user", content: [{ type: "input_text", text }, ...parts] };
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
