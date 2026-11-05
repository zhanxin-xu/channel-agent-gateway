/**
 * The people of a chat, as far as its log knows them: everyone who wrote or
 * was @-mentioned in it. Platforms like QQ give bots no member list, so this
 * is the closest there is: the agent looks people up here (chat_members), and
 * "@#3B6834" in its messages becomes a mention of the person it names.
 *
 * People are told apart by their short id ("#3B6834", what the agent knows
 * them by), so senders logged before messages kept the full platform id still
 * count: their label carries the short id and the nickname. Only people with a
 * known platform id can really be mentioned.
 */
import { shortId } from "../channels/format.js";
import type { TextPart } from "../channels/types.js";
import { isEvent, type SessionEvent } from "./events.js";

export interface ChatPerson {
  /** "#3B6834". */
  id: string;
  /** The full platform id, once a message of theirs logged it. */
  userId?: string;
  /** The latest display name seen. */
  name?: string;
  /** When they last wrote or were mentioned (epoch ms). */
  lastSeen: number;
}

/** A sender label ("老王 #3B6834", or just "#3B6834") split into its parts. */
function parseLabel(label: string): { id: string; name?: string } | undefined {
  const match = /^(?:(.*\S)\s+)?(#[0-9A-Z?]{1,6})$/.exec(label.trim());
  return match ? { id: match[2]!, ...(match[1] ? { name: match[1] } : {}) } : undefined;
}

/** Everyone the log has seen, most recently seen first. */
export function chatPeople(events: SessionEvent[]): ChatPerson[] {
  const people = new Map<string, ChatPerson>();
  const see = (id: string, seen: { userId?: string; name?: string }, time: number) => {
    const known = people.get(id);
    people.set(id, {
      id,
      userId: seen.userId ?? known?.userId,
      name: seen.name ?? known?.name,
      lastSeen: Math.max(time, known?.lastSeen ?? 0),
    });
  };
  for (const e of events) {
    if (!isEvent(e, "user/message")) continue;
    const sender = parseLabel(e.data.sender);
    if (sender) see(sender.id, { userId: e.data.userId, name: sender.name }, e.time);
    for (const m of e.data.mentions ?? []) see(shortId(m.userId), m, e.time);
  }
  return [...people.values()].sort((a, b) => b.lastSeen - a.lastSeen);
}

/** "@#3B6834" in a message: the agent @-ing someone by the id it knows them by. */
const MENTION_REF = /@(#[0-9A-Za-z]{6})(?![0-9A-Za-z])/g;

/**
 * A message split into words and mentions. "@#3B6834" becomes a mention of
 * that person when their platform id is known, "@昵称" when only their name
 * is, and stays as written for an id the log has never seen.
 */
export function mentionParts(text: string, people: ChatPerson[]): TextPart[] {
  const byId = new Map(people.map((p) => [p.id, p]));
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(MENTION_REF)) {
    const person = byId.get(match[1]!.toUpperCase());
    if (!person || (!person.userId && !person.name)) continue;
    parts.push(text.slice(last, match.index));
    parts.push(person.userId ? { mention: { userId: person.userId, ...(person.name ? { name: person.name } : {}) } } : `@${person.name}`);
    last = match.index + match[0].length;
  }
  parts.push(text.slice(last));
  return parts.filter((p) => p !== "");
}
