/**
 * Continuing a run in a fresh function: a signed POST to /api/worker
 * (worker.ts). A run that is out of time (agent/budget.ts) hands its chat
 * over this way; the worker continues the unfinished turn from the log.
 *
 * The caller releases the chat's lock first and the worker takes it again. If
 * a webhook grabs it in between, that run carries on instead: either way one
 * run continues from the log, and the other finds the chat busy.
 */
import crypto from "node:crypto";
import { config } from "../config.js";

export interface WorkerRequest {
  chatKey: string;
  /** The sampler window was already claimed for this run (an ambient message woke it). */
  ambientClaimed?: boolean;
}

/** Signature of a worker request body. */
export function workerSignature(body: string): string {
  return crypto.createHmac("sha256", config.workerSecret).update(body).digest("hex");
}

/** Waits before each retry: a network error or a 5xx is worth one, a 4xx isn't. Exported for tests. */
export const workerRetry = { waitsMs: [1_000, 3_000] };

/** Ask /api/worker to run a chat. True once it accepted. */
export async function startWorker(origin: string, request: WorkerRequest): Promise<boolean> {
  const body = JSON.stringify(request);
  const { chatKey } = request;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${origin}/api/worker`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-worker-signature": workerSignature(body) },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        console.log(`[handoff] ${chatKey}: started in the worker (HTTP ${res.status})`);
        return true;
      }
      if (res.status < 500) {
        console.error(`[handoff] ${chatKey}: the worker refused (HTTP ${res.status})`);
        return false;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      const wait = workerRetry.waitsMs[attempt - 1];
      const reason = err instanceof Error ? err.message : String(err);
      if (wait === undefined) {
        console.error(`[handoff] ${chatKey}: couldn't reach the worker after ${attempt} attempts (${reason})`);
        return false;
      }
      console.warn(`[handoff] ${chatKey}: attempt ${attempt} failed (${reason}), retrying`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}
