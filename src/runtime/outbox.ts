import { PushRefusedError, unreachableReason } from "../channels/net.js";
import type { ChannelAdapter, InboundMessage } from "../channels/types.js";
import { messageLabel, type SessionEvent } from "../conversation/events.js";
import { REPLY_WINDOW_CLOSED } from "../conversation/undelivered.js";
import type { ChatStore } from "../store/index.js";
import type { ChatMeta } from "./types.js";

/** The messages replies can go to: a running Session, or a snapshot of recent events (admin/chat-actions.ts). */
export interface MessageLookup {
  readonly chatKey: string;
  message(seq: number): SessionEvent<"user/message"> | undefined;
}

/** Replies per inbound message when the channel sets no limit of its own: a cap on a looping model. */
const DEFAULT_MAX_REPLIES = 5;

/**
 * Replies go to a specific message (QQ: passive replies need its msg_id).
 * Each message's reply context is kept in the store as replies update it
 * (QQ's msg_seq, Telegram's quote-once flag, the reply count), so a later
 * turn or another instance continues where the last one stopped.
 */
export class Outbox {
  /**
   * Set when the platform couldn't be reached (after the adapter's own retry):
   * the rest of the run sends nothing and the turn ends; the next run tries again.
   */
  unreachable: string | undefined;

  constructor(
    private store: Pick<ChatStore, "getReply" | "putReply">,
    private adapter: ChannelAdapter,
    private messages: MessageLookup,
    private meta: ChatMeta,
    private collect: string[] | undefined,
  ) {}

  private get maxReplies(): number {
    return this.adapter.maxRepliesPerMessage ?? DEFAULT_MAX_REPLIES;
  }

  private async context(target: SessionEvent<"user/message">): Promise<Record<string, string>> {
    return (await this.store.getReply(this.messages.chatKey, replyKey(target))) ?? { ...target.data.reply };
  }

  /**
   * How many replies message `seq` has had and may have, when its reply window
   * closes (QQ), and whether a reply now would go out as a push (the window
   * closed, but the channel takes pushes).
   */
  async replyState(seq: number): Promise<{ replies: number; max: number; closesAt?: number; push: boolean; open: boolean } | undefined> {
    const target = this.messages.message(seq);
    if (!target) return undefined;
    const context = await this.context(target);
    const closesAt = Number(context.expiresAt);
    const closed = windowClosed(context);
    const push = closed && (this.adapter.canPush?.(context) ?? false);
    return {
      replies: Number(context.replies ?? 0),
      max: this.maxReplies,
      ...(Number.isFinite(closesAt) ? { closesAt } : {}),
      push,
      open: !closed || push,
    };
  }

  /**
   * Under the reply cap, and inside the reply window where the channel has one
   * (QQ) and can't push past it. `inWindow`: as a real reply only, not a push.
   */
  async canReply(seq: number, opts: { inWindow?: boolean } = {}): Promise<boolean> {
    if (this.unreachable) return false;
    const state = await this.replyState(seq);
    return Boolean(state && state.replies < state.max && state.open && !(opts.inWindow && state.push));
  }

  async deliver(seq: number, send: (message: InboundMessage) => Promise<void>): Promise<string> {
    if (this.unreachable) throw new Error(this.unreachable);
    const target = this.messages.message(seq);
    if (!target) throw new Error(`${messageLabel(seq)} isn't in this chat; reply_to takes the N of a 第N条 label`);
    const replyContext = await this.context(target);
    const push = windowClosed(replyContext);
    if (push && !this.adapter.canPush?.(replyContext)) {
      // Older messages are closed too, and waiting won't reopen this one: the model should stop and say it later.
      throw new DeliveryRefusedError(seq, "the platform no longer takes replies to it");
    }
    const count = Number(replyContext.replies ?? 0);
    if (count >= this.maxReplies) {
      throw new Error(
        `already replied to ${messageLabel(seq)} ${this.maxReplies} times, the limit; reply to another message or call end_turn`,
      );
    }
    const message: InboundMessage = {
      channel: this.meta.channel,
      eventId: replyKey(target),
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
      if (!this.collect) console.error(`[outbox] ${this.adapter.name} delivery to ${messageLabel(seq)} failed`, err);
      // Like a closed window: no use trying other messages; someone writing opens a new window.
      if (err instanceof PushRefusedError) throw new DeliveryRefusedError(seq, err.message);
      const reason = unreachableReason(err);
      if (reason) {
        // Retrying or rephrasing can't help, and each try waits out another timeout.
        this.unreachable =
          `${this.adapter.name} can't be reached right now (${reason}); nothing was sent. ` +
          "Stop for this turn: don't retry or rephrase, call end_turn. Later messages will try again.";
        throw new Error(this.unreachable);
      }
      throw err;
    } finally {
      await this.store.putReply(this.messages.chatKey, replyKey(target), replyContext);
    }
    return push
      ? `sent to the chat as a message of its own (${messageLabel(seq)}'s reply window has closed; ${count + 1}/${this.maxReplies})`
      : `sent as a reply to ${messageLabel(seq)} (${count + 1}/${this.maxReplies})`;
  }
}

/**
 * Nothing was sent, and nothing will be until someone writes again: the
 * message's reply window closed and the channel can't push, or the platform
 * refused the push. The text starts with REPLY_WINDOW_CLOSED, which tells the
 * model to stop and remember it for later (conversation/undelivered.ts);
 * `reason` is why, for people.
 */
export class DeliveryRefusedError extends Error {
  override name = "DeliveryRefusedError";
  constructor(
    seq: number,
    readonly reason: string,
  ) {
    super(
      `${REPLY_WINDOW_CLOSED} for ${messageLabel(seq)}: ${reason}, so nothing was sent. ` +
        "Don't retry on another old message: reply_to a newer one if it's still open, otherwise call end_turn. " +
        "You'll be reminded of what you wanted to say next turn, when someone writes again.",
    );
  }
}

/** Where replies to a message are tracked: its own platform message, or the one it replies via. */
const replyKey = (m: SessionEvent<"user/message">) => m.data.replyVia ?? m.data.eventId;

/** Channels with a reply window (QQ) put its end in the reply context. */
const windowClosed = (context: Record<string, string>) => Date.now() > Number(context.expiresAt ?? Infinity);
