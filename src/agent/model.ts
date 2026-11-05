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
    throw new ModelCallError(`Responses API HTTP ${res.status}: ${JSON.stringify(data.error ?? data).slice(0, 300)}`, isTransientStatus(status));
  }
  return data;
}
