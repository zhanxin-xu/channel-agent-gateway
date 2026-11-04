/**
 * Context compaction, after dsh's compaction-basic:
 *
 *   - Trigger: the last model call's `usage.input_tokens` (exact, from the
 *     provider) passed 80% of AGENT_CONTEXT_TOKENS.
 *   - Keep the newest ~16% of the context verbatim; summarize everything
 *     before it. The cut falls on a turn start or an incoming message outside
 *     any step, so a tool call is never separated from its result.
 *   - The summary call replays the exact prefix of the request that was just
 *     made (same instructions, tools and leading input) plus one trailing
 *     instruction, so the provider reuses its cached tokens.
 *   - The result is appended as `compaction/summary` (fromSeq = the cut); the
 *     events it replaces are then deleted from the store.
 */
import { config } from "../config.js";
import { isEvent, visibleWindow, type SessionEvent } from "./events.js";
import { createResponse, outputText } from "./loop.js";
import type { Session } from "./session.js";

const TRIGGER_RATIO = 0.8;
const KEEP_RATIO = 0.16;

const COMPACTION_INSTRUCTION =
  "（系统提示）现在你是对话压缩器。把上面的全部对话（包括之前的摘要）浓缩成一份摘要，供你之后继续聊天时参考。" +
  "保留：每个人是谁（#编号、昵称）和他们说过的重要的事；正在进行的任务和进度；你答应过还没做完的事；" +
  "查到的关键结果和文件位置；群里的梗、氛围和你的说话风格。不要回应这条提示，不要调用工具，只输出摘要正文。";

/** Rough size of an event as the model sees it; only used to place the cut. */
function size(e: SessionEvent): number {
  if (isEvent(e, "user/message")) return e.data.header.length + e.data.text.length + (e.data.images?.length ?? 0) * 200;
  if (isEvent(e, "assistant/message")) return JSON.stringify(e.data.output).length;
  if (isEvent(e, "tool/result")) return e.data.output.length;
  if (isEvent(e, "developer/message")) return e.data.text.length;
  if (isEvent(e, "tool/images")) return e.data.images.length * 400;
  return 0;
}

/** Seqs where the context may be cut: turn starts and messages that didn't arrive mid-step. */
function cutPoints(events: SessionEvent[]): number[] {
  const points: number[] = [];
  let inStep = false;
  for (const e of events) {
    if (isEvent(e, "step/start")) inStep = true;
    else if (isEvent(e, "step/end")) inStep = false;
    else if (!inStep && (isEvent(e, "turn/start") || isEvent(e, "user/message"))) points.push(e.seq);
  }
  return points;
}

export async function compactIfNeeded(
  session: Session,
  o: { systemPrompt: string; tools: unknown[]; inputTokens: number; keepFrom: number },
): Promise<boolean> {
  const budget = config.agent.contextTokens;
  if (o.inputTokens < budget * TRIGGER_RATIO) return false;

  const { summary: previous, events: window } = visibleWindow(session.events);
  const total = window.reduce((n, e) => n + size(e), previous?.data.summary.length ?? 0);
  if (!total) return false;
  const keep = total * KEEP_RATIO / TRIGGER_RATIO; // the share of today's context to keep verbatim

  // The latest cut point that still keeps `keep` worth of events, and never past `keepFrom`.
  const points = cutPoints(window).filter((p) => p <= o.keepFrom && p > window[0]!.seq);
  let cut: number | undefined;
  for (let i = points.length - 1; i >= 0; i--) {
    const tail = window.filter((e) => e.seq >= points[i]!).reduce((n, e) => n + size(e), 0);
    cut = points[i];
    if (tail >= keep) break;
  }
  if (cut === undefined) {
    console.warn(`[compaction] ${session.chatKey}: ${o.inputTokens} tokens but no place to cut`);
    return false;
  }

  // The head of the last request: the previous summary plus everything before the cut.
  const head = session.events.filter((e) => e.seq < cut || e === previous);
  const started = Date.now();
  const response = await createResponse({
    model: config.openrouter.model,
    ...config.openrouter.extraBody,
    instructions: o.systemPrompt,
    input: [...(await session.input(head)), { role: "user", content: COMPACTION_INSTRUCTION }],
    tools: o.tools,
    tool_choice: "none",
  });
  const text = outputText(response.output ?? []);
  if (!text) {
    console.warn(`[compaction] ${session.chatKey}: empty summary, skipped`);
    return false;
  }
  await session.append({
    type: "compaction/summary",
    data: { fromSeq: cut, summary: text, ...(response.usage ? { usage: response.usage } : {}) },
  });
  await session.trimBefore(cut);
  console.log(
    `[compaction] ${session.chatKey}: ${o.inputTokens} tokens, summarized events before ${cut} into ${text.length} chars ` +
      `(cached ${response.usage?.input_tokens_details?.cached_tokens ?? 0}) ms=${Date.now() - started}`,
  );
  return true;
}
