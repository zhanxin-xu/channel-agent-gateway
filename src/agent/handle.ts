/**
 * Channel-independent message pipeline:
 * de-duplicate → record the message → (sample) → agent loop → record the reply.
 *
 * Direct messages (DMs, @bot) always run the agent and get an answer.
 * Ambient messages (ordinary group chatter) are always recorded so the bot
 * has the context, but only one per AGENT_AMBIENT_INTERVAL_SECONDS per group
 * is shown to the agent, which may stay silent.
 *
 * History cleanup: each conversation is a Redis list trimmed to the newest
 * AGENT_HISTORY_LIMIT (private) / AGENT_GROUP_HISTORY_LIMIT (group) entries on
 * every write, and expires after AGENT_HISTORY_TTL_DAYS without messages.
 */
import type { ChannelAdapter, InboundMessage, OutgoingFile } from "../channels/types.js";
import { config } from "../config.js";
import { getStore } from "../store/index.js";
import { loadImageParts } from "./images.js";
import { runAgent, type AgentInputItem, type HistoryMessage, type MultimodalUserMessage } from "./loop.js";
import { closeWorkspace } from "./sandbox.js";
import { DEFAULT_STICKER_BASE_URL, stickerUrl } from "./stickers.js";
import { SYSTEM_PROMPT } from "./system-prompt.js";
import type { ToolContext } from "./tools.js";

const DEDUPE_TTL = 60 * 60; // platforms retry within minutes; keep an hour

/** A Redis list of JSON-encoded HistoryMessage, oldest first. */
const historyKey = (m: InboundMessage) => `chat:${m.channel}:${m.conversationId}`;

/** Guidance for an ambient run, appended after the history (see runAgent `note`). */
const AMBIENT_NOTE =
  "（系统提示）这次没人 @ 你，你只是在旁边看群聊。默认不说话：只调用 end_turn，就是不回复。" +
  "但如果这条明显是在跟你说话（接你的话、问你），就当成 @ 你，一定要回。" +
  "其他时候，只在有人聊到你、有梗能接、有图值得吐槽、有问题没人答而你知道时插话。" +
  "插话要短，一两句或一张表情包。";

const shortId = (m: InboundMessage) => `#${m.userId.slice(-6).toUpperCase() || "?"}`;
const senderLabel = (m: InboundMessage) => (m.senderName ? `${m.senderName} ${shortId(m)}` : shortId(m));

/**
 * Context line prepended to every user message (and kept in history), so the
 * model knows the current time and, in groups, who said what and whether
 * they were talking to it:
 *   [2026/11/03 周二 20:43 Asia/Shanghai｜群聊｜发送人 老王 #3B6834｜@你]
 * The sender is a stable short id (QQ only exposes per-bot openids), plus the
 * nickname when the platform sends one.
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
  const scene = m.chatType === "group" ? "群聊" : "私聊";
  const mention = m.chatType === "group" && m.mode !== "ambient" ? "｜@你" : "";
  return `[${time} ${timeZone}｜${scene}｜发送人 ${senderLabel(m)}${mention}]`;
}

/**
 * How messages reach the chat. Without `image`, stickers degrade to a text
 * line with the URL; without `file`, send_file fails with a tool error.
 */
export interface Deliver {
  text(text: string): Promise<void>;
  image?(url: string): Promise<void>;
  file?(file: OutgoingFile): Promise<void>;
}

/**
 * Handles one inbound message. The model talks by calling the `send_message` /
 * `send_sticker` tools, which deliver immediately; for direct messages, if it
 * never calls them, its final text is delivered as a fallback.
 *
 * Returns what was delivered (stickers as "[表情包：name]"; empty when the bot
 * stayed silent or the message was only recorded), or `undefined` when the
 * event was already handled (a webhook retry).
 */
export async function handleMessage(
  adapter: ChannelAdapter,
  message: InboundMessage,
  deliver: Deliver,
): Promise<string[] | undefined> {
  const store = getStore();
  const direct = message.mode !== "ambient";
  const key = historyKey(message);
  const limit = message.chatType === "group" ? config.agent.groupHistoryLimit : config.agent.historyLimit;
  const ttl = config.agent.historyTtlDays * 24 * 60 * 60;

  // De-duplicate. `seenKey` marks "this message is recorded"; direct handling
  // has its own key, so a message that arrives both as an ordinary group
  // message and as an @ event is recorded once and still answered once.
  const seenKey = `evt:${message.channel}:${message.eventId}`;
  if (direct && !(await store.claim(`${seenKey}:direct`, DEDUPE_TTL))) {
    console.log(`[handle] duplicate event ${message.channel}:${message.eventId}, skipped`);
    return undefined;
  }
  const firstSeen = await store.claim(seenKey, DEDUPE_TTL);
  if (!direct && !firstSeen) return undefined;

  const ctx: ToolContext = {
    sent: [],
    deadline: Date.now() + config.agent.maxDurationSeconds * 1000,
    chat: {
      key: `${message.channel}:${message.conversationId}`,
      scene: message.chatType === "group" ? "群聊" : "私聊",
      sender: senderLabel(message),
    },
    images: [],
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
    async sendFile(file) {
      if (!deliver.file) throw new Error(`the ${adapter.name} channel can't send files`);
      await deliver.file(file);
      this.sent.push(`[文件：${file.name}]`);
    },
  };

  if (direct && message.text === "/reset") {
    await store.del(key);
    await ctx.send("已清空本会话的历史记录。");
    return ctx.sent;
  }

  // Record the message first, so concurrent handlers see it in order.
  // Images are stored as "[图片]" placeholders; only the run for this message sees the pixels.
  const images = message.images ?? [];
  const body = [message.text, ...images.map(() => "[图片]")].filter(Boolean).join("\n");
  const userText = `${messageHeader(message)}\n${body}`;
  if (firstSeen) await store.append(key, [JSON.stringify({ role: "user", content: userText })], limit, ttl);

  // Ambient: at most one agent run per interval per conversation.
  if (!direct) {
    const interval = config.agent.ambientIntervalSeconds;
    if (!interval || !(await store.claim(`sample:${message.channel}:${message.conversationId}`, interval))) {
      return ctx.sent;
    }
  }

  // @ runs see the whole stored history; frequent ambient runs only the recent part.
  const history = (await store.list(key, direct ? undefined : config.agent.ambientContext)).map(
    (item) => JSON.parse(item) as HistoryMessage,
  );

  try {
    const started = Date.now();
    const input: AgentInputItem[] = history;
    // Look at this message's images (direct runs, and sampled ambient runs so the
    // bot can react to a picture): swap its history entry for a multimodal one.
    if (images.length) {
      const parts = await loadImageParts(images);
      const text = parts.length ? userText : `${userText}\n（图片没加载出来）`;
      const multimodal: MultimodalUserMessage = { role: "user", content: [{ type: "input_text", text }, ...parts] };
      const at = history.findLastIndex((m) => m.role === "user" && m.content === userText);
      if (at >= 0) input.splice(at, 1, multimodal);
      else input.push(multimodal); // recorded earlier by the ambient path, with a different header
    }

    const result = await runAgent({
      systemPrompt: [SYSTEM_PROMPT, adapter.promptHint].filter(Boolean).join("\n\n"),
      input,
      // In a busy group, point at the message to answer.
      note: !direct
        ? AMBIENT_NOTE
        : message.chatType === "group"
          ? `（系统提示）${senderLabel(message)} 刚 @ 了你：「${(body || "[图片]").slice(0, 100)}」，回复这条。`
          : undefined,
      ctx,
    });
    if (direct && ctx.sent.length === 0 && result.text) await ctx.send(result.text);
    console.log(
      `[handle] ${message.channel}:${message.conversationId} ${direct ? "direct" : "ambient"} steps=${result.steps} ` +
        `sent=${ctx.sent.length} reasoningTokens=${result.reasoningTokens ?? 0} ms=${Date.now() - started}`,
    );
    if (ctx.sent.length) {
      await store.append(key, [JSON.stringify({ role: "assistant", content: ctx.sent.join("\n") })], limit, ttl);
    }
  } catch (err) {
    console.error(`[handle] agent failed for ${message.channel}:${message.conversationId}`, err);
    if (direct && ctx.sent.length === 0) await ctx.send("抱歉，处理消息时出错了，请稍后再试。").catch(() => {});
  } finally {
    await closeWorkspace(ctx);
  }
  return ctx.sent;
}
