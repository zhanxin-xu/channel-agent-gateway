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
 * Handing over: a webhook appends first, then tries the lock; a run releases
 * the lock, then checks for work once more. So a message can't fall in the
 * gap. A run that is about to run out of time with work left hands over to
 * /api/worker (worker.ts), which starts a fresh function.
 */
import crypto from "node:crypto";
import type { ChannelAdapter, InboundMessage, OutgoingFile } from "../channels/types.js";
import { config } from "../config.js";
import { getStore, type Store } from "../store/index.js";
import { EventLog, isEvent, messageLabel, recoverOpenTurn, type SessionEvent } from "./events.js";
import { storeChatImages } from "./images.js";
import { MAX_MESSAGES_PER_TURN } from "./limits.js";
import { LAST_STEP_RESERVE_MS, runTurn } from "./loop.js";
import { closeWorkspace } from "./sandbox.js";
import { chatKeys, migrateLegacyHistory, RunLock, Session, ttlSeconds } from "./session.js";
import { DEFAULT_STICKER_BASE_URL, stickerUrl } from "./stickers.js";
import { SYSTEM_PROMPT } from "./system-prompt.js";
import type { ToolContext } from "./tools.js";

const DEDUPE_TTL = 60 * 60; // platforms retry within minutes; keep an hour
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

/** What a run needs to reply in a chat, kept in the store for runs started by the worker. */
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
  const chatKey = `${message.channel}:${message.conversationId}`;
  const keys = chatKeys(chatKey);
  const direct = message.mode !== "ambient";
  const ttl = ttlSeconds();

  // De-duplicate. `seenKey` marks "this message is logged"; direct handling has
  // its own key, so a message that arrives both as an ordinary group message
  // and as an @ event is logged once and still wakes the agent once.
  const seenKey = `evt:${message.channel}:${message.eventId}`;
  if (direct && !(await store.claim(`${seenKey}:direct`, DEDUPE_TTL))) {
    console.log(`[handle] duplicate event ${message.channel}:${message.eventId}, skipped`);
    return "duplicate";
  }
  const firstSeen = await store.claim(seenKey, DEDUPE_TTL);
  if (!direct && !firstSeen) return "duplicate";

  const meta: ChatMeta = { channel: message.channel, conversationId: message.conversationId, chatType: message.chatType, origin: opts.origin };
  await store.set(keys.meta, JSON.stringify(meta), ttl * 1000);
  const log = new EventLog(store, chatKey, ttl);

  if (direct && message.text.trim() === "/reset") {
    await log.append({ type: "session/reset", data: {} });
    const done = "已清空本会话的历史记录。";
    if (opts.collect) opts.collect.push(done);
    else await adapter.send?.(message, done);
    return "handled";
  }

  if (firstSeen) {
    const images = message.images?.length
      ? await storeChatImages(store, keys.images(message.eventId), message.images, ttl)
      : { keys: [], failed: 0 };
    await log.append({
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
    });
  } else {
    await log.append({ type: "user/mentioned", data: { eventId: message.eventId } });
  }

  // Ordinary group messages wake the agent at most once per interval per group.
  if (!direct && !(await claimAmbient(store, keys.sample))) return "recorded";
  return (await runChat(adapter, meta, { collect: opts.collect, ambientClaimed: !direct, deadline })) ? "handled" : "busy";
}

async function claimAmbient(store: Store, key: string): Promise<boolean> {
  const interval = config.agent.ambientIntervalSeconds;
  return interval > 0 && store.claim(key, interval);
}

/**
 * Run the agent for a chat if no one else is: take the lock, handle turns
 * until nothing is pending, release, look once more. Returns false when
 * another run holds the lock.
 */
export async function runChat(
  adapter: ChannelAdapter,
  meta: ChatMeta,
  opts: { collect?: string[]; ambientClaimed?: boolean; deadline?: number } = {},
): Promise<boolean> {
  const store = getStore();
  const chatKey = `${meta.channel}:${meta.conversationId}`;
  // Every round of this function shares one deadline: when the platform kills it.
  const deadline = opts.deadline ?? Date.now() + config.agent.maxDurationSeconds * 1000;
  let ambientClaimed = opts.ambientClaimed ?? false;
  for (let round = 0; ; round++) {
    const lock = new RunLock(store, chatKeys(chatKey).lock);
    if (!(await lock.acquire())) return round > 0;
    let outcome: "idle" | "handoff";
    let session: Session;
    try {
      ({ outcome, session } = await drain(store, adapter, meta, { collect: opts.collect, ambientClaimed, deadline }));
    } finally {
      await lock.release();
    }
    if (outcome === "handoff") {
      await handOff(meta, chatKey);
      return true;
    }
    // Something may have arrived after the last check, while its webhook couldn't get the lock.
    // (If another run took over meanwhile, a stale read only costs a lock attempt: that run handles it.)
    await session.refresh();
    const pending = session.messagesAfter(await session.cursor());
    if (!pending.length) return true;
    if (!pending.some((m) => m.data.mentioned) && !(await claimAmbient(store, chatKeys(chatKey).sample))) return true;
    ambientClaimed = true;
  }
}

async function drain(
  store: Store,
  adapter: ChannelAdapter,
  meta: ChatMeta,
  opts: { collect?: string[]; ambientClaimed: boolean; deadline: number },
): Promise<{ outcome: "idle" | "handoff"; session: Session }> {
  const chatKey = `${meta.channel}:${meta.conversationId}`;
  const keys = chatKeys(chatKey);
  const deadline = opts.deadline;
  const session = await Session.open(store, chatKey);
  await migrateLegacyHistory(store, session);

  // A run that was killed left its turn open: close it the way dsh does.
  const fixes = recoverOpenTurn(session.events);
  if (fixes.length) {
    console.warn(`[handle] ${chatKey}: closing an interrupted turn`);
    await session.append(...fixes);
  }
  // Nothing before the latest /reset is visible any more.
  const reset = session.events.findLast((e) => isEvent(e, "session/reset"));
  if (reset && reset.seq > session.base) await session.trimBefore(reset.seq);

  const outbox = new Outbox(store, adapter, session, meta, opts.collect);
  const turnState = { main: -1 };
  const ctx = makeToolContext(adapter, meta, chatKey, deadline, outbox, turnState, opts.collect);
  let ambientClaimed = opts.ambientClaimed;

  const done = (outcome: "idle" | "handoff") => ({ outcome, session });
  try {
    for (let turns = 0; ; turns++) {
      // Session.open just read the log; after a turn, read what arrived during it.
      if (turns > 0) await session.refresh();
      const pending = session.messagesAfter(await session.cursor());
      if (!pending.length) return done("idle");
      const direct = pending.some((m) => m.data.mentioned);
      if (!direct && !ambientClaimed && !(await claimAmbient(store, keys.sample))) return done("idle");
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
    private store: Store,
    private adapter: ChannelAdapter,
    private session: Session,
    private meta: ChatMeta,
    private collect: string[] | undefined,
  ) {}

  private key(target: SessionEvent<"user/message">) {
    return chatKeys(this.session.chatKey).reply(target.data.eventId);
  }

  private async context(target: SessionEvent<"user/message">): Promise<Record<string, string>> {
    const saved = await this.store.get(this.key(target));
    return saved ? (JSON.parse(saved) as Record<string, string>) : { ...target.data.reply };
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
      await this.store.set(this.key(target), JSON.stringify(replyContext), ttlSeconds() * 1000);
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
