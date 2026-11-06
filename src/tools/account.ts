/**
 * Account tools: let the agent report what's left to spend.
 *   get_search_balance  → GET {DEEPSEEK_BASE_URL}/user/balance   (funds web_search / web_fetch)
 *   get_llm_key_limit   → GET {OPENAI_RESPONSES_BASE_URL}/key and {IMAGE_BASE_URL}/key (model and image keys; OpenRouter only)
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
    return JSON.stringify(await searchBalanceReport());
  },
};

/** The DeepSeek balance (also shown in the admin console). */
export async function searchBalanceReport() {
  const data = await getJson<DeepSeekBalance>(`${config.deepseek.baseUrl}/user/balance`, config.deepseek.apiKey);
  return {
    available: data.is_available,
    balances: (data.balance_infos ?? []).map((b) => ({
      currency: b.currency,
      total: b.total_balance,
      granted: b.granted_balance,
      topped_up: b.topped_up_balance,
      ...(b.currency === "CNY" ? { approx_search_calls_left: Math.floor(Number(b.total_balance) / CNY_PER_SEARCH) } : {}),
    })),
    pricing: "web_search / web_fetch: ¥5 per 1,000 successful calls (shared with any DeepSeek model usage)",
  };
}

interface Budget {
  scope: string;
  limit_usd: number;
  spend_usd: number;
  remaining_usd: number;
  reset_interval: string | null;
  resets_at: string | null;
  include_byok?: boolean;
}

/** OpenRouter's GET /key. `usage*` is spend on OpenRouter credits; `byok_usage*` is spend billed to your own provider keys. */
interface KeyInfo {
  data: {
    label?: string;
    limit: number | null;
    limit_remaining: number | null;
    limit_reset: string | null;
    include_byok_in_limit?: boolean;
    usage: number;
    usage_daily: number;
    usage_weekly: number;
    usage_monthly: number;
    byok_usage?: number;
    byok_usage_daily?: number;
    byok_usage_weekly?: number;
    byok_usage_monthly?: number;
    is_free_tier?: boolean;
    expires_at?: string | null;
    effective_budget?: Budget | null;
  };
}

export const llmKeyLimit: Tool = {
  name: "get_llm_key_limit",
  description:
    "Check the spending limit, remaining credit and usage (today / this week / this month / all time, USD) of the API keys: " +
    "model_key pays for you (the chat model), image_key for generate_image (when it has its own key). " +
    "Spend is split into OpenRouter credits (usage) and your own provider keys (byok_usage); a budget may count both.",
  parameters: { type: "object", properties: {} },
  enabled: () => Boolean(config.llm.apiKey || config.image.apiKey),
  async run() {
    const model = config.llm;
    const image = config.image;
    const sameKey = Boolean(image.apiKey) && image.apiKey === model.apiKey;
    const [modelKey, imageKey] = await Promise.all([
      model.apiKey ? keyReport(model.baseUrl, model.apiKey, model.extraHeaders) : undefined,
      image.apiKey && !sameKey ? keyReport(image.baseUrl, image.apiKey) : undefined,
    ]);
    return JSON.stringify({
      currency: "USD",
      ...(modelKey ? { model_key: modelKey } : {}),
      ...(sameKey ? { image_key: "same key as model_key: one limit and one usage for both" } : imageKey ? { image_key: imageKey } : {}),
      note:
        "usage = spend on OpenRouter credits; byok_usage = spend on your own provider keys. A budget or limit that counts BYOK " +
        "includes both, so it can show spend while usage is 0. Daily / weekly / monthly windows reset at 00:00 UTC (08:00 Beijing), weeks run Monday–Sunday.",
    });
  },
};

/** One key's limit and usage from OpenRouter's GET /key; an error is reported in place so the other key still shows. */
export async function keyReport(baseUrl: string, apiKey: string, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  let data: KeyInfo["data"];
  try {
    ({ data } = await getJson<KeyInfo>(`${baseUrl}/key`, apiKey, headers));
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  const budget = data.effective_budget;
  const hasByok = [data.byok_usage, data.byok_usage_daily, data.byok_usage_weekly, data.byok_usage_monthly].some((n) => typeof n === "number");
  return {
    label: data.label,
    limit: data.limit ?? "unlimited",
    limit_remaining: data.limit_remaining ?? "unlimited",
    limit_reset: data.limit_reset ?? "never",
    ...(data.include_byok_in_limit === undefined ? {} : { limit_counts_byok: data.include_byok_in_limit }),
    // Spend on OpenRouter credits only.
    usage: { today: data.usage_daily, this_week: data.usage_weekly, this_month: data.usage_monthly, all_time: data.usage },
    // Spend billed to your own provider keys (BYOK); not in `usage`.
    ...(hasByok
      ? { byok_usage: { today: data.byok_usage_daily ?? 0, this_week: data.byok_usage_weekly ?? 0, this_month: data.byok_usage_monthly ?? 0, all_time: data.byok_usage ?? 0 } }
      : {}),
    // The budget that blocks requests first (guardrail / workspace / key limit).
    effective_budget: budget
      ? {
          scope: budget.scope,
          limit: budget.limit_usd,
          spent: budget.spend_usd,
          remaining: budget.remaining_usd,
          reset_interval: budget.reset_interval,
          resets_at: budget.resets_at,
          ...(budget.include_byok === undefined ? {} : { counts_byok: budget.include_byok }),
        }
      : null,
    is_free_tier: data.is_free_tier,
    expires_at: data.expires_at ?? null,
  };
}
