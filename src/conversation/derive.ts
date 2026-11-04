/** The model input, derived from the event log. */
import { isEvent, userMessageText, visibleWindow, type SessionEvent } from "./events.js";

const SUMMARY_PREFIX = "（系统提示）以下是更早对话的摘要，原文已经删除：\n";

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
