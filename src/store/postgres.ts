import {
  LockLostError,
  SchemaOutdatedError,
  type AdminLogEntry,
  type ChatSummary,
  type HistoryEntry,
  type IngestInput,
  type IngestStatus,
  type LockMode,
  type NewStoredEvent,
  type SessionState,
  type Store,
  type StoredEvent,
  type StoredSetting,
  type TurnProblem,
  type UsageCounts,
} from "./types.js";

/** Supabase, with a secret key (sb_secret_…) in the `apikey` header. Every function returns JSON. */
export class PostgresStore implements Store {
  constructor(
    private url: string,
    private key: string,
  ) {}

  private async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.url.replace(/\/+$/, "")}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey: this.key, "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    const text = await res.text();
    if (!res.ok && text.includes("lock lost")) throw new LockLostError(String(args.p_chat));
    // PostgREST: no such function (PGRST202), or Postgres: undefined function / table (42883 / 42P01).
    if (!res.ok && /PGRST202|"42883"|"42P01"/.test(text)) throw new SchemaOutdatedError(fn);
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
      p_reset: i.reset,
      p_upgrade: i.upgrade ?? null,
      p_wake: i.wake,
      p_ambient_interval_s: i.ambientIntervalSeconds,
      p_lock_owner: i.lockOwner,
      p_lock_ttl_ms: i.lockTtlMs,
    });
  }

  open(chat: string, afterSeq: number) {
    return this.rpc<{ session: SessionState | null; events: StoredEvent[] }>("chat_open", { p_chat: chat, p_after_seq: afterSeq });
  }

  async append(chat: string, owner: string, events: NewStoredEvent[]) {
    return Number(await this.rpc("chat_append", { p_chat: chat, p_owner: owner, p_events: events }));
  }

  async trim(chat: string, owner: string, seq: number) {
    await this.rpc("chat_trim", { p_chat: chat, p_owner: owner, p_seq: seq });
  }

  async lock(chat: string, owner: string, ttlMs: number, mode: LockMode) {
    return Boolean(await this.rpc("chat_lock", { p_chat: chat, p_owner: owner, p_ttl_ms: Math.round(ttlMs), p_mode: mode }));
  }

  async claimAmbient(chat: string, intervalSeconds: number) {
    return Boolean(await this.rpc("chat_claim_ambient", { p_chat: chat, p_interval_s: intervalSeconds }));
  }

  async beginTurn(chat: string, owner: string) {
    return Number(await this.rpc("chat_begin_turn", { p_chat: chat, p_owner: owner }));
  }

  async setCursor(chat: string, owner: string, seq: number) {
    await this.rpc("chat_set_cursor", { p_chat: chat, p_owner: owner, p_cursor: seq });
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

  // ── Admin console ──

  async listSettings() {
    return this.rpc<StoredSetting[]>("settings_list", {});
  }

  async putSettings(entries: Array<{ key: string; value: string | null; secret: boolean }>) {
    await this.rpc("settings_put", { p_entries: entries });
  }

  getProfile(chat: string) {
    return this.rpc<Record<string, unknown> | null>("profile_get", { p_chat: chat });
  }

  async putProfile(chat: string, profile: Record<string, unknown> | null) {
    await this.rpc("profile_put", { p_chat: chat, p_profile: profile });
  }

  async addUsage(chat: string, day: string, counts: UsageCounts) {
    await this.rpc("usage_add", { p_chat: chat, p_day: day, p_counts: counts });
  }

  usage(chat: string, fromDay: string, toDay: string) {
    return this.rpc<Array<{ day: string; counts: UsageCounts }>>("usage_list", { p_chat: chat, p_from: fromDay, p_to: toDay });
  }

  usageOfDay(day: string) {
    return this.rpc<Record<string, UsageCounts>>("usage_day", { p_day: day });
  }

  async addHistory(chat: string, entries: Array<Omit<HistoryEntry, "time"> & { time?: number }>) {
    if (entries.length) await this.rpc("history_add", { p_chat: chat, p_entries: entries });
  }

  history(chat: string, beforeMs: number, limit: number) {
    return this.rpc<HistoryEntry[]>("history_list", { p_chat: chat, p_before: Math.round(beforeMs), p_limit: limit });
  }

  async schemaVersion() {
    try {
      return (await this.rpc<{ schemaVersion: number | null }>("gateway_info", {})).schemaVersion;
    } catch (err) {
      if (err instanceof SchemaOutdatedError) return null;
      throw err;
    }
  }

  meta(key: string) {
    return this.rpc<string | null>("meta_get", { p_key: key });
  }

  async setMeta(key: string, value: string) {
    await this.rpc("meta_put", { p_key: key, p_value: value });
  }

  chats(day: string) {
    return this.rpc<ChatSummary[]>("admin_chats", { p_day: day });
  }

  recentEvents(chat: string, beforeSeq: number, limit: number) {
    return this.rpc<{ session: SessionState | null; events: StoredEvent[] }>("admin_events", {
      p_chat: chat,
      p_before: Math.min(beforeSeq, Number.MAX_SAFE_INTEGER),
      p_limit: limit,
    });
  }

  async appendUnlocked(chat: string, events: NewStoredEvent[]) {
    return Number(await this.rpc("admin_append", { p_chat: chat, p_events: events }));
  }

  async unlock(chat: string) {
    return Boolean(await this.rpc("admin_unlock", { p_chat: chat }));
  }

  problems(sinceMs: number, limit: number) {
    return this.rpc<TurnProblem[]>("admin_problems", { p_since: Math.round(sinceMs), p_limit: limit });
  }

  async log(action: string, chat: string | null, detail: Record<string, unknown>) {
    await this.rpc("admin_log_add", { p_action: action, p_chat: chat, p_detail: detail });
  }

  adminLog(limit: number) {
    return this.rpc<AdminLogEntry[]>("admin_log_list", { p_limit: limit });
  }

  async loginFailures(ip: string, record: boolean, windowSeconds: number) {
    return Number(await this.rpc("admin_login_failures", { p_ip: ip, p_record: record, p_window_s: windowSeconds }));
  }
}
