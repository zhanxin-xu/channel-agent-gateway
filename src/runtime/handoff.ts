/** Handing a run over to /api/worker (worker.ts) before this function runs out of time. */
import crypto from "node:crypto";
import { config } from "../config.js";
import type { ChatMeta } from "./types.js";

/** Signature of a hand-off request body. */
export function workerSignature(body: string): string {
  return crypto.createHmac("sha256", config.workerSecret).update(body).digest("hex");
}

/** Ask /api/worker to carry on in a fresh function (this one is about to run out of time). */
export async function handOff(meta: ChatMeta, chatKey: string): Promise<void> {
  if (!meta.origin) {
    console.warn(`[handoff] ${chatKey}: out of time with work left, but no origin to hand off to`);
    return;
  }
  const body = JSON.stringify({ chatKey });
  // There are ~2 minutes left, so a network blip or a 5xx gets two more tries. A 4xx won't get better.
  for (const [attempt, wait] of [[1, 1000], [2, 3000], [3, 0]] as const) {
    try {
      const res = await fetch(`${meta.origin}/api/worker`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-worker-signature": workerSignature(body) },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status < 500) {
        if (res.ok) console.log(`[handoff] ${chatKey}: handed off to the worker (HTTP ${res.status})`);
        else console.error(`[handoff] ${chatKey}: the worker refused the hand-off (HTTP ${res.status})`);
        return;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (!wait) {
        console.error(`[handoff] ${chatKey}: hand-off failed after ${attempt} attempts`, err);
        return;
      }
      console.warn(`[handoff] ${chatKey}: attempt ${attempt} failed (${err instanceof Error ? err.message : String(err)}), retrying`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}
