/**
 * A chat's session as seen by the one agent run that holds the chat's lock:
 * the session row (cursor, turn, where to reply) and an in-memory copy of its
 * event log, kept current by reading only the events appended since the last
 * read. Webhooks may append at any time; only the lock holder reads,
 * recovers, compacts and trims.
 */
import crypto from "node:crypto";
import type { ChatStore, SessionState } from "../store/index.js";
import { deriveInput, isEvent, visibleWindow, type NewEvent, type SessionEvent } from "./events.js";

export const LOCK_TTL_MS = 60_000;
const LOCK_RENEW_MS = 20_000;

/** Warm instances keep each chat's events, so a new run only reads what was appended since. */
const cache = new Map<string, { createdAt: number; events: SessionEvent[] }>();
const CACHE_CHATS = 50;

/** Image keys referenced by events. */
export function imageKeys(events: SessionEvent[]): string[] {
  return events.flatMap((e) =>
    isEvent(e, "user/message") ? (e.data.images ?? []) : isEvent(e, "tool/images") ? e.data.images : [],
  );
}

export class Session {
  events: SessionEvent[] = [];
  private images = new Map<string, string | null>();

  private constructor(
    readonly store: ChatStore,
    public state: SessionState,
  ) {}

  /** Null when the chat has no session (never seen, or expired). */
  static async open(store: ChatStore, chat: string): Promise<Session | null> {
    const hit = cache.get(chat);
    let { session: state, events } = await store.open(chat, hit?.events.at(-1)?.seq ?? -1);
    if (state && hit && hit.createdAt !== state.createdAt) ({ session: state, events } = await store.open(chat, -1));
    if (!state) return null;
    const session = new Session(store, state);
    if (hit && hit.createdAt === state.createdAt) session.events = [...hit.events];
    session.merge(events as SessionEvent[]);
    return session;
  }

  get chatKey() {
    return this.state.chat;
  }

  /** Add events read from the store, and forget those trimmed or reset away by now. */
  private merge(fresh: SessionEvent[]) {
    const last = this.events.at(-1)?.seq ?? -1;
    this.events.push(...fresh.filter((e) => e.seq > last));
    if (this.events[0] && this.events[0].seq < this.state.minSeq) {
      this.events = this.events.filter((e) => e.seq >= this.state.minSeq);
    }
    cache.delete(this.chatKey);
    cache.set(this.chatKey, { createdAt: this.state.createdAt, events: this.events });
    if (cache.size > CACHE_CHATS) cache.delete(cache.keys().next().value!);
  }

  /** Read everything appended since the last read. Returns the new events. */
  async refresh(): Promise<SessionEvent[]> {
    const last = this.events.at(-1)?.seq ?? -1;
    const { session: state, events } = await this.store.open(this.chatKey, last);
    if (state) this.state = state;
    const fresh = events as SessionEvent[];
    this.merge(fresh);
    return fresh;
  }

  /**
   * Append. The store numbers the events; when a webhook appended in between,
   * read back so the in-memory copy has the log's real order.
   */
  async append(...events: NewEvent[]): Promise<void> {
    if (!events.length) return;
    const first = await this.store.append(this.chatKey, events);
    if (first !== this.state.nextSeq) {
      await this.refresh();
      return;
    }
    const time = Date.now();
    this.state.nextSeq += events.length;
    this.merge(events.map((e, i) => ({ seq: first + i, time, ...e }) as SessionEvent));
  }

  /** The model input for the visible window (see deriveInput), images loaded in one call. */
  async input(events = this.events): Promise<unknown[]> {
    const missing = imageKeys(visibleWindow(events).events).filter((k) => !this.images.has(k));
    if (missing.length) {
      const found = await this.store.getImages([...new Set(missing)]);
      for (const key of missing) this.images.set(key, found[key] ?? null);
    }
    return deriveInput(events, async (key) => this.images.get(key) ?? null);
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

  /** Delete events before `seq` (and their images), from the store and from memory. */
  async trimBefore(seq: number): Promise<void> {
    await this.store.trim(this.chatKey, seq);
    this.state.minSeq = Math.max(this.state.minSeq, seq);
    this.merge([]);
  }

  /** Seq of the last user message a turn has handled. Only the lock holder moves it. */
  get cursor(): number {
    return this.state.cursor;
  }

  async setCursor(seq: number): Promise<void> {
    this.state.cursor = seq;
    await this.store.setCursor(this.chatKey, seq);
  }

  async nextTurn(): Promise<number> {
    this.state.turn = await this.store.beginTurn(this.chatKey);
    return this.state.turn;
  }
}

/** A chat's run lock: a lease that expires unless renewed, so a killed run can't hold it forever. */
export class RunLock {
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private store: ChatStore,
    private chat: string,
    readonly owner: string = crypto.randomUUID(),
  ) {}

  async acquire(): Promise<boolean> {
    const ok = await this.store.lock(this.chat, this.owner, LOCK_TTL_MS, "acquire");
    if (ok) this.hold();
    return ok;
  }

  /** Start renewing a lock this owner already holds (the webhook took it during ingest). */
  hold() {
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.renew(), LOCK_RENEW_MS);
    this.timer.unref?.();
  }

  private async renew() {
    try {
      if (!(await this.store.lock(this.chat, this.owner, LOCK_TTL_MS, "renew"))) console.warn(`[lock] lost ${this.chat}`);
    } catch (err) {
      console.warn(`[lock] renew failed for ${this.chat}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async release(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.store.lock(this.chat, this.owner, LOCK_TTL_MS, "release");
  }
}
