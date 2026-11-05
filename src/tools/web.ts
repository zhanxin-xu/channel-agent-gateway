/**
 * Web search / fetch tools backed by DeepSeek's tool APIs
 * (https://api-docs.deepseek.com/zh-cn/guides/search):
 *   POST {DEEPSEEK_BASE_URL}/v1/tools/search  { query, count, ... } → { results: [...] }
 *   POST {DEEPSEEK_BASE_URL}/v1/tools/fetch   { url }               → { title, content }
 * They are plain HTTP APIs, so they run here as client-side function tools
 * for whatever model the agent uses. Enabled only when DEEPSEEK_API_KEY is set.
 */
import { config } from "../config.js";
import type { Tool, ToolContext } from "./types.js";

const MAX_FETCH_CHARS = 12_000;
const MAX_RESULT_CHARS = 1_500;

interface SearchResult {
  title?: string;
  url?: string;
  snippet?: string;
  summary?: string;
  content?: string;
  site_name?: string;
  publish_time?: string;
  rerank_score?: number;
  authority?: number;
}

/** DeepSeek's tool API. A call gives up after 30s, or sooner when the run's time budget is shorter. */
async function deepseek<T>(path: string, body: unknown, ctx: ToolContext): Promise<T> {
  const { apiKey, baseUrl } = config.deepseek;
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Math.min(30_000, ctx.callBudgetMs())),
  });
  const text = await res.text();
  if (!res.ok) {
    // OpenAI-style error body: { error: { message, type, code } }
    let message = text.slice(0, 300);
    try {
      message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
    } catch {}
    throw new Error(`DeepSeek ${path} HTTP ${res.status}: ${message}`);
  }
  return JSON.parse(text) as T;
}

const enabled = () => Boolean(config.deepseek.apiKey);

export const webSearch: Tool = {
  name: "web_search",
  description:
    "Search the web for up-to-date information. Returns titles, URLs, summaries and publish times. " +
    'Supports operators: site:example.com, -site:, "exact phrase", -keyword, lang:zh,en, after:2025, before:2026-01-01. ' +
    "Use web_fetch to read a result in full.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query, 1-128 characters." },
      count: { type: "integer", description: "Number of results, 1-20. Default 5.", minimum: 1, maximum: 20 },
    },
    required: ["query"],
  },
  enabled,
  async run(args, ctx) {
    const query = String(args.query ?? "").slice(0, 128);
    const count = Math.min(Math.max(Number(args.count) || 5, 1), 20);
    const data = await deepseek<{ results?: SearchResult[] }>("/v1/tools/search", { query, count }, ctx);
    const results = (data.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      site: r.site_name,
      published: r.publish_time,
      summary: (r.summary || r.snippet || "").slice(0, MAX_RESULT_CHARS),
      score: r.rerank_score,
      authority: r.authority,
    }));
    return JSON.stringify({ query, results });
  },
};

export const webFetch: Tool = {
  name: "web_fetch",
  description: "Fetch a web page and return its main content as Markdown.",
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "Absolute http(s) URL." } },
    required: ["url"],
  },
  enabled,
  async run(args, ctx) {
    const url = String(args.url ?? "");
    if (!/^https?:\/\//i.test(url)) throw new Error("url must start with http:// or https://");
    const data = await deepseek<{ title?: string; content?: string }>("/v1/tools/fetch", { url }, ctx);
    const content = data.content ?? "";
    return JSON.stringify({
      url,
      title: data.title ?? "",
      content: content.length > MAX_FETCH_CHARS ? `${content.slice(0, MAX_FETCH_CHARS)}\n…(truncated)` : content,
    });
  },
};
