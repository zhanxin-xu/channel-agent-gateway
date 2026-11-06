/**
 * The sampler: when pending messages wake the agent. A DM or an @ always does;
 * ordinary group messages at most once per interval per chat (the chat's own,
 * else AGENT_AMBIENT_INTERVAL_SECONDS; see chats/profile.ts), so a busy group
 * costs one model call per window, not one per message.
 *
 * The window is the session row's `ambient_until`. Ingress applies the same
 * rule inside its transaction (chat_ingest in supabase/schema.sql, and
 * MemoryStore.ingest); keep them in step with this file.
 */
import type { ChatStore } from "../store/index.js";

export type Trigger = "direct" | "ambient";

/**
 * Whether these pending messages start a turn now: "direct" when one is a DM
 * or an @, "ambient" when the window is ours (`windowTaken`, or claimed here),
 * null when they wait.
 */
export async function wakeFor(
  store: ChatStore,
  chat: string,
  pending: Array<{ data: { mentioned: boolean } }>,
  windowTaken: boolean,
  /** This chat's ambient interval; 0 = ordinary messages never wake it. */
  intervalSeconds: number,
): Promise<Trigger | null> {
  if (!pending.length) return null;
  if (pending.some((m) => m.data.mentioned)) return "direct";
  if (windowTaken || (await store.claimAmbient(chat, intervalSeconds))) return "ambient";
  return null;
}
