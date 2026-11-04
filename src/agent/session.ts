/**
 * A chat's event log as seen by the one agent run that holds the chat's lock:
 * an in-memory copy kept current by reading only the events appended since
 * the last read. Webhooks may append at any time; only the lock holder
 * reads, recovers, compacts and trims.
 *
 * Keys (all expire after AGENT_HISTORY_TTL_DAYS without writes):
 *   ev:{chat}            the event list (see events.ts)
 *   ev:base:{chat}       how many events were deleted from the front
 *   ev:cursor:{chat}     seq of the last user message a turn has handled
 *   ev:turn:{chat}       turn counter
 *   ev:lock:{chat}       the run lock (a lease, renewed while running)
 *   ev:meta:{chat}       channel / conversation / origin, for runs started by the worker
 *   ev:reply:{chat}:{id} a message's reply context as updated by replies (QQ msg_seq, reply count)
 *   ev:img:{chat}:{id}:n images
 */
import crypto from "node:crypto";
import { config } from "../config.js";
import type { Store } from "../store/index.js";
import { deriveInput, EventLog, isEvent, visibleWindow, type NewEvent, type SessionEvent } from "./events.js";

export const LOCK_TTL_MS = 60_000;
const LOCK_RENEW_MS = 20_000;

export const ttlSeconds = () => config.agent.historyTtlDays * 24 * 60 * 60;

export function chatKeys(chatKey: string) {
  return {
    cursor: `ev:cursor:${chatKey}`,
    turn: `ev:turn:${chatKey}`,
    lock: `ev:lock:${chatKey}`,
    meta: `ev:meta:${chatKey}`,
    reply: (eventId: string) => `ev:reply:${chatKey}:${eventId}`,
    images: (eventId: string) => `ev:img:${chatKey}:${eventId}`,
    sample: `sample:${chatKey}`,
  };
}

/** Warm instances keep each chat's events, so a new run only reads what was appended since. */
const cache = new Map<string, { base: number; events: SessionEvent[] }>();
const CACHE_CHATS = 50;

export class Session {
  events: SessionEvent[] = [];
  base = 0;
  private imageCache = new Map<string, string | null>();
  /** Only the lock holder moves the cursor, so it is read once per run. */
  private cursorValue?: number;

  private constructor(
    readonly store: Store,
    readonly log: EventLog,
  ) {}

  static async open(store: Store, chatKey: string): Promise<Session> {
    const session = new Session(store, new EventLog(store, chatKey, ttlSeconds()));
    session.base = await session.log.base();
    const hit = cache.get(chatKey);
    if (hit && hit.base === session.base) session.events = [...hit.events];
    await session.refresh();
    return session;
  }

  get chatKey() {
    return this.log.chatKey;
  }

  /** Seq of the next event to read. */
  private get next(): number {
    return (this.events.at(-1)?.seq ?? this.base - 1) + 1;
  }

  /** Read everything appended since the last read. Returns the new events. */
  async refresh(): Promise<SessionEvent[]> {
    const fresh = await this.log.read(this.next, this.base);
    this.events.push(...fresh);
    this.remember();
    return fresh;
  }

  /**
   * Append and read back, so the in-memory copy has the log's real order even
   * when a webhook appended in between. Skips the read when nothing did.
   */
  async append(...events: NewEvent[]): Promise<void> {
    if (!events.length) return;
    const expected = this.next - this.base + events.length;
    const length = await this.log.appendWith({ touch: false }, ...events);
    if (length !== expected) {
      await this.refresh();
      return;
    }
    const time = Date.now();
    const start = this.next;
    this.events.push(...events.map((e, i) => ({ seq: start + i, time, ...e }) as SessionEvent));
    this.remember();
  }

  private remember() {
    cache.delete(this.chatKey);
    cache.set(this.chatKey, { base: this.base, events: this.events });
    if (cache.size > CACHE_CHATS) cache.delete(cache.keys().next().value!);
  }

  /** The model input for the visible window (see deriveInput). */
  input(): Promise<unknown[]> {
    return deriveInput(this.events, (key) => this.image(key));
  }

  private async image(key: string): Promise<string | null> {
    if (!this.imageCache.has(key)) this.imageCache.set(key, await this.store.get(key));
    return this.imageCache.get(key)!;
  }

  message(seq: number): SessionEvent<"user/message"> | undefined {
    const e = this.events.find((x) => x.seq === seq);
    return e && isEvent(e, "user/message") ? e : undefined;
  }

  /** Visible user messages after `seq`, with @ marks from later user/mentioned events applied. */
  messagesAfter(seq: number): SessionEvent<"user/message">[] {
    const { events } = visibleWindow(this.events);
    const mentioned = new Set(
      events.filter((e) => isEvent(e, "user/mentioned")).map((e) => (e as SessionEvent<"user/mentioned">).data.eventId),
    );
    return events
      .filter((e): e is SessionEvent<"user/message"> => isEvent(e, "user/message") && e.seq > seq)
      .map((e) => (mentioned.has(e.data.eventId) && !e.data.mentioned ? { ...e, data: { ...e.data, mentioned: true } } : e));
  }

  /** Delete events before `seq` (keeping later ones), from the log and from memory. */
  async trimBefore(seq: number): Promise<void> {
    const dropped = this.events.filter((e) => e.seq < seq);
    this.base = await this.log.trimBefore(seq, this.base, dropped);
    this.events = this.events.filter((e) => e.seq >= seq);
    this.remember();
  }

  async cursor(): Promise<number> {
    this.cursorValue ??= Number((await this.store.get(chatKeys(this.chatKey).cursor)) ?? -1);
    return this.cursorValue;
  }

  async setCursor(seq: number): Promise<void> {
    this.cursorValue = seq;
    await this.store.set(chatKeys(this.chatKey).cursor, String(seq), ttlSeconds() * 1000);
  }

  async nextTurn(): Promise<number> {
    return this.store.incrby(chatKeys(this.chatKey).turn, 1, ttlSeconds());
  }
}

/** A chat's run lock: a lease that expires unless renewed, so a killed run can't hold it forever. */
export class RunLock {
  readonly owner = crypto.randomUUID();
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private store: Store,
    private key: string,
  ) {}

  async acquire(): Promise<boolean> {
    const ok = await this.store.set(this.key, this.owner, LOCK_TTL_MS, { nx: true });
    if (ok) {
      this.timer = setInterval(() => void this.renew(), LOCK_RENEW_MS);
      this.timer.unref?.();
    }
    return ok;
  }

  private async renew() {
    try {
      if ((await this.store.get(this.key)) === this.owner) await this.store.set(this.key, this.owner, LOCK_TTL_MS);
      else console.warn(`[lock] lost ${this.key}`);
    } catch (err) {
      console.warn(`[lock] renew failed for ${this.key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async release(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    if ((await this.store.get(this.key)) === this.owner) await this.store.del(this.key);
  }
}
