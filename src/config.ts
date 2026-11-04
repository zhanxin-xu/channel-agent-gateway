/**
 * All runtime configuration comes from environment variables so the same
 * build can be deployed to any Vercel project. Values are read lazily
 * (on every access) so tests and the local dev server can override them.
 */

function str(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function int(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Parse an env var holding a JSON object; fail loudly on malformed config. */
function jsonObject(name: string): Record<string, unknown> {
  const raw = str(name);
  if (!raw) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${name} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

export const config = {
  openrouter: {
    get apiKey() {
      return str("OPENROUTER_API_KEY");
    },
    /** Any Responses-API-compatible base URL; `/responses` is appended. */
    get baseUrl() {
      return str("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1").replace(/\/+$/, "");
    },
    get model() {
      return str("OPENROUTER_MODEL", "openai/gpt-6-luna");
    },
    /**
     * Extra fields merged into every Responses API request body (snake_case,
     * sent as-is), e.g. provider locking:
     *   {"provider":{"only":["openai"],"allow_fallbacks":false}}
     * Cannot override instructions / input / tools / tool_choice.
     */
    get extraBody() {
      return jsonObject("OPENROUTER_EXTRA_BODY");
    },
    /** Extra request headers, e.g. {"HTTP-Referer":"https://example.com","X-Title":"my-bot"}. */
    get extraHeaders() {
      return jsonObject("OPENROUTER_EXTRA_HEADERS") as Record<string, string>;
    },
    get timeoutMs() {
      return int("OPENROUTER_TIMEOUT_MS", 120_000);
    },
  },

  /** DeepSeek web search / fetch tools. Disabled when the key is empty. */
  deepseek: {
    get apiKey() {
      return str("DEEPSEEK_API_KEY");
    },
    get baseUrl() {
      return str("DEEPSEEK_BASE_URL", "https://api.deepseek.com").replace(/\/+$/, "");
    },
  },

  /** Where sticker images are fetched from; defaults to the 梗鲸 archive CDN (see stickers.ts). */
  get stickerBaseUrl() {
    return str("STICKER_BASE_URL");
  },

  // The system prompt lives in src/agent/system-prompt.ts.
  agent: {
    /** Time zone of the time stamp prepended to each user message. */
    get timezone() {
      return str("AGENT_TIMEZONE", "Asia/Shanghai");
    },
    /** Max model calls per inbound message (tool round-trips included). */
    get maxSteps() {
      return int("AGENT_MAX_STEPS", 6);
    },
    /**
     * Messages kept per private conversation. A safety cap against unbounded
     * growth, not a context budget: lists trim back to this once they pass it by 25%.
     */
    get historyLimit() {
      return int("AGENT_HISTORY_LIMIT", 100);
    },
    /** Messages kept per group (everyone's messages are recorded); what an @ run sees. */
    get groupHistoryLimit() {
      return int("AGENT_GROUP_HISTORY_LIMIT", 200);
    },
    /** How many recent messages an ambient run sees (they're frequent, so keep them cheap). */
    get ambientContext() {
      return int("AGENT_AMBIENT_CONTEXT", 40);
    },
    /** A conversation's history is deleted after this many days without messages. */
    get historyTtlDays() {
      return int("AGENT_HISTORY_TTL_DAYS", 7);
    },
    /**
     * Ordinary (non-@) group messages are always recorded; at most one per this
     * many seconds per group is shown to the agent, which decides whether to chime
     * in. 0 = record only, never trigger the agent.
     */
    get ambientIntervalSeconds() {
      const n = Number.parseInt(process.env.AGENT_AMBIENT_INTERVAL_SECONDS ?? "", 10);
      return Number.isFinite(n) && n >= 0 ? n : 10;
    },
    /** Step budget for an ambient run: decide, maybe look something up, talk. */
    get ambientMaxSteps() {
      return int("AGENT_AMBIENT_MAX_STEPS", 3);
    },
  },

  qq: {
    get appId() {
      return str("QQ_APP_ID");
    },
    get appSecret() {
      return str("QQ_APP_SECRET");
    },
  },

  telegram: {
    get botToken() {
      return str("TELEGRAM_BOT_TOKEN");
    },
    /** Must match the secret_token passed to setWebhook. */
    get webhookSecret() {
      return str("TELEGRAM_WEBHOOK_SECRET");
    },
    /** Without @. When set, group messages are answered only if they mention the bot. */
    get botUsername() {
      return str("TELEGRAM_BOT_USERNAME");
    },
  },

  http: {
    /** Bearer token for the generic HTTP channel. Channel is disabled when empty. */
    get token() {
      return str("HTTP_CHANNEL_TOKEN");
    },
  },

  store: {
    // Upstash Redis REST credentials. The Vercel Marketplace integration
    // injects KV_REST_API_*; a direct Upstash setup uses UPSTASH_REDIS_REST_*.
    get url() {
      return str("UPSTASH_REDIS_REST_URL") || str("KV_REST_API_URL");
    },
    get token() {
      return str("UPSTASH_REDIS_REST_TOKEN") || str("KV_REST_API_TOKEN");
    },
  },

  /**
   * Long-term memory (remember / recall / forget), shared by every chat.
   * An Upstash Vector index created with a built-in embedding model (e.g. BGE-M3
   * for Chinese), so the gateway sends raw text. Disabled when empty.
   */
  memory: {
    get url() {
      return str("UPSTASH_VECTOR_REST_URL").replace(/\/+$/, "");
    },
    get token() {
      return str("UPSTASH_VECTOR_REST_TOKEN");
    },
  },

  /**
   * Vercel Sandbox workspace (bash / read_file / write_file). Each chat gets
   * its own Drive mounted at /workspace. On Vercel the SDK authenticates with
   * the project's OIDC token; locally it needs VERCEL_OIDC_TOKEN (`vercel env pull`).
   */
  sandbox: {
    /** On by default where credentials exist; SANDBOX_ENABLED=0 turns it off. */
    get enabled() {
      if (/^(0|false|off)$/i.test(str("SANDBOX_ENABLED"))) return false;
      return Boolean(process.env.VERCEL || str("VERCEL_OIDC_TOKEN") || /^(1|true|on)$/i.test(str("SANDBOX_ENABLED")));
    },
    /** Region for sandboxes and their drives (they must match). Default: Vercel's default, iad1. */
    get region() {
      return str("SANDBOX_REGION");
    },
    /** Per-command time limit. */
    get commandTimeoutSeconds() {
      return int("SANDBOX_COMMAND_TIMEOUT_SECONDS", 60);
    },
  },
};
