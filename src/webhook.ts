/**
 * Webhook entry shared by the Vercel function and the local dev server.
 *
 * Async channels (QQ, Telegram) must be ACKed quickly or the platform
 * retries, so the agent runs inside `waitUntil` after the ACK is returned.
 * Sync channels (no `send`) wait for the agent and return the reply.
 */
import { waitUntil } from "@vercel/functions";
import { handleMessage } from "./agent/handle.js";
import { channels } from "./channels/index.js";
import { json, type ChannelAdapter, type InboundMessage } from "./channels/types.js";

async function process(adapter: ChannelAdapter, message: InboundMessage): Promise<void> {
  try {
    await adapter.typing?.(message).catch(() => {});
    // Failures are logged and rethrown so the model sees them as a tool error.
    const logged =
      <A extends unknown[]>(fn: (...args: A) => Promise<void>) =>
      async (...args: A) => {
        try {
          await fn(...args);
        } catch (err) {
          console.error(`[webhook] ${adapter.name} delivery failed`, err);
          throw err;
        }
      };
    const sendImage = adapter.sendImage;
    await handleMessage(adapter, message, {
      text: logged((text: string) => adapter.send!(message, text)),
      image: sendImage ? logged((url: string) => sendImage.call(adapter, message, url)) : undefined,
    });
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
  result.message.origin = publicOrigin(request);

  if (adapter.send) {
    waitUntil(process(adapter, result.message));
    return result.ack ?? json({ ok: true });
  }

  // Sync channel: collect the messages and return them in the response.
  const messages: string[] = [];
  const handled = await handleMessage(adapter, result.message, {
    text: async (text) => {
      messages.push(text);
    },
  });
  return json({ reply: handled ? messages.join("\n") : null, messages });
}

/** The origin the caller used to reach us (Vercel puts the public host in x-forwarded-host). */
function publicOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? url.host;
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${host}`;
}

/** `/api/webhook/qq` → "qq" */
export function channelFromUrl(url: string): string {
  return new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
}
