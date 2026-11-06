/**
 * Ingress, for every webhook: de-duplicate, log the message, and if it
 * wakes the agent and nobody else is running in this chat, take the lock
 * and run (runner.ts). The first three happen in one store transaction.
 *
 * The run starts right here, in the webhook's function; its time budget
 * counts from this request. A turn that outlasts the function is continued
 * in /api/worker (handoff.ts).
 */
import crypto from "node:crypto";
import { messageHeader, senderLabel } from "../channels/format.js";
import { ambientInterval, chatProfile, replyMode } from "../chats/profile.js";
import type { ChannelAdapter, InboundMessage } from "../channels/types.js";
import { config } from "../config.js";
import type { NewEvent } from "../conversation/events.js";
import { imagePrefix, storeChatImages } from "../media/images.js";
import { getStore } from "../store/index.js";
import { LOCK_TTL_MS, RunLock } from "./lock.js";
import { runChat } from "./runner.js";
import type { ChatMeta } from "./types.js";

/**
 * Start a chat's log over from outside a message (the admin console), the way
 * /reset does. False when the chat has no session.
 */
export async function resetLog(chat: string): Promise<boolean> {
  const store = getStore();
  const { session } = await store.open(chat, Number.MAX_SAFE_INTEGER);
  if (!session) return false;
  await store.ingest({
    chat,
    channel: session.channel,
    conversationId: session.conversationId,
    chatType: session.chatType,
    eventId: `reset-${crypto.randomUUID()}`,
    direct: false,
    event: { type: "session/reset", data: {} },
    reset: true,
    wake: false,
    ambientIntervalSeconds: 0,
    lockOwner: "",
    lockTtlMs: 0,
  });
  return true;
}

export interface HandleOptions {
  origin?: string;
  /** Sync channels (no `send`): replies are collected here instead of sent. */
  collect?: string[];
  /**
   * The message is an admin's whisper, not from the platform (admin/chat-actions.ts):
   * replies go through this platform message (an eventId in the chat).
   */
  replyVia?: string;
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
  const profile = await chatProfile(chat);
  const mode = replyMode(profile);
  if (mode === "block") {
    console.log(`[ingress] ${chat} is blocked, dropped ${message.eventId}`);
    return "ignored";
  }
  const quiet = mode === "record";
  // A record-only chat answers nothing, /reset included: it's logged like any other message.
  const reset = direct && !quiet && message.text.trim() === "/reset";

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
          ...(opts.replyVia ? { replyVia: opts.replyVia } : {}),
          ...(quiet ? { quiet: true as const } : {}),
        },
      };

  // One transaction: de-duplicate, log, and if this wakes the agent, take the lock.
  const lock = new RunLock(store, chat);
  const { status } = await store.ingest({
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
  });
  if (status === "duplicate") {
    console.log(`[ingress] duplicate event ${message.channel}:${message.eventId}, skipped`);
    return "duplicate";
  }
  if (reset) {
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
