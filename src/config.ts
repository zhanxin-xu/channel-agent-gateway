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
    /** Max model calls per turn, ambient or not (tool round-trips included). An ambient run that stays silent uses one. */
    get maxSteps() {
      return int("AGENT_MAX_STEPS", 40);
    },
    /**
     * The function's time limit; keep in sync with maxDuration in vercel.json.
     * When less than 90s is left, the next step is the last (see runTurn).
     */
    get maxDurationSeconds() {
      return int("AGENT_MAX_DURATION_SECONDS", 300);
    },
    /**
     * The context budget in tokens. When a request's input passes 80% of it,
     * the older part of the conversation is summarized (see compaction.ts).
     */
    get contextTokens() {
      return int("AGENT_CONTEXT_TOKENS", 200_000);
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
    // Supabase (Postgres, see supabase/schema.sql). The Vercel Marketplace
    // integration injects SUPABASE_URL and the server keys. Without them the
    // store is per-instance memory (local development and tests only).
    get supabaseUrl() {
      return str("SUPABASE_URL").replace(/\/+$/, "");
    },
    get supabaseKey() {
      return str("SUPABASE_SECRET_KEY");
    },
  },

  /**
   * Long-term memory (remember / recall / forget), shared by every chat.
   * An Upstash Vector index created with a hosted embedding model
   * (text-embedding-3-small), so the gateway sends raw text. Disabled when empty.
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
   * Signs the hand-off request a run sends to /api/worker when it runs out of
   * time with messages still waiting. Derived from the other secrets when unset.
   */
  get workerSecret() {
    return str("WORKER_SECRET") || str("OPENROUTER_API_KEY") + str("QQ_APP_SECRET") + str("TELEGRAM_BOT_TOKEN");
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
