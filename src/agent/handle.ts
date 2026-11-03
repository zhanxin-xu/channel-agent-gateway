/**
 * Channel-independent message pipeline:
 * de-duplicate → built-in commands → load history → agent loop → save history.
 */
import type { ChannelAdapter, InboundMessage } from "../channels/types.js";
import { config } from "../config.js";
import { getStore } from "../store/index.js";
import { runAgent, type HistoryMessage } from "./loop.js";
import { DEFAULT_STICKER_BASE_URL, stickerUrl } from "./stickers.js";
import { SYSTEM_PROMPT } from "./system-prompt.js";
import type { ToolContext } from "./tools.js";

const DEDUPE_TTL = 60 * 60; // platforms retry within minutes; keep an hour
const HISTORY_TTL = 7 * 24 * 60 * 60;

/** A Redis list of JSON-encoded HistoryMessage, oldest first. */
const historyKey = (m: InboundMessage) => `chat:${m.channel}:${m.conversationId}`;

/**
 * Context line prepended to every user message (and kept in history), so the
 * model knows the current time and, in groups, who said what:
 *   [2026/11/03 周二 20:43 Asia/Shanghai｜群聊｜发送人 #3B6834]
 * QQ only exposes per-bot openids, so the sender is a stable short id.
 */
export function messageHeader(m: InboundMessage, now = new Date()): string {
  const timeZone = config.agent.timezone;
  const time = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
  const shortId = `#${m.userId.slice(-6).toUpperCase() || "?"}`;
  const sender = m.senderName ? `${m.senderName} ${shortId}` : shortId;
  return `[${time} ${timeZone}｜${m.chatType === "group" ? "群聊" : "私聊"}｜发送人 ${sender}]`;
}

/** How messages reach the chat. Without `image`, stickers degrade to a text line with the URL. */
export interface Deliver {
  text(text: string): Promise<void>;
  image?(url: string): Promise<void>;
}

/**
 * Runs the agent for one inbound message. The model talks by calling the
 * `send_message` / `send_sticker` tools, which deliver immediately; if it
 * never calls them, its final text is delivered as a fallback.
 *
 * Returns what was delivered (stickers as "[表情包：name]"), or `undefined`
 * when the event was already handled (a webhook retry).
 */
export async function handleMessage(
  adapter: ChannelAdapter,
  message: InboundMessage,
  deliver: Deliver,
): Promise<string[] | undefined> {
  const store = getStore();
  if (!(await store.claim(`evt:${message.channel}:${message.eventId}`, DEDUPE_TTL))) {
    console.log(`[handle] duplicate event ${message.channel}:${message.eventId}, skipped`);
    return undefined;
  }

  const ctx: ToolContext = {
    sent: [],
    async send(text) {
      await deliver.text(text);
      this.sent.push(text);
    },
    async sendSticker(name) {
      const url = stickerUrl(config.stickerBaseUrl || DEFAULT_STICKER_BASE_URL, name);
      if (deliver.image) await deliver.image(url);
      else await deliver.text(`[表情包：${name}] ${url}`);
      this.sent.push(`[表情包：${name}]`);
    },
  };

  if (message.text === "/reset") {
    await store.del(historyKey(message));
    await ctx.send("已清空本会话的历史记录。");
    return ctx.sent;
  }

  const history = (await store.list(historyKey(message))).map((item) => JSON.parse(item) as HistoryMessage);

  const userText = `${messageHeader(message)}\n${message.text}`;

  try {
    const started = Date.now();
    const result = await runAgent({
      systemPrompt: [SYSTEM_PROMPT, adapter.promptHint].filter(Boolean).join("\n\n"),
      history,
      userText,
      ctx,
    });
    if (ctx.sent.length === 0 && result.text) await ctx.send(result.text);
    console.log(
      `[handle] ${message.channel}:${message.conversationId} steps=${result.steps} sent=${ctx.sent.length} ` +
        `reasoningTokens=${result.reasoningTokens ?? 0} ms=${Date.now() - started}`,
    );

    // Choosing not to reply is allowed; history then just records the user turn.
    const turn: HistoryMessage[] = [{ role: "user", content: userText }];
    if (ctx.sent.length) turn.push({ role: "assistant", content: ctx.sent.join("\n") });
    const items = turn.map((m) => JSON.stringify(m));
    await store.append(historyKey(message), items, config.agent.historyLimit, HISTORY_TTL);
  } catch (err) {
    console.error(`[handle] agent failed for ${message.channel}:${message.conversationId}`, err);
    if (ctx.sent.length === 0) await ctx.send("抱歉，处理消息时出错了，请稍后再试。").catch(() => {});
  }
  return ctx.sent;
}
