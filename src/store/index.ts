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
import { MemoryStore } from "./memory.js";
import { PostgresStore } from "./postgres.js";
import type { ChatStore } from "./types.js";

export * from "./types.js";
export { MemoryStore, PostgresStore };

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
