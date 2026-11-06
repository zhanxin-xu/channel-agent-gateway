/**
 * Ingress, for every webhook: de-duplicate, log the message, and if it
 * wakes the agent and nobody else is running in this chat, take the lock
 * and run (runner.ts). The first three happen in one store transaction.
 *
 * The run starts right here, in the webhook's function; its time budget
 * counts from this request. A turn that outlasts the function is continued
 * in /api/worker (handoff.ts).
 */
import { messageHeader, senderLabel } from "../channels/format.js";
import { recordHistory } from "../chats/history.js";
import { ambientInterval, chatProfile, replyMode } from "../chats/profile.js";
import type { ChannelAdapter, InboundMessage } from "../channels/types.js";
import { config } from "../config.js";
import type { NewEvent } from "../conversation/events.js";
import { imagePrefix, storeChatImages } from "../media/images.js";
import { getStore } from "../store/index.js";
import { LOCK_TTL_MS, RunLock } from "./lock.js";
import { runChat } from "./runner.js";
import type { ChatMeta } from "./types.js";

export interface HandleOptions {
  origin?: string;
  /** Sync channels (no `send`): replies are collected here instead of sent. */
  collect?: string[];
}

/**
 * Ingress for one inbound message. Returns "duplicate" for a platform retry,
 * "ignored" when the chat is blocked, "recorded" when the message was only
 * logged, "busy" when another run holds the chat (it will see the message),
 * or "handled" after running the agent.
 *
 * The chat's profile decides what happens (chats/profile.ts): blocked chats
 * are dropped, record-only chats log quiet messages that never wake the agent,
 * and the ambient interval is the chat's own.
 */
export async function handleMessage(
  adapter: ChannelAdapter,
  message: InboundMessage,
  opts: HandleOptions = {},
): Promise<"duplicate" | "ignored" | "recorded" | "busy" | "handled"> {
  // The function's clock started with this request.
  const deadline = Date.now() + config.agent.maxDurationSeconds * 1000;
  const store = getStore();
  const chat = `${message.channel}:${message.conversationId}`;
  const direct = message.mode !== "ambient";
  const meta: ChatMeta = { channel: message.channel, conversationId: message.conversationId, chatType: message.chatType, origin: opts.origin };
  const reset = direct && message.text.trim() === "/reset";
  const profile = await chatProfile(chat);
  const mode = replyMode(profile);
  if (mode === "block") {
    console.log(`[ingress] ${chat} is blocked, dropped ${message.eventId}`);
    return "ignored";
  }
  const quiet = mode === "record";

  // Images are stored before the message that references them (a retry stores them again under the same keys).
  const images =
    !reset && message.images?.length
      ? await storeChatImages(store, chat, imagePrefix(chat, message.eventId), message.images)
      : { keys: [], failed: 0 };
  const event: NewEvent = reset
    ? { type: "session/reset", data: {} }
    : {
        type: "user/message",
        data: {
          eventId: message.eventId,
          header: messageHeader(message),
          text: message.text,
          sender: senderLabel(message),
          ...(message.userId ? { userId: message.userId } : {}),
          ...(message.mentions?.length ? { mentions: message.mentions } : {}),
          mentioned: direct,
          ...(images.keys.length ? { images: images.keys } : {}),
          ...(images.failed ? { imagesFailed: images.failed } : {}),
          ...(message.attachments?.length ? { attachments: message.attachments } : {}),
          reply: message.replyContext,
          ...(message.adminHint ? { replyVia: message.adminHint.replyVia } : {}),
          ...(quiet ? { quiet: true as const } : {}),
        },
      };

  // One transaction: de-duplicate, log, and if this wakes the agent, take the lock.
  const lock = new RunLock(store, chat);
  const [{ status }] = await Promise.all([
    store.ingest({
      chat,
      channel: message.channel,
      conversationId: message.conversationId,
      chatType: message.chatType,
      origin: opts.origin,
      eventId: message.eventId,
      direct,
      event,
      // /reset starts the log over; a message seen before that comes back as an @ is marked, not logged twice.
      reset,
      upgrade: direct ? { type: "user/mentioned", data: { eventId: message.eventId } } : undefined,
      wake: !reset && !quiet,
      ambientIntervalSeconds: ambientInterval(profile),
      lockOwner: lock.owner,
      lockTtlMs: LOCK_TTL_MS,
    }),
    // Keyed by the platform's id, so a retry isn't recorded twice.
    reset
      ? undefined
      : recordHistory(chat, [
          {
            id: message.eventId,
            role: message.adminHint ? "hint" : "user",
            sender: senderLabel(message),
            text: [message.text, images.keys.length ? `[图片×${images.keys.length}]` : ""].filter(Boolean).join(" "),
          },
        ]),
  ]);
  if (status === "duplicate") {
    console.log(`[ingress] duplicate event ${message.channel}:${message.eventId}, skipped`);
    return "duplicate";
  }
  if (reset) {
    if (quiet) return "recorded";
    const done = "已清空本会话的历史记录。";
    if (opts.collect) opts.collect.push(done);
    else await adapter.send?.(message, done);
    return "handled";
  }
  if (status !== "acquired") return status;
  // An ambient message that woke the agent claimed the sampler window in ingest; the run inherits the claim.
  await runChat(adapter, meta, { collect: opts.collect, ambientClaimed: !direct, deadline, lock });
  return "handled";
}
