/**
 * Calls to a platform's API (QQ, Telegram) and how they fail. A connection
 * that can't be made is tried once more: nothing reached the server, so a
 * retry can't post a message twice. When the platform still can't be reached,
 * the outbox stops sending for the rest of the run (runtime/outbox.ts).
 */

/** Errors (undici's `cause.code`) that mean no connection was made. */
const CONNECT_ERRORS = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);

/** Wait before the second try. Exported for tests. */
export const connectRetry = { delayMs: 1_000 };

/** The platform's API can't be reached right now (no connection, or a 5xx). */
export class ChannelUnreachableError extends Error {
  override name = "ChannelUnreachableError";
}

/**
 * The platform refused a push (a message replying to nothing): the chat
 * doesn't allow the bot to post on its own, or too many were sent. Waiting
 * for someone to write opens a reply window again.
 */
export class PushRefusedError extends Error {
  override name = "PushRefusedError";
}

const causeCode = (err: unknown): string | undefined =>
  err instanceof Error ? ((err.cause as { code?: unknown } | undefined)?.code as string | undefined) : undefined;

/** fetch threw before connecting: nothing was sent. */
export function connectFailed(err: unknown): boolean {
  return err instanceof TypeError && CONNECT_ERRORS.has(causeCode(err) ?? "");
}

/** fetch, trying once more after a short wait when the connection couldn't be made. */
export async function platformFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (!connectFailed(err)) throw err;
    console.warn(`[net] ${new URL(url).host}: ${causeCode(err)}, trying again in ${connectRetry.delayMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, connectRetry.delayMs));
    return fetch(url, init);
  }
}

/**
 * A short reason when `err` means the platform can't be reached (a network
 * error from fetch, a timeout, or a 5xx the adapter reported), else undefined.
 */
export function unreachableReason(err: unknown): string | undefined {
  if (err instanceof ChannelUnreachableError) return err.message;
  if (err instanceof TypeError && err.message === "fetch failed") return `network error: ${causeCode(err) ?? "fetch failed"}`;
  if (err instanceof Error && err.name === "TimeoutError") return "request timed out";
  return undefined;
}
