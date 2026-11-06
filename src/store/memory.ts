import {
  LockLostError,
  SCHEMA_VERSION,
  type AdminLogEntry,
  type ChatSummary,
  type IngestInput,
  type LockMode,
  type NewStoredEvent,
  type SessionState,
  type Store,
  type StoredEvent,
  type StoredSetting,
  type TurnProblem,
  type UsageCounts,
} from "./types.js";

interface MemorySession extends Omit<SessionState, "minSeq"> {
  lockOwner?: string;
  lockExpiresAt?: number;
  ambientUntil?: number;
  lastActiveAt: number;
  events: StoredEvent[];
}

/** Mirrors admin_chats' `speakers`: who wrote among the last 50 messages, most recent first, at most 5. */
function recentSpeakers(events: StoredEvent[]): string[] {
  const speakers: string[] = [];
  const recent = events.filter((e) => e.type === "user/message" && !(e.data as { replyVia?: string }).replyVia).slice(-50).reverse();
  for (const e of recent) {
    const sender = (e.data as { sender?: string }).sender;
    if (sender && !speakers.includes(sender)) speakers.push(sender);
  }
  return speakers.slice(0, 5);
}

/** The same contract in one process's memory. Mirrors the SQL functions. */
export class MemoryStore implements Store {
  private sessions = new Map<string, MemorySession>();
  private inbound = new Map<string, { direct: boolean }>();
  private replies = new Map<string, Record<string, string>>();
  private images = new Map<string, string>();
  private settings = new Map<string, StoredSetting>();
  private profiles = new Map<string, Record<string, unknown>>();
  /** chat → day → counts */
  private usageDays = new Map<string, Map<string, UsageCounts>>();
  private logEntries: AdminLogEntry[] = [];
  private loginFailureTimes = new Map<string, number[]>();

  private appendTo(s: MemorySession, events: NewStoredEvent[]): number {
    const first = s.nextSeq;
    const time = Date.now();
    events.forEach((e, i) => s.events.push({ seq: first + i, type: e.type, time, data: structuredClone(e.data ?? {}) }));
    s.nextSeq += events.length;
    s.lastActiveAt = time;
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
        lastActiveAt: Date.now(),
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
    return { session: this.state(s), events: s.events.filter((e) => e.seq > afterSeq).map((e) => structuredClone(e)) };
  }

  private state(s: MemorySession): SessionState {
    const { lockOwner: _o, lockExpiresAt: _e, ambientUntil: _a, lastActiveAt: _l, events, ...state } = s;
    return { ...state, minSeq: events[0]?.seq ?? s.nextSeq };
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

  // ── Admin console ──

  async listSettings() {
    return [...this.settings.values()].sort((a, b) => a.key.localeCompare(b.key)).map((x) => ({ ...x }));
  }

  async putSettings(entries: Array<{ key: string; value: string | null; secret: boolean }>) {
    for (const e of entries) {
      if (e.value === null) this.settings.delete(e.key);
      else this.settings.set(e.key, { key: e.key, value: e.value, secret: e.secret, updatedAt: Date.now() });
    }
  }

  async getProfile(chat: string) {
    const profile = this.profiles.get(chat);
    return profile ? structuredClone(profile) : null;
  }

  async putProfile(chat: string, profile: Record<string, unknown> | null) {
    if (profile === null) this.profiles.delete(chat);
    else this.profiles.set(chat, structuredClone(profile));
  }

  async addUsage(chat: string, day: string, counts: UsageCounts) {
    const days = this.usageDays.get(chat) ?? new Map<string, UsageCounts>();
    this.usageDays.set(chat, days);
    const total = days.get(day) ?? {};
    for (const [k, v] of Object.entries(counts)) total[k] = (total[k] ?? 0) + v;
    days.set(day, total);
  }

  async usage(chat: string, fromDay: string, toDay: string) {
    return [...(this.usageDays.get(chat) ?? new Map<string, UsageCounts>())]
      .filter(([day]) => day >= fromDay && day <= toDay)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, counts]) => ({ day, counts: { ...counts } }));
  }

  async usageOfDay(day: string) {
    const result: Record<string, UsageCounts> = {};
    for (const [chat, days] of this.usageDays) {
      const counts = days.get(day);
      if (counts) result[chat] = { ...counts };
    }
    return result;
  }

  async schemaVersion() {
    return SCHEMA_VERSION;
  }

  async chats(day: string) {
    const keys = new Set([...this.sessions.keys(), ...this.profiles.keys()]);
    const now = Date.now();
    const summaries: ChatSummary[] = [...keys].map((chat) => {
      const s = this.sessions.get(chat);
      return {
        chat,
        channel: s?.channel ?? null,
        conversationId: s?.conversationId ?? null,
        chatType: s?.chatType ?? null,
        turn: s?.turn ?? null,
        locked: (s?.lockExpiresAt ?? 0) > now,
        lastActiveAt: s?.lastActiveAt ?? null,
        profile: this.profiles.get(chat) ?? null,
        usage: this.usageDays.get(chat)?.get(day) ?? null,
        speakers: recentSpeakers(s?.events ?? []),
      };
    });
    return summaries.sort((a, b) => (b.lastActiveAt ?? -1) - (a.lastActiveAt ?? -1));
  }

  async recentEvents(chat: string, beforeSeq: number, limit: number) {
    const s = this.sessions.get(chat);
    if (!s) return { session: null, events: [] };
    const events = s.events.filter((e) => e.seq < beforeSeq).slice(-limit).reverse();
    return { session: this.state(s), events: events.map((e) => structuredClone(e)) };
  }

  async appendUnlocked(chat: string, events: NewStoredEvent[]) {
    const s = this.sessions.get(chat);
    if (!s) throw new Error(`no session ${chat}`);
    return this.appendTo(s, events);
  }

  async unlock(chat: string) {
    const s = this.sessions.get(chat);
    if (!s?.lockOwner) return false;
    s.lockOwner = s.lockExpiresAt = undefined;
    return true;
  }

  async problems(sinceMs: number, limit: number) {
    const found: TurnProblem[] = [];
    for (const [chat, s] of this.sessions) {
      for (const e of s.events) {
        const data = e.data as { turn?: number; reason?: string; error?: string };
        if (e.type !== "turn/end" || e.time <= sinceMs || !["error", "unreachable", "max-steps"].includes(data.reason ?? "")) continue;
        found.push({ chat, seq: e.seq, turn: data.turn ?? 0, time: e.time, reason: data.reason!, error: data.error ?? null });
      }
    }
    return found.sort((a, b) => b.time - a.time).slice(0, limit);
  }

  async log(action: string, chat: string | null, detail: Record<string, unknown>) {
    this.logEntries.push({ time: Date.now(), action, chat, detail: structuredClone(detail) });
  }

  async adminLog(limit: number) {
    return this.logEntries.slice(-limit).reverse();
  }

  async loginFailures(ip: string, record: boolean, windowSeconds: number) {
    const since = Date.now() - windowSeconds * 1000;
    const times = (this.loginFailureTimes.get(ip) ?? []).filter((t) => t > since);
    if (record) times.push(Date.now());
    this.loginFailureTimes.set(ip, times);
    return times.length;
  }
}
