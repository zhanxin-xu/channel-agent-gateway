/**
 * Telegram Bot API over webhook.
 *
 * Register with:
 *   https://api.telegram.org/bot<TOKEN>/setWebhook?url=<BASE>/api/webhook/telegram&secret_token=<SECRET>
 * Telegram then sends `X-Telegram-Bot-Api-Secret-Token: <SECRET>` on every update.
 */
import crypto from "node:crypto";
import { config } from "../config.js";
import { chunkText, json, type ChannelAdapter, type OutgoingFile, type ReceiveResult } from "./types.js";

const MAX_CHUNK = 4000;

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number; type: "private" | "group" | "supergroup" | "channel" };
    from?: { id: number; first_name?: string; last_name?: string; username?: string };
  };
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

async function tg(method: string, body: unknown): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Telegram ${method} failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
}

/** Multipart upload (sendPhoto / sendAnimation / sendDocument with file bytes). */
async function tgUpload(method: string, fields: Record<string, string>, field: string, file: OutgoingFile): Promise<void> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  form.set(field, new Blob([new Uint8Array(file.data)]), file.name);
  const res = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/${method}`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`Telegram ${method} failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
}

export const telegramAdapter: ChannelAdapter = {
  name: "telegram",
  promptHint: "This is Telegram: reply in plain text, no Markdown syntax.",

  isConfigured() {
    return Boolean(config.telegram.botToken && config.telegram.webhookSecret);
  },

  async receive(req, rawBody): Promise<ReceiveResult> {
    const secret = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
    if (!safeEqual(secret, config.telegram.webhookSecret)) {
      return { kind: "respond", response: json({ error: "invalid secret" }, 401) };
    }

    let update: TelegramUpdate;
    try {
      update = JSON.parse(rawBody) as TelegramUpdate;
    } catch {
      return { kind: "respond", response: json({ error: "invalid json" }, 400) };
    }

    const msg = update.message;
    let text = msg?.text?.trim() ?? "";
    if (!msg || !text) return { kind: "respond", response: json({ ok: true }) };

    if (msg.chat.type !== "private") {
      // In groups only answer explicit mentions, and only if we know our username.
      const mention = config.telegram.botUsername ? `@${config.telegram.botUsername}` : "";
      if (!mention || !text.includes(mention)) return { kind: "respond", response: json({ ok: true }) };
      text = text.replaceAll(mention, "").trim();
    }

    const chatId = String(msg.chat.id);
    return {
      kind: "message",
      message: {
        channel: "telegram",
        eventId: String(update.update_id),
        conversationId: chatId,
        chatType: msg.chat.type === "private" ? "private" : "group",
        userId: String(msg.from?.id ?? ""),
        senderName:
          [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || msg.from?.username || undefined,
        text,
        replyContext: { chatId, messageId: String(msg.message_id) },
      },
      ack: json({ ok: true }),
    };
  },

  async typing(message) {
    await tg("sendChatAction", { chat_id: message.replyContext.chatId, action: "typing" });
  },

  // Called once per outgoing message; only the first one quotes the user's message.
  async send(message, text) {
    for (const chunk of chunkText(text, MAX_CHUNK)) {
      await tg("sendMessage", { chat_id: message.replyContext.chatId, text: chunk, ...quoteOnce(message.replyContext) });
    }
  },

  async sendImage(message, url) {
    const ctx = message.replyContext;
    // GIFs go through sendAnimation so they play instead of showing a still frame.
    if (/\.gif$/i.test(url)) await tg("sendAnimation", { chat_id: ctx.chatId, animation: url, ...quoteOnce(ctx) });
    else await tg("sendPhoto", { chat_id: ctx.chatId, photo: url, ...quoteOnce(ctx) });
  },

  async sendFile(message, file) {
    const ctx = message.replyContext;
    const quote = quoteOnce(ctx);
    const fields: Record<string, string> = { chat_id: ctx.chatId! };
    if (quote.reply_parameters) fields.reply_parameters = JSON.stringify(quote.reply_parameters);
    if (/\.gif$/i.test(file.name)) await tgUpload("sendAnimation", fields, "animation", file);
    else if (/\.(png|jpe?g|webp)$/i.test(file.name)) await tgUpload("sendPhoto", fields, "photo", file);
    else await tgUpload("sendDocument", fields, "document", file);
  },
};

function quoteOnce(ctx: Record<string, string>) {
  if (ctx.replied === "1") return {};
  ctx.replied = "1";
  return { reply_parameters: { message_id: Number(ctx.messageId), allow_sending_without_reply: true } };
}
