import { unreachableReason } from "../channels/net.js";
import type { ChannelAdapter, InboundMessage } from "../channels/types.js";
import { messageLabel, type SessionEvent } from "../conversation/events.js";
import type { Session } from "../conversation/session.js";
import type { ChatStore } from "../store/index.js";
import type { ChatMeta } from "./types.js";

/**
 * Replies go to a specific message (QQ: passive replies need its msg_id).
 * Each message's reply context is kept in the store as replies update it
 * (QQ's msg_seq, Telegram's quote-once flag, the reply count), so a later
 * turn or another instance continues where the last one stopped.
 */
/** Replies per inbound message when the channel sets no limit of its own: a cap on a looping model. */
const DEFAULT_MAX_REPLIES = 5;

export class Outbox {
  /**
   * Set when the platform couldn't be reached (after the adapter's own retry):
   * the rest of the run sends nothing and the turn ends; the next run tries again.
   */
  unreachable: string | undefined;

  constructor(
    private store: ChatStore,
    private adapter: ChannelAdapter,
    private session: Session,
    private meta: ChatMeta,
    private collect: string[] | undefined,
  ) {}

  private get maxReplies(): number {
    return this.adapter.maxRepliesPerMessage ?? DEFAULT_MAX_REPLIES;
  }

  private async context(target: SessionEvent<"user/message">): Promise<Record<string, string>> {
    return (await this.store.getReply(this.session.chatKey, target.data.eventId)) ?? { ...target.data.reply };
  }

  /** Under the reply cap and, where the channel has one (QQ), inside the reply window. */
  async canReply(seq: number): Promise<boolean> {
    if (this.unreachable) return false;
    const target = this.session.message(seq);
    if (!target) return false;
    const context = await this.context(target);
    return Number(context.replies ?? 0) < this.maxReplies && Date.now() <= Number(context.expiresAt ?? Infinity);
  }

  async deliver(seq: number, send: (message: InboundMessage) => Promise<void>): Promise<string> {
    if (this.unreachable) throw new Error(this.unreachable);
    const target = this.session.message(seq);
    if (!target) throw new Error(`${messageLabel(seq)} isn't in this chat; reply_to takes the N of a 第N条 label`);
    const replyContext = await this.context(target);
    const count = Number(replyContext.replies ?? 0);
    if (count >= this.maxReplies) {
      throw new Error(
        `already replied to ${messageLabel(seq)} ${this.maxReplies} times, the limit; reply to another message or call end_turn`,
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
      if (!this.collect) console.error(`[outbox] ${this.adapter.name} delivery to ${messageLabel(seq)} failed`, err);
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
      await this.store.putReply(this.session.chatKey, target.data.eventId, replyContext);
    }
    return `sent as a reply to ${messageLabel(seq)} (${count + 1}/${this.maxReplies})`;
  }
}
