/**
 * Hand-off endpoint (`POST /api/worker`): a run that is about to hit the
 * function's time limit with messages still waiting asks a fresh function to
 * carry on. The request is signed with WORKER_SECRET (see handle.ts).
 */
import crypto from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { runChat, workerSignature, type ChatMeta } from "./agent/handle.js";
import { channels } from "./channels/index.js";
import { json } from "./channels/types.js";
import { getStore } from "./store/index.js";
import { publicOrigin } from "./webhook.js";

export async function handleWorker(request: Request): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  const body = await request.text();
  const signature = Buffer.from(request.headers.get("x-worker-signature") ?? "");
  const expected = Buffer.from(workerSignature(body));
  if (signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected)) {
    return json({ error: "bad signature" }, 401);
  }

  const { chatKey } = JSON.parse(body) as { chatKey?: string };
  const { session } = chatKey ? await getStore().open(chatKey, Number.MAX_SAFE_INTEGER) : { session: null };
  if (!session) return json({ error: "unknown chat" }, 404);
  const meta: ChatMeta = {
    channel: session.channel,
    conversationId: session.conversationId,
    chatType: session.chatType,
    origin: publicOrigin(request),
  };
  const adapter = channels.get(meta.channel);
  if (!adapter?.send) return json({ error: `channel "${meta.channel}" can't continue in the background` }, 400);

  console.log(`[worker] continuing ${chatKey}`);
  waitUntil(runChat(adapter, meta).catch((err) => console.error(`[worker] ${chatKey} failed`, err)));
  return json({ ok: true }, 202);
}
