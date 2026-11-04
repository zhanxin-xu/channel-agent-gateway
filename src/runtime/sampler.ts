/**
 * The sampler: when pending messages wake the agent. A DM or an @ always does;
 * ordinary group messages at most once per AGENT_AMBIENT_INTERVAL_SECONDS per
 * chat, so a busy group costs one model call per window, not one per message.
 *
 * The window is the session row's `ambient_until`. Ingress applies the same
 * rule inside its transaction (chat_ingest in supabase/schema.sql, and
 * MemoryStore.ingest); keep them in step with this file.
 */
import { config } from "../config.js";
import type { ChatStore } from "../store/index.js";

export const ambientIntervalSeconds = () => config.agent.ambientIntervalSeconds;

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
): Promise<Trigger | null> {
  if (!pending.length) return null;
  if (pending.some((m) => m.data.mentioned)) return "direct";
  if (windowTaken || (await store.claimAmbient(chat, ambientIntervalSeconds()))) return "ambient";
  return null;
}
