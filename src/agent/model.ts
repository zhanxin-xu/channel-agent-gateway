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

export function outputText(output: OutputItem[]): string {
  return output
    .filter((item) => item.type === "message")
    .flatMap((item) => (item as Extract<OutputItem, { type: "message" }>).content ?? [])
    .filter((part) => part.type === "output_text" && part.text)
    .map((part) => part.text)
    .join("")
    .trim();
}

export async function createResponse(body: Record<string, unknown>): Promise<ResponsesResult> {
  const { apiKey, baseUrl, extraHeaders, timeoutMs } = config.openrouter;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

  const res = await fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { ...extraHeaders, authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data: ResponsesResult;
  try {
    data = JSON.parse(text) as ResponsesResult;
  } catch {
    throw new Error(`Responses API HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!res.ok || data.error) {
    throw new Error(`Responses API HTTP ${res.status}: ${JSON.stringify(data.error ?? data).slice(0, 300)}`);
  }
  return data;
}
