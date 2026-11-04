/**
 * One turn of the agent loop on the Responses API (`POST {baseURL}/responses`),
 * driven by the chat's event log (see conversation/events.ts):
 *
 *   each step: read the log's new events → derive the input → call the model
 *   → append its output verbatim (reasoning included) → append a tool/call
 *   marker, run the tool, append its tool/result → repeat.
 *
 * Nothing lives only in memory: messages that arrive mid-turn show up at the
 * next step, and a run that dies can be picked up from the log. Each request
 * extends the previous one, so the prompt cache keeps hitting.
 *
 * Every request sets tool_choice "required", so the model always acts through
 * a tool. The turn ends when the model calls end_turn (usually alongside its
 * last message), or after the last step: when the step budget runs out or the
 * function is close to its time limit, a note tells the model to wrap up and
 * tool_choice forces a send_message. Every call in a step runs, in order,
 * wherever end_turn sits among them; the turn ends after the step, unless a
 * message failed to send (before the last step), so the model can react. When
 * the failure was the platform being unreachable, the turn ends anyway: a retry
 * would only wait out the same timeout.
 *
 * The request body is `{ model, ...OPENAI_RESPONSES_EXTRA_BODY, instructions, input,
 * tools, tool_choice }`, so any provider-specific parameter (provider routing,
 * reasoning, max_output_tokens, …) can be set from config without code changes.
 */
import { config } from "../config.js";
import { compactIfNeeded } from "./compaction.js";
import { messageLabel, type NewEvent, type OutputItem, type SessionEvent, type TurnEndReason } from "../conversation/events.js";
import type { Session } from "../conversation/session.js";
import { activeTools, runTool, sayTool, toolNames } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";
import { createResponse, outputText, type ResponsesResult } from "./model.js";

type FunctionCall = Extract<OutputItem, { type: "function_call" }>;
const isFunctionCall = (item: OutputItem): item is FunctionCall => item.type === "function_call";

export function toolDefinitions() {
  return activeTools().map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters }));
}

/** Time kept for the last step (one model call plus sending) before the function's deadline. */
export const LAST_STEP_RESERVE_MS = 90_000;

const describe = (m: SessionEvent<"user/message">) =>
  `${messageLabel(m.seq)}（${m.data.sender}${m.data.mentioned ? "，@你" : ""}）`;

function listMessages(messages: SessionEvent<"user/message">[]): string {
  const shown = messages.slice(-10).map(describe).join("、");
  return messages.length > 10 ? `……${shown}（共 ${messages.length} 条）` : shown;
}

const ambientGuidance = (hangup: string) =>
  `这些消息都没 @ 你，你正在群里暗中窥屏。默认只调用 ${hangup} 继续潜水。` +
  "但如果有人接你的话、在背后议论你/叫你大肥鱼、有人爆了值得 remember 记小本本的黑料或 flag、" +
  "或者聊到了美食/好玩的梗让你手痒想吐槽，就主动插一嘴（或者甩张表情包）再挂断！";

export interface TurnOptions {
  session: Session;
  ctx: ToolContext;
  systemPrompt: string;
  turn: number;
  trigger: "direct" | "ambient";
  /** The messages this turn starts with (not yet handled), oldest first. */
  pending: SessionEvent<"user/message">[];
  /** The message replies go to by default. */
  main: SessionEvent<"user/message">;
  /** Whether the main message can still take a reply (QQ: 5 per message). */
  canReply(): Promise<boolean>;
  /** The platform couldn't be reached this run: the turn ends after the step instead of letting the model retry. */
  unreachable?(): boolean;
}

export interface TurnResult {
  steps: number;
  reason: TurnEndReason;
  /** Seq of the newest user message the model saw; the cursor moves here. */
  handledUpTo: number;
  /** Plain text the model wrote without calling a tool (only if a provider ignores tool_choice). */
  text: string;
  usage: { input: number; cached: number; reasoning: number };
}

export async function runTurn(o: TurnOptions): Promise<TurnResult> {
  const { session, ctx, turn } = o;
  const { model, extraBody } = config.llm;
  const tools = toolDefinitions();
  // Tools are told apart by role (tools/types.ts), never by name.
  const say = sayTool();
  const talks = toolNames("say", "talk");
  const hangups = toolNames("hangup");
  const usage = { input: 0, cached: 0, reasoning: 0 };
  let handledUpTo = o.pending.at(-1)!.seq;

  const start =
    `（系统提示）第${turn}轮开始。待处理的消息：${listMessages(o.pending)}。` +
    `发消息默认回复${messageLabel(o.main.seq)}，要回复别的消息用 reply_to。` +
    (o.trigger === "ambient" ? ambientGuidance([...hangups].join(" / ")) : "");
  // Events are written in a few batches per step (each batch is one store call).
  let opening: NewEvent[] = [
    { type: "turn/start", data: { turn, trigger: o.trigger } },
    { type: "developer/message", data: { turn, text: start } },
  ];
  const turnEnd = (reason: TurnEndReason, error?: string): NewEvent => ({
    type: "turn/end",
    data: { turn, reason, ...(error ? { error } : {}) },
  });
  const result = (step: number, reason: TurnEndReason, text = ""): TurnResult => ({ steps: step, reason, handledUpTo, text, usage });

  for (let step = 1; ; step++) {
    const notes: string[] = [];
    // Messages that arrived since the last step are already in the log; point them out.
    // (The run read the log just before starting the turn.)
    if (step > 1) await session.refresh();
    const arrived = session.messagesAfter(handledUpTo);
    if (arrived.length) {
      notes.push(`（系统提示）第${turn}轮：你处理期间又来了 ${listMessages(arrived)}。要回复它们用 reply_to。`);
      handledUpTo = arrived.at(-1)!.seq;
    }

    // The last step starts early enough to finish before the function is killed.
    const outOfTime = ctx.deadline - Date.now() < LAST_STEP_RESERVE_MS;
    const lastStep = step >= config.agent.maxSteps || outOfTime;
    if (lastStep) {
      if (!(await o.canReply())) {
        const reason = outOfTime ? "out-of-time" : "max-steps";
        await session.append(...opening, turnEnd(reason));
        return result(step - 1, reason);
      }
      notes.push(
        `（系统提示）第${turn}轮：${outOfTime ? "时间快用完了" : "步数用完了"}，这是最后一步：必须现在用 ${say} 发一条消息，发完这一轮就结束。` +
          "说出已经得到的结果；没做完就说做到哪了、卡在哪、接下来怎么办。",
      );
    }
    await session.append(
      ...opening,
      ...notes.map((text) => ({ type: "developer/message" as const, data: { turn, text } })),
      { type: "step/start", data: { turn, step } },
    );
    opening = [];

    let response: ResponsesResult;
    try {
      response = await createResponse({
        model,
        ...extraBody,
        instructions: o.systemPrompt,
        input: await session.input(),
        tools,
        // Every step acts through a tool: talk, or hang up.
        // The last step must say something: whoever is waiting hears the result or where it got stuck.
        tool_choice: lastStep ? { type: "function", name: say } : "required",
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await session.append(
        { type: "assistant/attempt", data: { turn, step, error } },
        { type: "step/end", data: { turn, step } },
        turnEnd("error", error),
      );
      throw err;
    }

    const output = response.output ?? [];
    const u = response.usage ?? {};
    usage.input = u.input_tokens ?? usage.input;
    usage.cached = u.input_tokens_details?.cached_tokens ?? usage.cached;
    usage.reasoning += u.output_tokens_details?.reasoning_tokens ?? 0;
    if (response.status === "incomplete") {
      console.warn(`[agent] response incomplete: ${response.incomplete_details?.reason ?? "unknown"}`);
    }

    const calls = output.filter(isFunctionCall);
    await session.append(
      { type: "assistant/message", data: { turn, step, output, ...(response.usage ? { usage: response.usage } : {}) } },
      ...calls
        .filter((c) => !hangups.has(c.name))
        .map((c) => ({ type: "tool/call" as const, data: { turn, step, callId: c.call_id, name: c.name } })),
    );

    // Only if a provider ignores tool_choice "required": treat plain text as the final answer.
    if (calls.length === 0) {
      await session.append({ type: "step/end", data: { turn, step } }, turnEnd("completed"));
      return result(step, "completed", outputText(output));
    }

    // The tool/call markers are already in the log, so a run killed mid-tool is
    // recovered as "may or may not have taken effect"; results are written together.
    const hangingUp = calls.some((c) => hangups.has(c.name));
    let sendFailed = false;
    const results: NewEvent[] = [];
    for (const call of calls) {
      if (hangups.has(call.name)) continue;
      const output = await runTool(call.name, call.arguments, ctx);
      console.log(`[agent] tool ${call.name}(${call.arguments}) -> ${output.slice(0, 200)}`);
      sendFailed ||= talks.has(call.name) && output.startsWith("Error:");
      results.push({ type: "tool/result", data: { turn, step, callId: call.call_id, output } });
    }
    const unreachable = sendFailed && (o.unreachable?.() ?? false);
    const done = lastStep || unreachable || (hangingUp && !sendFailed);
    // Images a tool opened (read_file) are stored and shown after the step's tool results.
    const images = ctx.images.splice(0);
    const imageKeys = images.length
      ? await session.storeToolImages(`t${turn}s${step}`, images)
      : [];
    const reason: TurnEndReason = unreachable ? "unreachable" : !lastStep ? "completed" : outOfTime ? "out-of-time" : "max-steps";
    await session.append(
      ...results,
      ...calls
        .filter((c) => hangups.has(c.name))
        .map((c) => ({
          type: "tool/result" as const,
          data: { turn, step, callId: c.call_id, output: done ? "turn ended" : "not ended: a message failed to send, see the error above" },
        })),
      ...(imageKeys.length ? [{ type: "tool/images" as const, data: { turn, step, images: imageKeys } }] : []),
      { type: "step/end", data: { turn, step } },
      ...(done ? [turnEnd(reason)] : []),
    );
    if (done) return result(step, reason);

    // Unhandled messages and the ones this turn may still reply to stay verbatim.
    await compactIfNeeded(session, { systemPrompt: o.systemPrompt, tools, inputTokens: u.input_tokens ?? 0, keepFrom: o.pending[0]!.seq });
  }
}
