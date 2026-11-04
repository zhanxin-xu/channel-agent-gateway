/**
 * The ToolContext of one run: how tools reach the chat, and what runs when the
 * run ends. Tools say what to deliver (text, an image URL, a file); this is
 * where that becomes a channel call.
 */
import type { ChannelAdapter, InboundMessage } from "../channels/types.js";
import type { Session } from "../conversation/session.js";
import type { Outgoing, ToolContext } from "../tools/types.js";
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

  // Sync channels (no `send`) collect text instead; an image becomes its label and URL.
  const deliver = (m: Outgoing, msg: InboundMessage): Promise<void> => {
    if (m.kind === "file") return adapter.sendFile!(msg, m.file);
    const text = m.kind === "text" ? m.text : `${m.label} ${m.url}`;
    if (collect) return Promise.resolve(void collect.push(text));
    if (m.kind === "image" && adapter.sendImage) return adapter.sendImage(msg, m.url);
    return adapter.send!(msg, text);
  };

  const ctx: ToolContext = {
    sent: [],
    deadline,
    chat: { key: chatKey, scene: meta.chatType === "group" ? "群聊" : "私聊", sender: "?" },
    images: [],
    async send(message, replyTo) {
      if (message.kind === "file" && (collect || !adapter.sendFile)) throw new Error(`the ${adapter.name} channel can't send files`);
      const status = await outbox.deliver(replyTo ?? turnState.main, (msg) => deliver(message, msg));
      this.sent.push(message.kind === "text" ? message.text : message.kind === "image" ? message.label : `[文件：${message.file.name}]`);
      return status;
    },
    onRunEnd(fn) {
      cleanups.push(fn);
    },
    attachments(seq) {
      const message = session.message(seq);
      return message ? (message.data.attachments ?? []) : undefined;
    },
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
