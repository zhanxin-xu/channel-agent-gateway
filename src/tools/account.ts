/**
 * Account tools: let the agent report what's left to spend.
 *   get_search_balance  → GET {DEEPSEEK_BASE_URL}/user/balance   (funds web_search / web_fetch)
 *   get_llm_key_limit   → GET {OPENROUTER_BASE_URL}/key          (current model API key)
 */
import { config } from "../config.js";
import type { Tool } from "./types.js";

/** DeepSeek tool API price: ¥5 per 1,000 successful search/fetch calls. */
const CNY_PER_SEARCH = 5 / 1000;

async function getJson<T>(url: string, apiKey: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, {
    headers: { ...headers, authorization: `Bearer ${apiKey}`, accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${new URL(url).pathname} HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

interface DeepSeekBalance {
  is_available: boolean;
  balance_infos?: Array<{ currency: string; total_balance: string; granted_balance: string; topped_up_balance: string }>;
}

export const searchBalance: Tool = {
  name: "get_search_balance",
  description:
    "Check the remaining balance of the DeepSeek account that pays for web_search / web_fetch, " +
    "and roughly how many more calls it covers.",
  parameters: { type: "object", properties: {} },
  enabled: () => Boolean(config.deepseek.apiKey),
  async run() {
    const data = await getJson<DeepSeekBalance>(`${config.deepseek.baseUrl}/user/balance`, config.deepseek.apiKey);
    return JSON.stringify({
      available: data.is_available,
      balances: (data.balance_infos ?? []).map((b) => ({
        currency: b.currency,
        total: b.total_balance,
        granted: b.granted_balance,
        topped_up: b.topped_up_balance,
        ...(b.currency === "CNY" ? { approx_search_calls_left: Math.floor(Number(b.total_balance) / CNY_PER_SEARCH) } : {}),
      })),
      pricing: "web_search / web_fetch: ¥5 per 1,000 successful calls (shared with any DeepSeek model usage)",
    });
  },
};

interface Budget {
  scope: string;
  limit_usd: number;
  spend_usd: number;
  remaining_usd: number;
  reset_interval: string | null;
  resets_at: string | null;
}

interface KeyInfo {
  data: {
    label?: string;
    limit: number | null;
    limit_remaining: number | null;
    limit_reset: string | null;
    usage: number;
    usage_daily: number;
    usage_weekly: number;
    usage_monthly: number;
    is_free_tier?: boolean;
    expires_at?: string | null;
    effective_budget?: Budget | null;
  };
}

export const llmKeyLimit: Tool = {
  name: "get_llm_key_limit",
  description:
    "Check the model API key's spending limit, remaining credit and usage (today / this week / this month / all time), in USD.",
  parameters: { type: "object", properties: {} },
  enabled: () => Boolean(config.openrouter.apiKey),
  async run() {
    const { baseUrl, apiKey, extraHeaders } = config.openrouter;
    const { data } = await getJson<KeyInfo>(`${baseUrl}/key`, apiKey, extraHeaders);
    const budget = data.effective_budget;
    return JSON.stringify({
      label: data.label,
      currency: "USD",
      limit: data.limit ?? "unlimited",
      limit_remaining: data.limit_remaining ?? "unlimited",
      limit_reset: data.limit_reset ?? "never",
      usage: { today: data.usage_daily, this_week: data.usage_weekly, this_month: data.usage_monthly, all_time: data.usage },
      // The budget that blocks requests first (guardrail / workspace / key limit).
      effective_budget: budget
        ? { scope: budget.scope, limit: budget.limit_usd, spent: budget.spend_usd, remaining: budget.remaining_usd, resets_at: budget.resets_at }
        : null,
      is_free_tier: data.is_free_tier,
      expires_at: data.expires_at ?? null,
    });
  },
};
