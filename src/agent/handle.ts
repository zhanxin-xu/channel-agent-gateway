/**
 * Channel-independent message pipeline, in two decoupled halves that only
 * talk through the chat's event log (events.ts):
 *
 *   Ingress (every webhook): de-duplicate → append the message to the log →
 *   decide whether to wake the agent. @ / DMs always wake it; ordinary group
 *   messages at most once per AGENT_AMBIENT_INTERVAL_SECONDS per group.
 *
 *   Run (whoever wins the chat's lock): turn after turn, take every message
 *   not handled yet, run the agent loop on the log (loop.ts), move the cursor.
 *   One run per chat at a time, so several people talking at once get one
 *   answer, and messages that arrive mid-turn reach the running loop.
 *
 * Handing over: a webhook appends and tries the lock in one transaction
 * (ChatStore.ingest); a run releases the lock, then checks for work once more.
 * So a message can't fall in the gap. A run that is about to run out of time with work left hands over to
 * /api/worker (worker.ts), which starts a fresh function.
 */
import crypto from "node:crypto";
import type { ChannelAdapter, InboundMessage, OutgoingFile } from "../channels/types.js";
import { config } from "../config.js";
import { getStore, type ChatStore } from "../store/index.js";
import { messageLabel, recoverOpenTurn, type NewEvent, type SessionEvent } from "./events.js";
import { imagePrefix, storeChatImages } from "./images.js";
import { MAX_MESSAGES_PER_TURN } from "./limits.js";
import { LAST_STEP_RESERVE_MS, runTurn } from "./loop.js";
import { closeWorkspace } from "./sandbox.js";
import { LOCK_TTL_MS, RunLock, Session } from "./session.js";
import { DEFAULT_STICKER_BASE_URL, stickerUrl } from "./stickers.js";
import { SYSTEM_PROMPT } from "./system-prompt.js";
import type { ToolContext } from "./tools.js";

/** A new turn starts only with this much time left; otherwise the run hands over to /api/worker. */
const HANDOFF_BELOW_MS = LAST_STEP_RESERVE_MS + 30_000;

const shortId = (m: InboundMessage) => `#${m.userId.slice(-6).toUpperCase() || "?"}`;
const senderLabel = (m: InboundMessage) => (m.senderName ? `${m.senderName} ${shortId(m)}` : shortId(m));

/**
 * The context line of a message, kept in the log; the model sees it as
 *   [第12条｜2026/11/03周二 20:43 Asia/Shanghai｜群聊｜发送人 老王 #3B6834｜@你]
 * (the 第N条 number is the event's seq). The sender is a stable short id (QQ
 * only exposes per-bot openids), plus the nickname when the platform sends one.
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
  return `${time} ${timeZone}｜${scene}｜发送人 ${senderLabel(m)}${mention}`;
}

/** What a run needs to reply in a chat; the session row keeps it for runs started by the worker. */
export interface ChatMeta {
  channel: string;
  conversationId: string;
  chatType: "private" | "group";
  /** Public origin of this deployment, for the worker hand-off. */
  origin?: string;
}

export interface HandleOptions {
  origin?: string;
  /** Sync channels (no `send`): replies are collected here instead of sent. */
  collect?: string[];
}

/**
 * Ingress for one inbound message. Returns "duplicate" for a platform retry,
 * "recorded" when the message was only logged, "busy" when another run holds
 * the chat (it will see the message), or "handled" after running the agent.
 */
export async function handleMessage(
  adapter: ChannelAdapter,
  message: InboundMessage,
  opts: HandleOptions = {},
): Promise<"duplicate" | "recorded" | "busy" | "handled"> {
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
    wake: !reset,
    ambientIntervalSeconds: config.agent.ambientIntervalSeconds,
    lockOwner: lock.owner,
    lockTtlMs: LOCK_TTL_MS,
  });
  if (status === "duplicate") {
    console.log(`[handle] duplicate event ${message.channel}:${message.eventId}, skipped`);
    return "duplicate";
  }
  if (reset) {
    const done = "已清空本会话的历史记录。";
    if (opts.collect) opts.collect.push(done);
    else await adapter.send?.(message, done);
    return "handled";
  }
  if (status !== "acquired") return status;
  await runChat(adapter, meta, { collect: opts.collect, ambientClaimed: !direct, deadline, lock });
  return "handled";
}

/**
 * Run the agent for a chat if no one else is: take the lock, handle turns
 * until nothing is pending, release, look once more. Returns false when
 * another run holds the lock.
 */
export async function runChat(
  adapter: ChannelAdapter,
  meta: ChatMeta,
  opts: { collect?: string[]; ambientClaimed?: boolean; deadline?: number; lock?: RunLock } = {},
): Promise<boolean> {
  const store = getStore();
  const chatKey = `${meta.channel}:${meta.conversationId}`;
  // Every round of this function shares one deadline: when the platform kills it.
  const deadline = opts.deadline ?? Date.now() + config.agent.maxDurationSeconds * 1000;
  let ambientClaimed = opts.ambientClaimed ?? false;
  for (let round = 0; ; round++) {
    // The webhook's ingest may already have taken the lock for this run.
    let lock: RunLock;
    if (round === 0 && opts.lock) {
      lock = opts.lock;
      lock.hold();
    } else {
      lock = new RunLock(store, chatKey);
      if (!(await lock.acquire())) return round > 0;
    }
    let outcome: "idle" | "handoff";
    let session: Session | null;
    try {
      ({ outcome, session } = await drain(store, adapter, meta, { collect: opts.collect, ambientClaimed, deadline }));
    } finally {
      await lock.release();
    }
    if (outcome === "handoff") {
      await handOff(meta, chatKey);
      return true;
    }
    if (!session) return true;
    // Something may have arrived after the last check, while its webhook couldn't get the lock.
    // (If another run took over meanwhile, a stale read only costs a lock attempt: that run handles it.)
    await session.refresh();
    const pending = session.messagesAfter(session.cursor);
    if (!pending.length) return true;
    if (!pending.some((m) => m.data.mentioned) && !(await store.claimAmbient(chatKey, config.agent.ambientIntervalSeconds))) {
      return true;
    }
    ambientClaimed = true;
  }
}

async function drain(
  store: ChatStore,
  adapter: ChannelAdapter,
  meta: ChatMeta,
  opts: { collect?: string[]; ambientClaimed: boolean; deadline: number },
): Promise<{ outcome: "idle" | "handoff"; session: Session | null }> {
  const chatKey = `${meta.channel}:${meta.conversationId}`;
  const deadline = opts.deadline;
  const session = await Session.open(store, chatKey);
  if (!session) return { outcome: "idle", session };

  // A run that was killed left its turn open: close it the way dsh does.
  const fixes = recoverOpenTurn(session.events);
  if (fixes.length) {
    console.warn(`[handle] ${chatKey}: closing an interrupted turn`);
    await session.append(...fixes);
  }

  const outbox = new Outbox(store, adapter, session, meta, opts.collect);
  const turnState = { main: -1 };
  const ctx = makeToolContext(adapter, meta, chatKey, deadline, outbox, turnState, opts.collect);
  let ambientClaimed = opts.ambientClaimed;

  const done = (outcome: "idle" | "handoff") => ({ outcome, session });
  try {
    for (let turns = 0; ; turns++) {
      // Session.open just read the log; after a turn, read what arrived during it.
      if (turns > 0) await session.refresh();
      const pending = session.messagesAfter(session.cursor);
      if (!pending.length) return done("idle");
      const direct = pending.some((m) => m.data.mentioned);
      if (!direct && !ambientClaimed && !(await store.claimAmbient(chatKey, config.agent.ambientIntervalSeconds))) {
        return done("idle");
      }
      ambientClaimed = false;
      if (deadline - Date.now() < HANDOFF_BELOW_MS) return done("handoff");

      // Replies go by default to the newest @ (else newest) message that can still take one.
      const main = (await findLastAsync(pending.filter((m) => m.data.mentioned), (m) => outbox.canReply(m.seq))) ??
        (await findLastAsync(pending, (m) => outbox.canReply(m.seq))) ??
        pending.at(-1)!;
      turnState.main = main.seq;
      ctx.sent = [];
      ctx.chat.sender = main.data.sender;
      const turn = await session.nextTurn();
      const started = Date.now();
      try {
        const result = await runTurn({
          session,
          ctx,
          systemPrompt: [SYSTEM_PROMPT, adapter.promptHint].filter(Boolean).join("\n\n"),
          turn,
          trigger: direct ? "direct" : "ambient",
          pending,
          main,
          canReply: () => outbox.canReply(main.seq),
        });
        if (direct && ctx.sent.length === 0 && result.text) await ctx.send(result.text).catch(() => {});
        await session.setCursor(result.handledUpTo);
        console.log(
          `[turn] ${chatKey} #${turn} ${direct ? "direct" : "ambient"} pending=${pending.length} steps=${result.steps} ` +
            `end=${result.reason} sent=${ctx.sent.length} input=${result.usage.input} cached=${result.usage.cached} ` +
            `reasoning=${result.usage.reasoning} ms=${Date.now() - started}`,
        );
      } catch (err) {
        console.error(`[handle] turn ${turn} failed for ${chatKey}`, err);
        await session.setCursor(pending.at(-1)!.seq);
        if (direct && ctx.sent.length === 0) await ctx.send("抱歉，处理消息时出错了，请稍后再试。").catch(() => {});
      }
    }
  } finally {
    await closeWorkspace(ctx);
  }
}

async function findLastAsync<T>(items: T[], ok: (item: T) => Promise<boolean>): Promise<T | undefined> {
  for (let i = items.length - 1; i >= 0; i--) if (await ok(items[i]!)) return items[i];
  return undefined;
}

function makeToolContext(
  adapter: ChannelAdapter,
  meta: ChatMeta,
  chatKey: string,
  deadline: number,
  outbox: Outbox,
  turnState: { main: number },
  collect: string[] | undefined,
): ToolContext {
  return {
    sent: [],
    deadline,
    chat: { key: chatKey, scene: meta.chatType === "group" ? "群聊" : "私聊", sender: "?" },
    images: [],
    async send(text, replyTo) {
      const status = await outbox.deliver(replyTo ?? turnState.main, (msg) =>
        collect ? Promise.resolve(void collect.push(text)) : adapter.send!(msg, text),
      );
      this.sent.push(text);
      return status;
    },
    async sendSticker(name, replyTo) {
      const url = stickerUrl(config.stickerBaseUrl || DEFAULT_STICKER_BASE_URL, name);
      const fallback = `[表情包：${name}] ${url}`;
      const status = await outbox.deliver(replyTo ?? turnState.main, (msg) =>
        collect
          ? Promise.resolve(void collect.push(fallback))
          : adapter.sendImage
            ? adapter.sendImage(msg, url)
            : adapter.send!(msg, fallback),
      );
      this.sent.push(`[表情包：${name}]`);
      return status;
    },
    async sendFile(file: OutgoingFile, replyTo) {
      const sendFile = adapter.sendFile;
      if (collect || !sendFile) throw new Error(`the ${adapter.name} channel can't send files`);
      const status = await outbox.deliver(replyTo ?? turnState.main, (msg) => sendFile.call(adapter, msg, file));
      this.sent.push(`[文件：${file.name}]`);
      return status;
    },
  };
}

/**
 * Replies go to a specific message (QQ: passive replies need its msg_id).
 * Each message's reply context is kept in the store as replies update it
 * (QQ's msg_seq, Telegram's quote-once flag, the reply count), so a later
 * turn or another instance continues where the last one stopped.
 */
class Outbox {
  constructor(
    private store: ChatStore,
    private adapter: ChannelAdapter,
    private session: Session,
    private meta: ChatMeta,
    private collect: string[] | undefined,
  ) {}

  private async context(target: SessionEvent<"user/message">): Promise<Record<string, string>> {
    return (await this.store.getReply(this.session.chatKey, target.data.eventId)) ?? { ...target.data.reply };
  }

  /** Under the reply cap and, where the channel has one (QQ), inside the reply window. */
  async canReply(seq: number): Promise<boolean> {
    const target = this.session.message(seq);
    if (!target) return false;
    const context = await this.context(target);
    return Number(context.replies ?? 0) < MAX_MESSAGES_PER_TURN && Date.now() <= Number(context.expiresAt ?? Infinity);
  }

  async deliver(seq: number, send: (message: InboundMessage) => Promise<void>): Promise<string> {
    const target = this.session.message(seq);
    if (!target) throw new Error(`${messageLabel(seq)} isn't in this chat; reply_to takes the N of a 第N条 label`);
    const replyContext = await this.context(target);
    const count = Number(replyContext.replies ?? 0);
    if (count >= MAX_MESSAGES_PER_TURN) {
      throw new Error(
        `already replied to ${messageLabel(seq)} ${MAX_MESSAGES_PER_TURN} times, the limit; reply to another message or call end_turn`,
      );
    }
    const message: InboundMessage = {
      channel: this.meta.channel,
      eventId: target.data.eventId,
      conversationId: this.meta.conversationId,
      chatType: this.meta.chatType,
      userId: "",
      text: "",
      replyContext,
    };
    try {
      await send(message);
      replyContext.replies = String(count + 1);
    } catch (err) {
      if (!this.collect) console.error(`[handle] ${this.adapter.name} delivery to ${messageLabel(seq)} failed`, err);
      throw err;
    } finally {
      await this.store.putReply(this.session.chatKey, target.data.eventId, replyContext);
    }
    return `sent as a reply to ${messageLabel(seq)} (${count + 1}/${MAX_MESSAGES_PER_TURN})`;
  }
}

/** Signature of a hand-off request body. */
export function workerSignature(body: string): string {
  return crypto.createHmac("sha256", config.workerSecret).update(body).digest("hex");
}

/** Ask /api/worker to carry on in a fresh function (this one is about to run out of time). */
async function handOff(meta: ChatMeta, chatKey: string): Promise<void> {
  if (!meta.origin) {
    console.warn(`[handle] ${chatKey}: out of time with work left, but no origin to hand off to`);
    return;
  }
  const body = JSON.stringify({ chatKey });
  try {
    const res = await fetch(`${meta.origin}/api/worker`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-worker-signature": workerSignature(body) },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    console.log(`[handle] ${chatKey}: handed off to the worker (HTTP ${res.status})`);
  } catch (err) {
    console.error(`[handle] ${chatKey}: hand-off failed`, err);
  }
}
