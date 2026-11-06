/**
 * A chat's readable history (gateway.history): who said what, for the admin
 * console. Unlike the event log it isn't compacted, and it's kept
 * HISTORY_RETENTION_DAYS. Writing it never gets in the way of the bot: errors
 * are logged and dropped.
 */
import crypto from "node:crypto";
import { getStore, SchemaOutdatedError, type HistoryRole, type HistoryStore } from "../store/index.js";

export interface HistoryLine {
  /** Unique per chat: the platform's message id for incoming ones. Default: a random id. */
  id?: string;
  role: HistoryRole;
  sender?: string;
  text: string;
}

let warned = false;

export async function recordHistory(chat: string, lines: HistoryLine[], store: HistoryStore = getStore()): Promise<void> {
  if (!lines.length) return;
  try {
    await store.addHistory(
      chat,
      lines.map((l) => ({ id: l.id ?? crypto.randomUUID(), role: l.role, sender: l.sender ?? null, text: l.text })),
    );
  } catch (err) {
    if (err instanceof SchemaOutdatedError) {
      if (!warned) console.warn("[history] the database has no history table yet; chat history isn't kept");
      warned = true;
      return;
    }
    console.warn(`[history] couldn't record history for ${chat}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
