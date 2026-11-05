/**
 * Ingress, for every webhook: de-duplicate, log the message, and if it
 * wakes the agent and nobody else is running in this chat, take the lock
 * (the first three in one store transaction) and start the run.
 *
 * Async channels run in /api/worker (handoff.ts), so the webhook only logs
 * and every run gets a whole function to itself; only when the worker can't
 * be reached does the webhook run the agent itself. Sync channels run here:
 * the caller waits for the replies in this response.
 */
import { messageHeader, senderLabel } from "../channels/format.js";
import type { ChannelAdapter, InboundMessage } from "../channels/types.js";
import { config } from "../config.js";
import type { NewEvent } from "../conversation/events.js";
import { imagePrefix, storeChatImages } from "../media/images.js";
import { getStore } from "../store/index.js";
import { startWorker } from "./handoff.js";
import { LOCK_TTL_MS, RunLock } from "./lock.js";
import { runChat } from "./runner.js";
import type { ChatMeta } from "./types.js";
import { ambientIntervalSeconds } from "./sampler.js";

export interface HandleOptions {
  origin?: string;
  /** Sync channels (no `send`): replies are collected here instead of sent. */
  collect?: string[];
}

/**
 * Ingress for one inbound message. Returns "duplicate" for a platform retry,
 * "recorded" when the message was only logged, "busy" when another run holds
 * the chat (it will see the message), "dispatched" when the worker took the
 * run, or "handled" after running the agent here.
 */
export async function handleMessage(
  adapter: ChannelAdapter,
  message: InboundMessage,
  opts: HandleOptions = {},
): Promise<"duplicate" | "recorded" | "busy" | "dispatched" | "handled"> {
  // The function's clock started with this request.
  const deadline = Date.now() + config.agent.maxDurationSeconds * 1000;
  const store = getStore();
  const chat = `${message.channel}:${message.conversationId}`;
  const direct = message.mode !== "ambient";
  const meta: ChatMeta = { channel: message.channel, conversationId: message.conversationId, chatType: message.chatType, origin: opts.origin };
  const reset = direct && message.text.trim() === "/reset";

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
          mentioned: direct,
          ...(images.keys.length ? { images: images.keys } : {}),
          ...(images.failed ? { imagesFailed: images.failed } : {}),
          ...(message.attachments?.length ? { attachments: message.attachments } : {}),
          reply: message.replyContext,
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
    wake: !reset,
    ambientIntervalSeconds: ambientIntervalSeconds(),
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
  const ambientClaimed = !direct;
  if (opts.collect || !adapter.send || !opts.origin) {
    await runChat(adapter, meta, { collect: opts.collect, ambientClaimed, deadline, lock });
    return "handled";
  }
  await lock.release();
  if (await startWorker(opts.origin, { chatKey: chat, ambientClaimed })) return "dispatched";
  // No worker: run here. If it did start after all, it holds the chat and this run finds it busy.
  console.warn(`[ingress] ${chat}: running in the webhook instead`);
  await runChat(adapter, meta, { ambientClaimed, deadline });
  return "handled";
}
