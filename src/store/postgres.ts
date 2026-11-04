import { LockLostError, type ChatStore, type IngestInput, type IngestStatus, type LockMode, type NewStoredEvent, type SessionState, type StoredEvent } from "./types.js";

/** Supabase, with a secret key (sb_secret_…) in the `apikey` header. Every function returns JSON. */
export class PostgresStore implements ChatStore {
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
}
