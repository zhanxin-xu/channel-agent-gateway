/** The Responses API (`POST {baseURL}/responses`), called with plain fetch. */
import { config } from "../config.js";
import type { OutputItem, Usage } from "../conversation/events.js";

export interface ResponsesResult {
  id?: string;
  status?: string;
  output?: OutputItem[];
  error?: { message?: string; code?: string } | null;
  incomplete_details?: { reason?: string } | null;
  usage?: Usage;
}

/**
 * A failed model call. `transient`: the same request may well succeed later
 * (it timed out, the network failed, the provider returned 429 or 5xx), so
 * the turn can carry on in a fresh function instead of failing.
 */
export class ModelCallError extends Error {
  override name = "ModelCallError";
  constructor(
    message: string,
    readonly transient: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * The model key has no money left: out of credits (402), or over the key's
 * spending limit (OpenRouter: 403 "Key limit exceeded"). Retrying won't help
 * until it resets or is topped up. `resetsAt`: when, if the provider said.
 */
export class OutOfCreditError extends ModelCallError {
  override name = "OutOfCreditError";
  constructor(
    message: string,
    readonly resetsAt?: number,
  ) {
    super(message, false);
  }
}

/** Whether an error body means the key is out of money, and when it resets ("…; resets 2026-11-06T00:00:00.000Z."). */
function outOfCredit(status: number, error: unknown): { resetsAt?: number } | undefined {
  const e = (error ?? {}) as { message?: unknown; metadata?: { limit_source?: unknown } };
  const message = typeof e.message === "string" ? e.message : "";
  if (status !== 402 && !(status === 403 && (e.metadata?.limit_source || /limit exceeded|credit/i.test(message)))) return undefined;
  const resetsAt = Date.parse(/resets (\S+?)\.?(?:\s|$)/.exec(message)?.[1] ?? "");
  return Number.isNaN(resetsAt) ? {} : { resetsAt };
}

export function outputText(output: OutputItem[]): string {
  return output
    .filter((item) => item.type === "message")
    .flatMap((item) => (item as Extract<OutputItem, { type: "message" }>).content ?? [])
    .filter((part) => part.type === "output_text" && part.text)
    .map((part) => part.text)
    .join("")
    .trim();
}

const isTransientStatus = (status: number) => status === 429 || status >= 500;

/**
 * One model call. It gives up after `timeoutMs` (default OPENAI_RESPONSES_TIMEOUT_MS);
 * callers inside a run pass what's left of the function's time (agent/budget.ts).
 */
export async function createResponse(body: Record<string, unknown>, opts: { timeoutMs?: number } = {}): Promise<ResponsesResult> {
  const { apiKey, baseUrl, extraHeaders, timeoutMs } = config.llm;
  if (!apiKey) throw new ModelCallError("OPENAI_RESPONSES_API_KEY is not set", false);
  const limit = Math.min(timeoutMs, opts.timeoutMs ?? timeoutMs);

  let res: Response;
  let text: string;
  try {
    res = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: { ...extraHeaders, authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(limit),
    });
    text = await res.text();
  } catch (err) {
    // Aborted by the timeout, or no response at all: worth another try.
    const reason = err instanceof Error && err.name === "TimeoutError" ? `no response within ${Math.round(limit / 1000)}s` : String(err);
    throw new ModelCallError(`Responses API: ${reason}`, true, { cause: err });
  }

  let data: ResponsesResult;
  try {
    data = JSON.parse(text) as ResponsesResult;
  } catch {
    throw new ModelCallError(`Responses API HTTP ${res.status}: ${text.slice(0, 300)}`, isTransientStatus(res.status));
  }
  if (!res.ok || data.error) {
    // Gateways may answer 200 with the provider's error code in the body (OpenRouter: {"error":{"code":502,…}}).
    const status = res.ok ? Number(data.error?.code) || res.status : res.status;
    const credit = outOfCredit(status, data.error);
    if (credit) throw new OutOfCreditError(`Responses API HTTP ${status}: ${data.error?.message ?? "out of credit"}`, credit.resetsAt);
    throw new ModelCallError(`Responses API HTTP ${res.status}: ${JSON.stringify(data.error ?? data).slice(0, 300)}`, isTransientStatus(status));
  }
  return data;
}
