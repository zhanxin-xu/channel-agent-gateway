import { LockLostError, type ChatStore, type IngestInput, type LockMode, type NewStoredEvent, type SessionState, type StoredEvent } from "./types.js";

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
      if (!i.direct || seen.direct || !i.upgrade) return { status: "duplicate" as const };
      seen.direct = true;
      event = i.upgrade;
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
    if (i.reset && !seen) {
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

  /** The session, if `owner` holds its lock. */
  private owned(chat: string, owner: string): MemorySession {
    const s = this.sessions.get(chat);
    if (!s || s.lockOwner !== owner) throw new LockLostError(chat);
    return s;
  }

  async append(chat: string, owner: string, events: NewStoredEvent[]) {
    return this.appendTo(this.owned(chat, owner), events);
  }

  async trim(chat: string, owner: string, seq: number) {
    const s = this.owned(chat, owner);
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

  async beginTurn(chat: string, owner: string) {
    return ++this.owned(chat, owner).turn;
  }

  async setCursor(chat: string, owner: string, seq: number) {
    this.owned(chat, owner).cursor = seq;
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
