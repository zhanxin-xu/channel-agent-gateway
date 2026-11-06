/**
 * Test doubles for Supabase's Data API (POST /rest/v1/rpc/<fn>), so
 * PostgresStore can run without Supabase:
 *   - postgresRpc: calls the real functions of supabase/schema.sql in a
 *     local Postgres (TEST_DATABASE_URL), the way PostgREST would;
 *   - memoryRpc: answers from a MemoryStore, for fully offline runs.
 */
import fs from "node:fs";
import pg from "pg";
import type { MemoryStore } from "../src/store/index.js";

export type Rpc = (fn: string, args: Record<string, any>) => Promise<unknown>;

/** jsonb parameters: node-postgres would turn a JS array into a Postgres array, so send them as JSON text. */
const JSONB_PARAMS = new Set(["p_event", "p_events", "p_context", "p_upgrade", "p_entries", "p_profile", "p_counts", "p_detail"]);

/** PostgREST's answer when a function doesn't exist. */
class NoFunction extends Error {}

/** A fresh `gateway` schema plus the functions, in the database at `url`. */
export async function postgresRpc(url: string): Promise<{ rpc: Rpc; client: pg.Client }> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query("set client_min_messages = warning");
  await client.query("drop schema if exists gateway cascade");
  await client.query(fs.readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8"));
  const rpc: Rpc = async (fn, args) => {
    if (!/^[a-z_]+$/.test(fn)) throw new Error(`bad function name ${fn}`);
    const names = Object.keys(args);
    const values = names.map((n) => (JSONB_PARAMS.has(n) && args[n] != null ? JSON.stringify(args[n]) : args[n]));
    const sql = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")}) as r`;
    return (await client.query(sql, values)).rows[0].r;
  };
  return { rpc, client };
}

export function memoryRpc(store: MemoryStore): Rpc {
  return async (fn, a) => {
    switch (fn) {
      case "chat_ingest":
        return store.ingest({
          chat: a.p_chat,
          channel: a.p_channel,
          conversationId: a.p_conversation_id,
          chatType: a.p_chat_type,
          origin: a.p_origin ?? undefined,
          eventId: a.p_event_id,
          direct: a.p_direct,
          event: a.p_event,
          reset: a.p_reset,
          upgrade: a.p_upgrade ?? undefined,
          wake: a.p_wake,
          ambientIntervalSeconds: a.p_ambient_interval_s,
          lockOwner: a.p_lock_owner,
          lockTtlMs: a.p_lock_ttl_ms,
        });
      case "chat_open":
        return store.open(a.p_chat, a.p_after_seq);
      case "chat_append":
        return store.append(a.p_chat, a.p_owner, a.p_events);
      case "chat_trim":
        return store.trim(a.p_chat, a.p_owner, a.p_seq);
      case "chat_lock":
        return store.lock(a.p_chat, a.p_owner, a.p_ttl_ms, a.p_mode);
      case "chat_claim_ambient":
        return store.claimAmbient(a.p_chat, a.p_interval_s);
      case "chat_begin_turn":
        return store.beginTurn(a.p_chat, a.p_owner);
      case "chat_set_cursor":
        return store.setCursor(a.p_chat, a.p_owner, a.p_cursor);
      case "reply_get":
        return store.getReply(a.p_chat, a.p_event_id);
      case "reply_put":
        return store.putReply(a.p_chat, a.p_event_id, a.p_context);
      case "image_put":
        return store.putImage(a.p_chat, a.p_key, a.p_data_url);
      case "image_get":
        return store.getImages(a.p_keys);
      case "gateway_info":
        return { schemaVersion: await store.schemaVersion() };
      case "settings_list":
        return store.listSettings();
      case "settings_put":
        return store.putSettings(a.p_entries);
      case "profile_get":
        return store.getProfile(a.p_chat);
      case "profile_put":
        return store.putProfile(a.p_chat, a.p_profile);
      case "usage_add":
        return store.addUsage(a.p_chat, a.p_day, a.p_counts);
      case "usage_list":
        return store.usage(a.p_chat, a.p_from, a.p_to);
      case "usage_day":
        return store.usageOfDay(a.p_day);
      case "history_add":
        return store.addHistory(a.p_chat, a.p_entries);
      case "history_list":
        return store.history(a.p_chat, a.p_before, a.p_limit);
      case "meta_get":
        return store.meta(a.p_key);
      case "meta_put":
        return store.setMeta(a.p_key, a.p_value);
      case "admin_chats":
        return store.chats(a.p_day);
      case "admin_events":
        return store.recentEvents(a.p_chat, a.p_before, a.p_limit);
      case "admin_append":
        return store.appendUnlocked(a.p_chat, a.p_events);
      case "admin_unlock":
        return store.unlock(a.p_chat);
      case "admin_problems":
        return store.problems(a.p_since, a.p_limit);
      case "admin_log_add":
        return store.log(a.p_action, a.p_chat, a.p_detail);
      case "admin_log_list":
        return store.adminLog(a.p_limit);
      case "admin_login_failures":
        return store.loginFailures(a.p_ip, a.p_record, a.p_window_s);
      default:
        throw new NoFunction(`Could not find the function public.${fn}`);
    }
  };
}

/** A fetch handler for `{origin}/rest/v1/rpc/<fn>` that checks the key and answers like PostgREST. */
export function rpcResponse(rpc: Rpc, key: string) {
  return async (url: string, headers: Headers, body: any): Promise<Response> => {
    if (headers.get("apikey") !== key) return Response.json({ message: "Invalid API key" }, { status: 401 });
    const fn = new URL(url).pathname.replace("/rest/v1/rpc/", "");
    try {
      return new Response(JSON.stringify((await rpc(fn, body ?? {})) ?? null), { headers: { "content-type": "application/json" } });
    } catch (err) {
      if (err instanceof NoFunction || /function public\.\w+\(.*\) does not exist/.test(String(err))) {
        return Response.json({ code: "PGRST202", message: String(err instanceof Error ? err.message : err) }, { status: 404 });
      }
      return Response.json({ message: err instanceof Error ? err.message : String(err) }, { status: 400 });
    }
  };
}
