/**
 * A chat's history for people to read (the admin console), rendered from the
 * event log, which stays the only store: who said what, without the model's
 * reasoning, tool calls and system notes. It reaches as far back as the log
 * does (compaction and expiry remove older events).
 *
 *   user/message   → "user" (an admin's whisper → "hint")
 *   bot/sent       → "bot": everything it delivered, by tool or not
 *   admin/message  → "admin"
 *
 * Logs from before bot/sent existed: up to a chat's first bot/sent, the bot's
 * lines come from its successful calls of tools that deliver, worded by each
 * tool (Tool.historyLine). Answers the runner sent itself aren't in those.
 */
import { isEvent, type SessionEvent } from "../conversation/events.js";
import { historyLine } from "../tools/registry.js";

export type HistoryRole = "user" | "bot" | "admin" | "hint";

export interface HistoryEntry {
  /** Unique in the chat. */
  id: string;
  /** Epoch ms. */
  time: number;
  /** The event it comes from. */
  seq: number;
  role: HistoryRole;
  sender?: string;
  text: string;
}

/** History lines in log order. */
export function historyFromEvents(events: SessionEvent[]): HistoryEntry[] {
  const lines: HistoryEntry[] = [];
  const firstSent = events.find((e) => isEvent(e, "bot/sent"))?.seq ?? Infinity;
  const results = new Map<string, SessionEvent<"tool/result">>();
  for (const e of events) if (isEvent(e, "tool/result") && e.seq < firstSent) results.set(e.data.callId, e);

  for (const e of events) {
    if (isEvent(e, "user/message")) {
      const images = e.data.images?.length ? `[图片×${e.data.images.length}]` : "";
      lines.push({
        id: e.data.eventId,
        time: e.time,
        seq: e.seq,
        role: e.data.replyVia ? "hint" : "user",
        sender: e.data.sender,
        text: [e.data.text, images].filter(Boolean).join(" "),
      });
    } else if (isEvent(e, "bot/sent")) {
      lines.push({ id: `sent-${e.seq}`, time: e.time, seq: e.seq, role: "bot", text: e.data.text });
    } else if (isEvent(e, "admin/message")) {
      lines.push({ id: `admin-${e.seq}`, time: e.time, seq: e.seq, role: "admin", text: e.data.text });
    } else if (isEvent(e, "assistant/message") && e.seq < firstSent) {
      for (const item of e.data.output) {
        if (item.type !== "function_call") continue;
        const call = item as { call_id: string; name: string; arguments: string };
        const result = results.get(call.call_id);
        const text = result && !result.data.output.startsWith("Error:") ? historyLine(call.name, call.arguments) : undefined;
        if (text) lines.push({ id: call.call_id, time: result!.time, seq: result!.seq, role: "bot", text });
      }
    }
  }
  return lines.sort((a, b) => a.seq - b.seq);
}
