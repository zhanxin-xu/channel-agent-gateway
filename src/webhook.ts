/**
 * Webhook entry shared by the Vercel function and the local dev server.
 *
 * Async channels (QQ, Telegram) must be ACKed quickly or the platform
 * retries, so logging the message and running the agent happen inside
 * `waitUntil` after the ACK is returned (a turn that outlasts the function
 * continues in /api/worker). Sync channels (no `send`) wait for the agent and
 * return its replies.
 */
import { waitUntil } from "@vercel/functions";
import { handleMessage } from "./runtime/ingress.js";
import { channels } from "./channels/index.js";
import { json, type ChannelAdapter, type InboundMessage } from "./channels/types.js";

async function process(adapter: ChannelAdapter, message: InboundMessage, origin: string): Promise<void> {
  try {
    if (message.mode !== "ambient") await adapter.typing?.(message).catch(() => {});
    await handleMessage(adapter, message, { origin });
  } catch (err) {
    console.error(`[webhook] ${adapter.name} processing failed`, err);
  }
}

export async function handleWebhook(request: Request, channelName: string): Promise<Response> {
  const adapter = channels.get(channelName);
  if (!adapter) return json({ error: `unknown channel "${channelName}"` }, 404);
  if (!adapter.isConfigured()) return json({ error: `channel "${channelName}" is not configured` }, 503);
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);

  // Signatures are computed over the exact bytes, so read the raw body once.
  const rawBody = await request.text();
  const op = /"op"\s*:\s*(\d+)/.exec(rawBody)?.[1];
  const event = /"t"\s*:\s*"(\w+)"/.exec(rawBody)?.[1];
  console.log(
    `[webhook] ${channelName} ${request.method} ua=${request.headers.get("user-agent") ?? "-"} ` +
      `appid=${request.headers.get("x-bot-appid") ?? "-"} bytes=${rawBody.length}` +
      `${op ? ` op=${op}` : ""}${event ? ` t=${event}` : ""}`,
  );
  const result = await adapter.receive(request, rawBody);
  if (result.kind === "respond") return result.response;
  const origin = publicOrigin(request);

  if (adapter.send) {
    waitUntil(process(adapter, result.message, origin));
    return result.ack ?? json({ ok: true });
  }

  // Sync channel: collect the replies and return them in the response.
  // "busy": another request is running this conversation; it will answer this message too.
  const messages: string[] = [];
  const outcome = await handleMessage(adapter, result.message, { origin, collect: messages });
  return json({ reply: outcome === "handled" ? messages.join("\n") : null, messages, ...(outcome === "busy" ? { queued: true } : {}) });
}

/** The origin the caller used to reach us (Vercel puts the public host in x-forwarded-host). */
export function publicOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? url.host;
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${host}`;
}

/** `/api/webhook/qq` → "qq" */
export function channelFromUrl(url: string): string {
  return new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
}
