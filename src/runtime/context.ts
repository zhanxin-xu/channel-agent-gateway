/**
 * The ToolContext of one run: how tools reach the chat, and what runs when the
 * run ends. Tools say what to deliver (text, an image URL, a file); this is
 * where that becomes a channel call.
 */
import { callBudgetMs } from "../agent/budget.js";
import { partsToText } from "../channels/format.js";
import type { ChannelAdapter, InboundMessage, TextPart } from "../channels/types.js";
import { chatPeople, mentionParts } from "../conversation/people.js";
import type { Session } from "../conversation/session.js";
import { pcmToWav } from "../media/voice.js";
import type { Outgoing, ToolContext } from "../tools/types.js";
import type { Outbox } from "./outbox.js";
import type { ChatMeta } from "./types.js";

/** How a voice message reads in `sent` and on text-only channels: "[语音] " + its words. */
const VOICE_LABEL = "[语音] ";

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

  // "@#3B6834" in a group message: a real mention where the channel can send one, "@昵称" elsewhere.
  const textParts = (text: string): TextPart[] =>
    meta.chatType === "group" && text.includes("@#") ? mentionParts(text, chatPeople(session.events)) : [text];

  // Sync channels (no `send`) collect text instead; an image becomes its label and URL,
  // a voice message its words. Channels without voice messages get a WAV file.
  const deliver = (m: Outgoing, msg: InboundMessage): Promise<void> => {
    if (m.kind === "file") return adapter.sendFile!(msg, m.file);
    if (m.kind === "voice" && !collect) {
      if (adapter.sendVoice) return adapter.sendVoice(msg, m.voice);
      if (adapter.sendFile) return adapter.sendFile(msg, { name: "voice.wav", data: pcmToWav(m.voice.pcm, m.voice.sampleRate) });
    }
    const parts = m.kind === "text" ? textParts(m.text) : [m.kind === "voice" ? `${VOICE_LABEL}${m.voice.text}` : `${m.label} ${m.url}`];
    if (collect) return Promise.resolve(void collect.push(partsToText(parts)));
    if (m.kind === "image" && adapter.sendImage) return adapter.sendImage(msg, m.url);
    if (adapter.sendMentions && parts.some((p) => typeof p !== "string")) return adapter.sendMentions(msg, parts);
    return adapter.send!(msg, partsToText(parts));
  };

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
      this.sent.push(
        message.kind === "text"
          ? message.text
          : message.kind === "image"
            ? message.label
            : message.kind === "voice"
              ? `${VOICE_LABEL}${message.voice.text}`
              : `[文件：${message.file.name}]`,
      );
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
