/**
 * The people of a chat, as far as its log knows them: everyone who wrote or
 * was @-mentioned in it. Platforms like QQ give bots no member list, so this
 * is the closest there is: the agent looks people up here (chat_members) and
 * the gateway turns "@#3B6834" into a real mention with it.
 */
import { shortId } from "../channels/format.js";
import { isEvent, type SessionEvent } from "./events.js";

export interface ChatPerson {
  userId: string;
  /** The latest display name seen. */
  name?: string;
  /** When they last wrote or were mentioned (epoch ms). */
  lastSeen: number;
}

/** The sender's name from their label ("老王 #3B6834" → "老王"); undefined when the label is only the id. */
function nameFromLabel(label: string, userId: string): string | undefined {
  const suffix = ` ${shortId(userId)}`;
  return label.endsWith(suffix) ? label.slice(0, -suffix.length) || undefined : undefined;
}

/** Everyone the log has seen, most recently seen first. */
export function chatPeople(events: SessionEvent[]): ChatPerson[] {
  const people = new Map<string, ChatPerson>();
  const see = (userId: string, name: string | undefined, time: number) => {
    const known = people.get(userId);
    people.set(userId, { userId, name: name ?? known?.name, lastSeen: Math.max(time, known?.lastSeen ?? 0) });
  };
  for (const e of events) {
    if (!isEvent(e, "user/message")) continue;
    const { userId, sender, mentions } = e.data;
    if (userId) see(userId, nameFromLabel(sender, userId), e.time);
    for (const m of mentions ?? []) see(m.userId, m.name, e.time);
  }
  return [...people.values()].sort((a, b) => b.lastSeen - a.lastSeen);
}

/** The person a "#3B6834"-style id points to (the most recently seen, should two share it). */
export function findByShortId(people: ChatPerson[], id: string): ChatPerson | undefined {
  const wanted = `#${id.replace(/^#/, "").toUpperCase()}`;
  return people.find((p) => shortId(p.userId) === wanted);
}
