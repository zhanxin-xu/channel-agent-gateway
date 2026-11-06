/**
 * Worker endpoint (`POST /api/worker`): a run that is out of time hands its
 * chat over to a fresh function here, which continues the unfinished turn.
 * The request is signed with WORKER_SECRET (see runtime/handoff.ts).
 */
import crypto from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { config } from "./config.js";
import { workerSignature, type WorkerRequest } from "./runtime/handoff.js";
import { runChat, type ChatMeta } from "./runtime/runner.js";
import { channels } from "./channels/index.js";
import { json } from "./channels/types.js";
import { refreshSettings } from "./settings/service.js";
import { getStore } from "./store/index.js";
import { publicOrigin } from "./webhook.js";

export async function handleWorker(request: Request): Promise<Response> {
  // The function's clock started with this request.
  const deadline = Date.now() + config.agent.maxDurationSeconds * 1000;
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  // The signature's key may come from the console's settings.
  await refreshSettings();
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

  console.log(`[worker] continuing ${chatKey}`);
  waitUntil(
    runChat(adapter, meta, { ambientClaimed: ambientClaimed === true, deadline }).catch((err) => console.error(`[worker] ${chatKey} failed`, err)),
  );
  return json({ ok: true }, 202);
}
