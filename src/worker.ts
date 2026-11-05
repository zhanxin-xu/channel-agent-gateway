/**
 * Worker endpoint (`POST /api/worker`): where async channels' runs happen.
 * The webhook starts a run here after logging a message, and a run that is
 * out of time hands the chat over to a fresh call here. The request is signed
 * with WORKER_SECRET (see runtime/handoff.ts).
 */
import crypto from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { config } from "./config.js";
import { workerSignature, type WorkerRequest } from "./runtime/handoff.js";
import { runChat, type ChatMeta } from "./runtime/runner.js";
import { channels } from "./channels/index.js";
import { json } from "./channels/types.js";
import { getStore } from "./store/index.js";
import { publicOrigin } from "./webhook.js";

export async function handleWorker(request: Request): Promise<Response> {
  // The function's clock started with this request.
  const deadline = Date.now() + config.agent.maxDurationSeconds * 1000;
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  const body = await request.text();
  const signature = Buffer.from(request.headers.get("x-worker-signature") ?? "");
  const expected = Buffer.from(workerSignature(body));
  if (signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected)) {
    return json({ error: "bad signature" }, 401);
  }

  const { chatKey, ambientClaimed } = JSON.parse(body) as Partial<WorkerRequest>;
  const { session } = chatKey ? await getStore().open(chatKey, Number.MAX_SAFE_INTEGER) : { session: null };
  if (!session) return json({ error: "unknown chat" }, 404);
  const meta: ChatMeta = {
    channel: session.channel,
    conversationId: session.conversationId,
    chatType: session.chatType,
    origin: publicOrigin(request),
  };
  const adapter = channels.get(meta.channel);
  if (!adapter?.send) return json({ error: `channel "${meta.channel}" can't run in the background` }, 400);

  console.log(`[worker] running ${chatKey}`);
  waitUntil(
    runChat(adapter, meta, { ambientClaimed: ambientClaimed === true, deadline }).catch((err) => console.error(`[worker] ${chatKey} failed`, err)),
  );
  return json({ ok: true }, 202);
}
