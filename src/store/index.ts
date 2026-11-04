/**
 * Where chats live: sessions (one per chat), their append-only event logs,
 * reply state, images and webhook de-duplication. Modelled on dsh's session
 * log (see supabase/schema.sql): a session row holding the log's header and
 * the run state, and events numbered by a contiguous per-chat `seq`.
 *
 * Two implementations of one contract (scripts/storetest.ts runs the same
 * cases against both):
 *   - PostgresStore: Supabase. Each operation is one call to a function from
 *     supabase/schema.sql over the Data API (POST /rest/v1/rpc/<name>), so the
 *     multi-step ones (ingest, append) are single transactions.
 *   - MemoryStore: one process only; for local development and tests.
 */
import { config } from "../config.js";

export interface StoredEvent {
  seq: number;
  type: string;
  /** Unix epoch milliseconds. */
  time: number;
  data: unknown;
}

export interface NewStoredEvent {
  type: string;
  data: unknown;
}

/** The session row: the log's header and the run state. */
export interface SessionState {
  chat: string;
  channel: string;
  conversationId: string;
  chatType: "private" | "group";
  origin?: string | null;
  formatVersion: number;
  /** When the session row was created (epoch ms); a chat that expired and came back is a new session. */
  createdAt: number;
  /** Seq the next event will get. */
  nextSeq: number;
  /** Seq of the oldest event still kept (= nextSeq when there are none). */
  minSeq: number;
  /** Seq of the last user message a turn has handled. */
  cursor: number;
  turn: number;
}

export interface IngestInput {
  chat: string;
  channel: string;
  conversationId: string;
  chatType: "private" | "group";
  origin?: string;
  /** The platform's id of this delivery, for de-duplication. */
  eventId: string;
  /** A DM or an @: wakes the agent every time. */
  direct: boolean;
  event: NewStoredEvent;
  /** False for events that never wake the agent (session/reset). */
  wake: boolean;
  /** Ordinary messages wake the agent at most once per this many seconds (0: never). */
  ambientIntervalSeconds: number;
  /** Who takes the run lock if the agent is woken. */
  lockOwner: string;
  lockTtlMs: number;
}

export type IngestStatus = "duplicate" | "recorded" | "busy" | "acquired";
export type LockMode = "acquire" | "renew" | "release";

export interface ChatStore {
  /**
   * One webhook delivery, atomically: de-duplicate, create/update the session,
   * append the event (a user/mentioned mark when a seen message comes back as
   * an @), and if it should wake the agent, try the run lock. session/reset
   * deletes everything logged before it.
   */
  ingest(input: IngestInput): Promise<{ status: IngestStatus; seq?: number }>;
  /** The session and its events after `afterSeq`, oldest first. */
  open(chat: string, afterSeq: number): Promise<{ session: SessionState | null; events: StoredEvent[] }>;
  /** Append in order; returns the first seq given. */
  append(chat: string, events: NewStoredEvent[]): Promise<number>;
  /** Delete events before `seq`, and the images they reference. */
  trim(chat: string, seq: number): Promise<void>;
  lock(chat: string, owner: string, ttlMs: number, mode: LockMode): Promise<boolean>;
  claimAmbient(chat: string, intervalSeconds: number): Promise<boolean>;
  /** Increments the turn counter; returns the new turn number. */
  beginTurn(chat: string): Promise<number>;
  setCursor(chat: string, seq: number): Promise<void>;
  getReply(chat: string, eventId: string): Promise<Record<string, string> | null>;
  putReply(chat: string, eventId: string, context: Record<string, string>): Promise<void>;
  putImage(chat: string, key: string, dataUrl: string): Promise<void>;
  /** The data URLs of the keys that exist. */
  getImages(keys: string[]): Promise<Record<string, string>>;
}

/**
 * Supabase: new secret keys (sb_secret_…) go in the `apikey` header; a legacy
 * service-role JWT also as the bearer token. Every function returns JSON.
 */
export class PostgresStore implements ChatStore {
  constructor(
    private url: string,
    private key: string,
  ) {}

  private async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const headers: Record<string, string> = { apikey: this.key, "content-type": "application/json" };
    if (this.key.startsWith("eyJ")) headers.authorization = `Bearer ${this.key}`;
    const res = await fetch(`${this.url.replace(/\/+$/, "")}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers,
      body: JSON.stringify(args),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Supabase ${fn} HTTP ${res.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  ingest(i: IngestInput) {
    return this.rpc<{ status: IngestStatus; seq?: number }>("chat_ingest", {
      p_chat: i.chat,
      p_channel: i.channel,
      p_conversation_id: i.conversationId,
      p_chat_type: i.chatType,
      p_origin: i.origin ?? null,
      p_event_id: i.eventId,
      p_direct: i.direct,
      p_event: i.event,
      p_wake: i.wake,
      p_ambient_interval_s: i.ambientIntervalSeconds,
      p_lock_owner: i.lockOwner,
      p_lock_ttl_ms: i.lockTtlMs,
    });
  }

  open(chat: string, afterSeq: number) {
    return this.rpc<{ session: SessionState | null; events: StoredEvent[] }>("chat_open", { p_chat: chat, p_after_seq: afterSeq });
  }

  async append(chat: string, events: NewStoredEvent[]) {
    return Number(await this.rpc("chat_append", { p_chat: chat, p_events: events }));
  }

  async trim(chat: string, seq: number) {
    await this.rpc("chat_trim", { p_chat: chat, p_seq: seq });
  }

  async lock(chat: string, owner: string, ttlMs: number, mode: LockMode) {
    return Boolean(await this.rpc("chat_lock", { p_chat: chat, p_owner: owner, p_ttl_ms: Math.round(ttlMs), p_mode: mode }));
  }

  async claimAmbient(chat: string, intervalSeconds: number) {
    return Boolean(await this.rpc("chat_claim_ambient", { p_chat: chat, p_interval_s: intervalSeconds }));
  }

  async beginTurn(chat: string) {
    return Number(await this.rpc("chat_begin_turn", { p_chat: chat }));
  }

  async setCursor(chat: string, seq: number) {
    await this.rpc("chat_set_cursor", { p_chat: chat, p_cursor: seq });
  }

  getReply(chat: string, eventId: string) {
    return this.rpc<Record<string, string> | null>("reply_get", { p_chat: chat, p_event_id: eventId });
  }

  async putReply(chat: string, eventId: string, context: Record<string, string>) {
    await this.rpc("reply_put", { p_chat: chat, p_event_id: eventId, p_context: context });
  }

  async putImage(chat: string, key: string, dataUrl: string) {
    await this.rpc("image_put", { p_chat: chat, p_key: key, p_data_url: dataUrl });
  }

  async getImages(keys: string[]) {
    if (!keys.length) return {};
    return (await this.rpc<Record<string, string> | null>("image_get", { p_keys: keys })) ?? {};
  }
}

interface MemorySession extends Omit<SessionState, "minSeq"> {
  lockOwner?: string;
  lockExpiresAt?: number;
  ambientUntil?: number;
  events: StoredEvent[];
}

/** The same contract in one process's memory. Mirrors the SQL functions. */
export class MemoryStore implements ChatStore {
  private sessions = new Map<string, MemorySession>();
  private inbound = new Map<string, { direct: boolean }>();
  private replies = new Map<string, Record<string, string>>();
  private images = new Map<string, string>();

  private appendTo(s: MemorySession, events: NewStoredEvent[]): number {
    const first = s.nextSeq;
    const time = Date.now();
    events.forEach((e, i) => s.events.push({ seq: first + i, type: e.type, time, data: structuredClone(e.data ?? {}) }));
    s.nextSeq += events.length;
    return first;
  }

  private dropImages(events: StoredEvent[]) {
    for (const e of events) for (const key of (e.data as { images?: string[] }).images ?? []) this.images.delete(key);
  }

  async ingest(i: IngestInput) {
    const seenKey = `${i.channel}\n${i.eventId}`;
    const seen = this.inbound.get(seenKey);
    let event = i.event;
    if (seen) {
      if (!i.direct || seen.direct) return { status: "duplicate" as const };
      seen.direct = true;
      event = { type: "user/mentioned", data: { eventId: i.eventId } };
    } else {
      this.inbound.set(seenKey, { direct: i.direct });
    }

    let s = this.sessions.get(i.chat);
    if (!s) {
      s = {
        chat: i.chat,
        channel: i.channel,
        conversationId: i.conversationId,
        chatType: i.chatType,
        origin: i.origin ?? null,
        formatVersion: 1,
        createdAt: Date.now(),
        nextSeq: 0,
        cursor: -1,
        turn: 0,
        events: [],
      };
      this.sessions.set(i.chat, s);
    } else {
      s.chatType = i.chatType;
      s.origin = i.origin ?? s.origin;
    }
    if (event.type === "session/reset") {
      this.dropImages(s.events);
      s.events = [];
      for (const key of [...this.replies.keys()]) if (key.startsWith(`${i.chat}\n`)) this.replies.delete(key);
    }
    const seq = this.appendTo(s, [event]);

    const now = Date.now();
    const wake = i.wake && (i.direct || (i.ambientIntervalSeconds > 0 && (s.ambientUntil ?? 0) <= now));
    if (wake && !i.direct) s.ambientUntil = now + i.ambientIntervalSeconds * 1000;
    let acquired = false;
    if (wake && (s.lockExpiresAt ?? 0) <= now) {
      s.lockOwner = i.lockOwner;
      s.lockExpiresAt = now + i.lockTtlMs;
      acquired = true;
    }
    return { status: !wake ? ("recorded" as const) : acquired ? ("acquired" as const) : ("busy" as const), seq };
  }

  async open(chat: string, afterSeq: number) {
    const s = this.sessions.get(chat);
    if (!s) return { session: null, events: [] };
    const { lockOwner: _o, lockExpiresAt: _e, ambientUntil: _a, events, ...state } = s;
    return {
      session: { ...state, minSeq: events[0]?.seq ?? s.nextSeq },
      events: events.filter((e) => e.seq > afterSeq).map((e) => structuredClone(e)),
    };
  }

  async append(chat: string, events: NewStoredEvent[]) {
    const s = this.sessions.get(chat);
    if (!s) throw new Error(`no session ${chat}`);
    return this.appendTo(s, events);
  }

  async trim(chat: string, seq: number) {
    const s = this.sessions.get(chat);
    if (!s) return;
    this.dropImages(s.events.filter((e) => e.seq < seq));
    s.events = s.events.filter((e) => e.seq >= seq);
  }

  async lock(chat: string, owner: string, ttlMs: number, mode: LockMode) {
    const s = this.sessions.get(chat);
    if (!s) return false;
    const now = Date.now();
    if (mode === "acquire") {
      if ((s.lockExpiresAt ?? 0) > now) return false;
      s.lockOwner = owner;
      s.lockExpiresAt = now + ttlMs;
      return true;
    }
    if (s.lockOwner !== owner) return false;
    if (mode === "renew") s.lockExpiresAt = now + ttlMs;
    else s.lockOwner = s.lockExpiresAt = undefined;
    return true;
  }

  async claimAmbient(chat: string, intervalSeconds: number) {
    const s = this.sessions.get(chat);
    if (!s || intervalSeconds <= 0 || (s.ambientUntil ?? 0) > Date.now()) return false;
    s.ambientUntil = Date.now() + intervalSeconds * 1000;
    return true;
  }

  async beginTurn(chat: string) {
    const s = this.sessions.get(chat);
    if (!s) throw new Error(`no session ${chat}`);
    return ++s.turn;
  }

  async setCursor(chat: string, seq: number) {
    const s = this.sessions.get(chat);
    if (s) s.cursor = seq;
  }

  async getReply(chat: string, eventId: string) {
    const context = this.replies.get(`${chat}\n${eventId}`);
    return context ? structuredClone(context) : null;
  }

  async putReply(chat: string, eventId: string, context: Record<string, string>) {
    this.replies.set(`${chat}\n${eventId}`, structuredClone(context));
  }

  async putImage(_chat: string, key: string, dataUrl: string) {
    this.images.set(key, dataUrl);
  }

  async getImages(keys: string[]) {
    return Object.fromEntries(keys.filter((k) => this.images.has(k)).map((k) => [k, this.images.get(k)!]));
  }
}

let instance: ChatStore | undefined;

export function storeBackend(): "supabase" | "memory" {
  return config.store.supabaseUrl && config.store.supabaseKey ? "supabase" : "memory";
}

export function getStore(): ChatStore {
  instance ??=
    storeBackend() === "supabase" ? new PostgresStore(config.store.supabaseUrl, config.store.supabaseKey) : new MemoryStore();
  return instance;
}

/** Tests swap stores between cases. */
export function resetStore(store?: ChatStore) {
  instance = store;
}
