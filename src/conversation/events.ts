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
 *     events it replaces are then deleted, because the free databases are small.
 *
 * Storage: rows of gateway.events, `{seq, type, time, data}` with `seq`
 * numbered contiguously per chat by the store (see src/store and
 * supabase/schema.sql). Webhooks only append; reading, recovery and trimming
 * happen in the single agent run that holds the chat's lock (see runtime/runner.ts).
 */
import type { Attachment, Person } from "../channels/types.js";

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
  /** What the call cost in USD, where the provider reports it (OpenRouter). */
  cost?: number;
}

/** "unreachable": the platform couldn't be reached, so the turn stopped instead of retrying (runtime/outbox.ts). */
/**
 * Why a turn ended. "paused" and "interrupted" leave the turn unfinished: the
 * next run continues it (see unfinishedTurn in recovery.ts).
 *   - paused: stopped at a step boundary, out of time in this function.
 *   - interrupted: cut off mid-step, by a call that ran out of time or failed
 *     transiently, or by the function being killed (recoverOpenTurn).
 */
export type TurnEndReason = "completed" | "max-steps" | "out-of-time" | "error" | "paused" | "interrupted" | "unreachable";

export interface EventMap {
  /** A message from the chat. `header` is the context line without its "第N条" id, which comes from `seq`. */
  "user/message": {
    eventId: string;
    header: string;
    text: string;
    sender: string;
    /** The sender's platform id, for the chat's roster and for @-ing them; not model-visible. */
    userId?: string;
    /** Other people the message @-mentioned (already shown in `text`); not model-visible. */
    mentions?: Person[];
    /** A DM, or a group message that @-mentions the bot. */
    mentioned: boolean;
    /** Store keys of the images, shrunk to what the model looks at. */
    images?: string[];
    imagesFailed?: number;
    /** Links to the attachments' originals (images included), for save_attachment; not model-visible. */
    attachments?: Attachment[];
    /** The channel's reply context (msg_id, chat_id, …) as received; not model-visible. */
    reply: Record<string, string>;
    /**
     * Set on an admin's whisper (see isWhisper), which has no platform message
     * of its own: replies to it go through this platform message (its
     * eventId) and share its reply count.
     */
    replyVia?: string;
    /**
     * Logged while the chat was set to record only: context for later turns,
     * never a turn's work (see Session.messagesAfter).
     */
    quiet?: true;
  };
  /**
   * Something the bot delivered to the chat: through a tool, or a notice from
   * the runner (a plain-text answer, "out of credit"…). How it reads: text, an
   * image's label, "[语音] …", "[文件：…]". Log-only: what the model said is
   * already in its output; this is the chat's side, for the admin console's history.
   */
  "bot/sent": { turn?: number; text: string; replyTo: number };
  /** Something an admin sent in the bot's name; the model sees it as its own message. */
  "admin/message": { text: string };
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

/** An admin's instruction to the bot that the chat didn't see (admin/chat-actions.ts), not something someone in the chat wrote. */
export const isWhisper = (e: SessionEvent<"user/message">): boolean => e.data.replyVia !== undefined;

/** The model-visible message number of a user/message: its seq. */
export const messageLabel = (seq: number) => `第${seq}条`;

export function userMessageText(e: SessionEvent<"user/message">): string {
  const body = [e.data.text, ...(e.data.images ?? []).map(() => "[图片]")].filter(Boolean).join("\n");
  return `[${messageLabel(e.seq)}｜${e.data.header}]\n${body}`;
}

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
