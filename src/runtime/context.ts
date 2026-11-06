/**
 * The ToolContext of one run: how tools reach the chat, and what runs when the
 * run ends. Tools say what to deliver (text, an image URL, a file); this is
 * where that becomes a channel call.
 */
import { callBudgetMs } from "../agent/budget.js";
import type { ChannelAdapter, InboundMessage } from "../channels/types.js";
import { recordHistory } from "../chats/history.js";
import { chatPeople } from "../conversation/people.js";
import type { Session } from "../conversation/session.js";
import type { Outgoing, ToolContext } from "../tools/types.js";
import { deliverOutgoing, VOICE_LABEL } from "./deliver.js";
import type { Outbox } from "./outbox.js";
import type { ChatMeta } from "./types.js";

export function makeToolContext(
  adapter: ChannelAdapter,
  meta: ChatMeta,
  chatKey: string,
  deadline: number,
  outbox: Outbox,
  session: Session,
  turnState: { main: number },
  collect: string[] | undefined,
): { ctx: ToolContext; endRun(): Promise<void> } {
  const cleanups: Array<() => Promise<void> | void> = [];

  const deliver = (m: Outgoing, msg: InboundMessage) => deliverOutgoing(adapter, meta, m, msg, { people: () => chatPeople(session.events), collect });

  const ctx: ToolContext = {
    sent: [],
    deadline,
    callBudgetMs: () => callBudgetMs(deadline),
    chat: { key: chatKey, scene: meta.chatType === "group" ? "群聊" : "私聊", sender: "?" },
    images: [],
    async send(message, replyTo, opts) {
      if (message.kind === "file" && (collect || !adapter.sendFile)) throw new Error(`the ${adapter.name} channel can't send files`);
      // The copy keeps the same replyContext object: the adapter's updates to it (QQ's msg_seq) are saved.
      const status = await outbox.deliver(replyTo ?? turnState.main, (msg) => deliver(message, opts?.quote ? { ...msg, quote: true } : msg));
      const said =
        message.kind === "text"
          ? message.text
          : message.kind === "image"
            ? message.label
            : message.kind === "voice"
              ? `${VOICE_LABEL}${message.voice.text}`
              : `[文件：${message.file.name}]`;
      this.sent.push(said);
      await recordHistory(chatKey, [{ role: "bot", text: said }]);
      return status;
    },
    onRunEnd(fn) {
      cleanups.push(fn);
    },
    attachments(seq) {
      const message = session.message(seq);
      return message ? (message.data.attachments ?? []) : undefined;
    },
    people: () => chatPeople(session.events),
  };

  return {
    ctx,
    async endRun() {
      for (const fn of cleanups.splice(0).reverse()) {
        try {
          await fn();
        } catch (err) {
          console.warn(`[runner] cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },
  };
}
