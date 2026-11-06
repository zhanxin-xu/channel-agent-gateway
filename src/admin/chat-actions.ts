/**
 * What an admin can do in a chat besides reading it:
 *   - say: send a message in the bot's name. It is logged as admin/message,
 *     which the model reads as something it said itself.
 *   - whisper: tell the bot something the chat doesn't see; it is logged as a
 *     message to the bot (an @) and the bot answers in its own words.
 *   - reset (like /reset) and unlock (take a stuck run's lock).
 *
 * Platforms like QQ only take replies to a recent message (5 minutes in a
 * group, 60 in a DM; 5 replies each), so both say and whisper ride on the
 * newest message that can still take a reply, the same budget the bot uses.
 */
import crypto from "node:crypto";
import { channels } from "../channels/index.js";
import type { ChannelAdapter, InboundMessage } from "../channels/types.js";
import { isEvent, type SessionEvent } from "../conversation/events.js";
import { chatPeople } from "../conversation/people.js";
import { deliverOutgoing } from "../runtime/deliver.js";
import { handleMessage } from "../runtime/ingress.js";
import { Outbox, type MessageLookup } from "../runtime/outbox.js";
import type { ChatMeta } from "../runtime/types.js";
import { getStore, type SessionState } from "../store/index.js";
import { HttpError } from "./http.js";

/** How far back to look for a message that can take a reply. */
const RECENT_EVENTS = 200;
const MAX_TEXT = 2000;

interface ChatContext {
  session: SessionState;
  meta: ChatMeta;
  adapter: ChannelAdapter;
  /** Recent events, oldest first. */
  events: SessionEvent[];
  outbox: Outbox;
}

async function openChat(chat: string, origin?: string): Promise<ChatContext> {
  const store = getStore();
  const { session, events } = await store.recentEvents(chat, Number.MAX_SAFE_INTEGER, RECENT_EVENTS);
  if (!session) throw new HttpError(404, "这个聊天没有进行中的会话（7 天没人说话会被清理），等有人说话再试");
  const adapter = channels.get(session.channel);
  if (!adapter?.send) throw new HttpError(400, `${session.channel} 渠道不能主动发消息`);
  const meta: ChatMeta = { channel: session.channel, conversationId: session.conversationId, chatType: session.chatType, origin: origin ?? session.origin ?? undefined };
  const ordered = (events as SessionEvent[]).slice().reverse();
  const lookup: MessageLookup = {
    chatKey: chat,
    message: (seq) => ordered.find((e): e is SessionEvent<"user/message"> => e.seq === seq && isEvent(e, "user/message")),
  };
  return { session, meta, adapter, events: ordered, outbox: new Outbox(store, adapter, lookup, meta, undefined) };
}

/** The newest message from the platform (not an admin's whisper) that can still take a reply. */
async function replyTarget(c: ChatContext): Promise<SessionEvent<"user/message"> | undefined> {
  const messages = c.events.filter((e): e is SessionEvent<"user/message"> => isEvent(e, "user/message") && !e.data.replyVia);
  for (let i = messages.length - 1; i >= 0; i--) if (await c.outbox.canReply(messages[i]!.seq)) return messages[i];
  return undefined;
}

export interface ReplyWindow {
  /** Whether the bot can be made to say something now. */
  open: boolean;
  /** Why not, for people to read. */
  reason?: string;
  seq?: number;
  sender?: string;
  replies?: number;
  max?: number;
  closesAt?: number;
}

/** What say / whisper would reply to now. */
export async function replyWindow(chat: string): Promise<ReplyWindow> {
  let c: ChatContext;
  try {
    c = await openChat(chat);
  } catch (err) {
    if (err instanceof HttpError) return { open: false, reason: err.message };
    throw err;
  }
  const target = await replyTarget(c);
  if (!target) {
    return {
      open: false,
      reason: c.adapter.name === "qq" ? "QQ 只能回复最近的消息：群里 5 分钟内、私聊 60 分钟内要有人说话，每条最多回 5 次" : "最近没有能回复的消息",
    };
  }
  const state = await c.outbox.replyState(target.seq);
  return { open: true, seq: target.seq, sender: target.data.sender, ...state };
}

function checkText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw new HttpError(400, "内容是空的");
  if (trimmed.length > MAX_TEXT) throw new HttpError(400, `最多 ${MAX_TEXT} 个字`);
  return trimmed;
}

/** Send `text` in the bot's name. "@#3B6834" mentions someone, as when the bot writes it. */
export async function say(chat: string, text: string): Promise<{ seq: number; status: string }> {
  const body = checkText(text);
  const c = await openChat(chat);
  const target = await replyTarget(c);
  if (!target) throw new HttpError(409, (await replyWindow(chat)).reason ?? "现在发不出去");
  const status = await c.outbox.deliver(target.seq, (msg) =>
    deliverOutgoing(c.adapter, c.meta, { kind: "text", text: body }, msg, { people: () => chatPeople(c.events) }),
  );
  const store = getStore();
  const seq = await store.appendUnlocked(chat, [{ type: "admin/message", data: { text: body } }]);
  await store.log("say", chat, { text: body, replyTo: target.seq });
  return { seq, status };
}

/**
 * Tell the bot something only it sees; it answers in this chat in its own
 * words. Runs the agent the way a message from the chat would (in the
 * background, via `background`).
 */
export async function whisper(chat: string, text: string, origin: string, background: (p: Promise<unknown>) => void): Promise<{ eventId: string }> {
  const body = checkText(text);
  const c = await openChat(chat, origin);
  const target = await replyTarget(c);
  if (!target) throw new HttpError(409, (await replyWindow(chat)).reason ?? "现在发不出去");
  const eventId = `admin-${crypto.randomUUID()}`;
  const message: InboundMessage = {
    channel: c.meta.channel,
    eventId,
    conversationId: c.meta.conversationId,
    chatType: c.meta.chatType,
    mode: "direct",
    userId: "admin",
    senderName: "管理员",
    text: `（管理员悄悄告诉你，${c.meta.chatType === "group" ? "群里" : "对方"}看不到这句）${body}`,
    replyContext: { ...target.data.reply },
    adminHint: { replyVia: target.data.eventId },
  };
  await getStore().log("whisper", chat, { text: body, replyTo: target.seq });
  background(handleMessage(c.adapter, message, { origin }).catch((err) => console.error(`[admin] whisper to ${chat} failed`, err)));
  return { eventId };
}

/** Start the chat's context over, like /reset. */
export async function resetChat(chat: string): Promise<void> {
  const store = getStore();
  const { session } = await store.open(chat, Number.MAX_SAFE_INTEGER);
  if (!session) throw new HttpError(404, "这个聊天没有进行中的会话");
  await store.ingest({
    chat,
    channel: session.channel,
    conversationId: session.conversationId,
    chatType: session.chatType,
    eventId: `admin-reset-${crypto.randomUUID()}`,
    direct: false,
    event: { type: "session/reset", data: {} },
    reset: true,
    wake: false,
    ambientIntervalSeconds: 0,
    lockOwner: "admin",
    lockTtlMs: 0,
  });
  await store.log("reset", chat, {});
}

export async function unlockChat(chat: string): Promise<boolean> {
  const store = getStore();
  const released = await store.unlock(chat);
  await store.log("unlock", chat, { released });
  return released;
}
