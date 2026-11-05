/**
 * The ToolContext of one run: how tools reach the chat, and what runs when the
 * run ends. Tools say what to deliver (text, an image URL, a file); this is
 * where that becomes a channel call.
 */
import { callBudgetMs } from "../agent/budget.js";
import type { ChannelAdapter, InboundMessage } from "../channels/types.js";
import { chatPeople, findByShortId } from "../conversation/people.js";
import type { Session } from "../conversation/session.js";
import { pcmToWav } from "../media/voice.js";
import type { Outgoing, ToolContext } from "../tools/types.js";
import type { Outbox } from "./outbox.js";
import type { ChatMeta } from "./types.js";

/** How a voice message reads in `sent` and on text-only channels: "[语音] " + its words. */
const VOICE_LABEL = "[语音] ";
/** "@#3B6834" in a message: the agent @-ing someone by the id it knows them by. */
const MENTION_REF = /@#([0-9A-Za-z]{6})(?![0-9A-Za-z])/g;

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

  // In a group, "@#3B6834" becomes the platform's mention of that person, if the log knows them;
  // an unknown id stays as written.
  const withMentions = (text: string): string => {
    if (meta.chatType !== "group" || !adapter.mentionTag || !text.includes("@#")) return text;
    const people = chatPeople(session.events);
    return text.replace(MENTION_REF, (ref, id: string) => {
      const person = findByShortId(people, id);
      return person ? adapter.mentionTag!(person.userId) : ref;
    });
  };

  // Sync channels (no `send`) collect text instead; an image becomes its label and URL,
  // a voice message its words. Channels without voice messages get a WAV file.
  const deliver = (m: Outgoing, msg: InboundMessage): Promise<void> => {
    if (m.kind === "file") return adapter.sendFile!(msg, m.file);
    if (m.kind === "voice" && !collect) {
      if (adapter.sendVoice) return adapter.sendVoice(msg, m.voice);
      if (adapter.sendFile) return adapter.sendFile(msg, { name: "voice.wav", data: pcmToWav(m.voice.pcm, m.voice.sampleRate) });
    }
    const text = m.kind === "text" ? withMentions(m.text) : m.kind === "voice" ? `${VOICE_LABEL}${m.voice.text}` : `${m.label} ${m.url}`;
    if (collect) return Promise.resolve(void collect.push(text));
    if (m.kind === "image" && adapter.sendImage) return adapter.sendImage(msg, m.url);
    return adapter.send!(msg, text);
  };

  const ctx: ToolContext = {
    sent: [],
    deadline,
    callBudgetMs: () => callBudgetMs(deadline),
    chat: { key: chatKey, scene: meta.chatType === "group" ? "群聊" : "私聊", sender: "?" },
    images: [],
    async send(message, replyTo) {
      if (message.kind === "file" && (collect || !adapter.sendFile)) throw new Error(`the ${adapter.name} channel can't send files`);
      const status = await outbox.deliver(replyTo ?? turnState.main, (msg) => deliver(message, msg));
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
