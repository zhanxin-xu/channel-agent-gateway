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
  try {
    const res = await fetch(`${meta.origin}/api/worker`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-worker-signature": workerSignature(body) },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    console.log(`[handoff] ${chatKey}: handed off to the worker (HTTP ${res.status})`);
  } catch (err) {
    console.error(`[handoff] ${chatKey}: hand-off failed`, err);
  }
}
