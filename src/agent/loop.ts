/**
 * Agent loop on the Responses API (`POST {baseURL}/responses`).
 *
 * OpenRouter's Responses API is stateless (no `previous_response_id`), so each
 * turn replays the transcript: the previous response's `output` items are
 * appended to `input` verbatim, followed by a `function_call_output` for every
 * `function_call`. Every request sets tool_choice "required", so the model
 * always acts through a tool. The loop ends when the model calls end_turn
 * (usually alongside its last message), or after the last step: when the step
 * budget runs out or the function is close to its time limit, a note asks the
 * model to wrap up with a message. In a step that ends the turn only the talk
 * tools run; if one of them fails (before the last step), the turn goes on so
 * the model can react.
 *
 * The request body is `{ model, ...OPENROUTER_EXTRA_BODY, instructions, input,
 * tools, tool_choice }`, so any provider-specific parameter (provider routing,
 * reasoning, max_output_tokens, …) can be set from config without code changes.
 */
import { config } from "../config.js";
import type { ImagePart } from "./images.js";
import { activeTools, END_TURN, runTool, type ToolContext } from "./tools.js";

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

/** A user message with images, for the current turn only (history stores text). */
export interface MultimodalUserMessage {
  role: "user";
  content: Array<{ type: "input_text"; text: string } | ImagePart>;
}

export type AgentInputItem = HistoryMessage | MultimodalUserMessage;

export interface AgentResult {
  text: string;
  steps: number;
  reasoningTokens?: number;
}

/** Responses API items we read; everything else is replayed untouched. */
type OutputItem =
  | { type: "message"; role: string; content?: Array<{ type: string; text?: string }> }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: string; [key: string]: unknown };

interface ResponsesResult {
  id?: string;
  status?: string;
  output?: OutputItem[];
  error?: { message?: string; code?: string } | null;
  incomplete_details?: { reason?: string } | null;
  usage?: { output_tokens_details?: { reasoning_tokens?: number } };
}

const isFunctionCall = (item: OutputItem): item is Extract<OutputItem, { type: "function_call" }> =>
  item.type === "function_call";

function outputText(output: OutputItem[]): string {
  return output
    .filter((item) => item.type === "message")
    .flatMap((item) => (item as Extract<OutputItem, { type: "message" }>).content ?? [])
    .filter((part) => part.type === "output_text" && part.text)
    .map((part) => part.text)
    .join("");
}

async function createResponse(body: Record<string, unknown>): Promise<ResponsesResult> {
  const { apiKey, baseUrl, extraHeaders, timeoutMs } = config.openrouter;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

  const res = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { ...extraHeaders, authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data: ResponsesResult;
  try {
    data = JSON.parse(text) as ResponsesResult;
  } catch {
    throw new Error(`Responses API HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!res.ok || data.error) {
    throw new Error(`Responses API HTTP ${res.status}: ${JSON.stringify(data.error ?? data).slice(0, 300)}`);
  }
  return data;
}

/** Tools that deliver to the chat; the only ones still run in the step that ends the turn. */
const TALK_TOOLS = new Set(["send_message", "send_sticker", "send_file"]);

/** Time kept for the last step (one model call plus sending) before the function's deadline. */
const LAST_STEP_RESERVE_MS = 90_000;

function lastStepNote(reason: string, mustReply: boolean): string {
  return mustReply
    ? `（系统提示）${reason}，这是最后一步：除了 send_message / send_sticker / send_file，这一步调用的其他工具都不会执行。` +
        "现在用 send_message 给对方发一条消息：说出已经得到的结果；没做完就说做到哪了、卡在哪、接下来怎么办。"
    : `（系统提示）${reason}，这是最后一步：其他工具不会再执行了。要插话就现在用 send_message 说，不说就直接结束。`;
}

export async function runAgent(opts: {
  systemPrompt: string;
  /** The conversation so far, oldest first; the message being answered is already in it. */
  input: AgentInputItem[];
  /**
   * Per-run guidance appended after the history as a developer message (not
   * stored). Kept out of `instructions` so the cached prompt prefix stays the same.
   */
  note?: string;
  maxSteps?: number;
  /** Someone is waiting for an answer (DM / @): the last-step note asks for a message. */
  mustReply?: boolean;
  ctx: ToolContext;
}): Promise<AgentResult> {
  const { model, extraBody } = config.openrouter;
  const maxSteps = opts.maxSteps ?? config.agent.maxSteps;

  const input: unknown[] = [...opts.input];
  if (opts.note) input.push({ role: "developer", content: opts.note });
  const toolDefs = activeTools().map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  let reasoningTokens = 0;
  for (let step = 1; ; step++) {
    // The last step starts early enough to finish before the function is killed (ctx.deadline).
    const outOfTime = opts.ctx.deadline - Date.now() < LAST_STEP_RESERVE_MS;
    const lastStep = step >= maxSteps || outOfTime;
    if (lastStep) {
      input.push({ role: "developer", content: lastStepNote(outOfTime ? "时间快用完了" : "步数用完了", opts.mustReply ?? false) });
    }
    const response = await createResponse({
      model,
      ...extraBody,
      instructions: opts.systemPrompt,
      input,
      tools: toolDefs,
      // Every step acts through a tool: talk with send_message, hang up with end_turn.
      tool_choice: "required",
    });

    reasoningTokens += response.usage?.output_tokens_details?.reasoning_tokens ?? 0;
    const output = response.output ?? [];
    if (response.status === "incomplete") {
      console.warn(`[agent] response incomplete: ${response.incomplete_details?.reason ?? "unknown"}`);
    }

    const calls = output.filter(isFunctionCall);
    // Only if a provider ignores tool_choice "required": treat plain text as the final answer.
    if (calls.length === 0) {
      return { text: outputText(output).trim(), steps: step, reasoningTokens };
    }
    const ending = lastStep || calls.some((c) => c.name === END_TURN);
    const results = new Map<string, string>();
    let sendFailed = false;
    for (const call of calls) {
      if (call.name === END_TURN) continue;
      if (ending && !TALK_TOOLS.has(call.name)) {
        console.log(`[agent] turn ending: skipped ${call.name}`);
        results.set(call.call_id, "skipped: you were ending the turn");
        continue;
      }
      const result = await runTool(call.name, call.arguments, opts.ctx);
      console.log(`[agent] tool ${call.name}(${call.arguments}) -> ${result.slice(0, 200)}`);
      results.set(call.call_id, result);
      sendFailed ||= TALK_TOOLS.has(call.name) && result.startsWith("Error:");
    }
    if (lastStep || (ending && !sendFailed)) {
      return { text: outputText(output).trim(), steps: step, reasoningTokens };
    }

    // Replay everything the model produced (reasoning, messages, calls) in order.
    input.push(...output);
    for (const call of calls) {
      const output = call.name === END_TURN ? "not ended: a message failed to send, see the error above" : results.get(call.call_id)!;
      input.push({ type: "function_call_output", call_id: call.call_id, output });
    }
    // Images a tool opened (read_file) go in as a user message after the outputs,
    // which every Responses API provider accepts; they're not stored in history.
    if (opts.ctx.images.length) {
      const images = opts.ctx.images.splice(0);
      input.push({ role: "user", content: [{ type: "input_text", text: "（系统提示）read_file 打开的图片：" }, ...images] });
    }

  }
}
