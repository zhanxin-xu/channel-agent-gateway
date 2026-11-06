/**
 * Turning something to deliver (tools/types.ts Outgoing) into a channel call:
 * shared by the agent's tools (context.ts) and an admin sending in the bot's
 * name (admin/send.ts).
 */
import { partsToText } from "../channels/format.js";
import type { ChannelAdapter, InboundMessage, TextPart } from "../channels/types.js";
import { mentionParts, type ChatPerson } from "../conversation/people.js";
import { pcmToWav } from "../media/voice.js";
import type { Outgoing } from "../tools/types.js";
import type { ChatMeta } from "./types.js";

/** How a voice message reads in `sent` and on text-only channels: "[语音] " + its words. */
export const VOICE_LABEL = "[语音] ";

/**
 * Deliver `m` as a reply to `msg`. "@#3B6834" in a group text becomes a real
 * mention where the channel can send one, "@昵称" elsewhere. Sync channels
 * (`collect`) get text instead; an image becomes its label and URL, a voice
 * message its words. Channels without voice messages get a WAV file.
 */
export function deliverOutgoing(
  adapter: ChannelAdapter,
  meta: ChatMeta,
  m: Outgoing,
  msg: InboundMessage,
  opts: { people: () => ChatPerson[]; collect?: string[] },
): Promise<void> {
  const { collect } = opts;
  if (m.kind === "file") return adapter.sendFile!(msg, m.file);
  if (m.kind === "voice" && !collect) {
    if (adapter.sendVoice) return adapter.sendVoice(msg, m.voice);
    if (adapter.sendFile) return adapter.sendFile(msg, { name: "voice.wav", data: pcmToWav(m.voice.pcm, m.voice.sampleRate) });
  }
  const textParts = (text: string): TextPart[] => (meta.chatType === "group" && text.includes("@#") ? mentionParts(text, opts.people()) : [text]);
  const parts = m.kind === "text" ? textParts(m.text) : [m.kind === "voice" ? `${VOICE_LABEL}${m.voice.text}` : `${m.label} ${m.url}`];
  if (collect) return Promise.resolve(void collect.push(partsToText(parts)));
  if (m.kind === "image" && adapter.sendImage) return adapter.sendImage(msg, m.url);
  if (adapter.sendMentions && parts.some((p) => typeof p !== "string")) return adapter.sendMentions(msg, parts);
  return adapter.send!(msg, partsToText(parts));
}
