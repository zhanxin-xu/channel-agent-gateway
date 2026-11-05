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

/** 大肥鱼's voice: a short clip in the repo (bundled via vercel.json includeFiles), cloned by send_voice. */
export const DEFAULT_VOICE_REFERENCE = "assets/voice/dafeiyu.mp3";
/** What 大肥鱼 looks like: a picture in the repo (bundled via vercel.json includeFiles), the reference when she draws herself. */
export const DEFAULT_SELF_IMAGE = "assets/persona/dafeiyu.webp";
const DEFAULT_VOICE_REFERENCE_TEXT = "嘿嘿，本鱼来啦！我是大肥鱼，住在深海里的小鲸鱼～有什么问题尽管问我，答对了要请我吃小鱼干哦！";

/** Model settings: OPENAI_RESPONSES_<SUFFIX>, falling back to the old OPENROUTER_<SUFFIX> names. */
const LLM_SUFFIXES = ["API_KEY", "BASE_URL", "MODEL", "EXTRA_BODY", "EXTRA_HEADERS", "TIMEOUT_MS"] as const;
type LlmSuffix = (typeof LLM_SUFFIXES)[number];

/** The variable to read for a model setting: the new name, unless only the old one is set. */
function llmEnv(suffix: LlmSuffix): string {
  const name = `OPENAI_RESPONSES_${suffix}`;
  const legacy = `OPENROUTER_${suffix}`;
  return !str(name) && str(legacy) ? legacy : name;
}

export const config = {
  /** Any server that speaks the OpenAI Responses API (POST {baseUrl}/responses). Defaults to OpenRouter. */
  llm: {
    get apiKey() {
      return str(llmEnv("API_KEY"));
    },
    /** Any Responses-API-compatible base URL; `/responses` is appended. */
    get baseUrl() {
      return str(llmEnv("BASE_URL"), "https://openrouter.ai/api/v1").replace(/\/+$/, "");
    },
    get model() {
      return str(llmEnv("MODEL"), "openai/gpt-6-luna");
    },
    /**
     * Extra fields merged into every Responses API request body (snake_case,
     * sent as-is), e.g. OpenRouter provider locking:
     *   {"provider":{"only":["openai"],"allow_fallbacks":false}}
     * Cannot override instructions / input / tools / tool_choice.
     */
    get extraBody() {
      return jsonObject(llmEnv("EXTRA_BODY"));
    },
    /** Extra request headers, e.g. {"HTTP-Referer":"https://example.com","X-Title":"my-bot"}. */
    get extraHeaders() {
      return jsonObject(llmEnv("EXTRA_HEADERS")) as Record<string, string>;
    },
    /**
     * Upper bound for one model call. Inside a run a call also ends when the
     * function's time budget does (agent/budget.ts), whichever comes first.
     */
    get timeoutMs() {
      return int(llmEnv("TIMEOUT_MS"), 280_000);
    },
    /** Old OPENROUTER_* names still in use (shown by /api/health so they can be renamed). */
    get legacyEnv(): string[] {
      return LLM_SUFFIXES.map(llmEnv).filter((name) => name.startsWith("OPENROUTER_"));
    },
  },

  /**
   * Image generation (generate_image): POST {baseUrl}/images, OpenRouter's Image API.
   * Disabled when the key is empty. Names follow the API's fields.
   */
  image: {
    get apiKey() {
      return str("IMAGE_API_KEY");
    },
    get baseUrl() {
      return str("IMAGE_BASE_URL", "https://openrouter.ai/api/v1").replace(/\/+$/, "");
    },
    get model() {
      return str("IMAGE_MODEL", "openai/gpt-image-2.6-sunburst");
    },
    /** auto | low | medium | high | xhigh | max. Set here, not by the model: it drives the price. */
    get quality() {
      return str("IMAGE_QUALITY", "low");
    },
    /**
     * 512 | 768 | 1K | 1.5K | 2K | 4K, for models that take it (see supported_parameters in
     * GET /api/v1/images/models). Unset by default: the default gpt-image models don't, and
     * draw at about 1024px whatever is sent. Results are scaled down to fit 1920×1080.
     */
    get resolution() {
      return str("IMAGE_RESOLUTION");
    },
    /** Extra request body fields, e.g. {"provider":{"options":{"openai":{"moderation":"low"}}}}. */
    get extraBody() {
      return jsonObject("IMAGE_EXTRA_BODY");
    },
    get timeoutMs() {
      return int("IMAGE_TIMEOUT_MS", 180_000);
    },
    /**
     * A picture of the persona (a file in the deployment, or an https URL),
     * sent as a reference whenever generate_image draws her (include_self), so
     * she looks the same every time. "none" turns it off.
     */
    get selfImage() {
      const value = str("IMAGE_SELF_REFERENCE", DEFAULT_SELF_IMAGE);
      return value.toLowerCase() === "none" ? "" : value;
    },
  },

  /** Speech for send_voice: POST {TTS_BASE_URL}/audio/speech. Hidden when the key is empty. */
  tts: {
    get apiKey() {
      return str("TTS_API_KEY");
    },
    get baseUrl() {
      return str("TTS_BASE_URL", "https://openrouter.ai/api/v1").replace(/\/+$/, "");
    },
    /** The speech model (set here, not chosen by the agent). */
    get model() {
      return str("TTS_MODEL", "fish-audio/drama-3");
    },
    /** The API's `voice` (a provider voice ID). Empty: the reference audio sets the voice. */
    get voice() {
      return str("TTS_VOICE");
    },
    /** The voice to clone: a file in the deployment, or an https URL; "none" turns cloning off. */
    get referenceAudio() {
      const value = str("TTS_REFERENCE_AUDIO", DEFAULT_VOICE_REFERENCE);
      return value.toLowerCase() === "none" ? "" : value;
    },
    /** What the reference audio says (helps the clone). Defaults to the built-in clip's words when that clip is used. */
    get referenceText() {
      return str("TTS_REFERENCE_TEXT", this.referenceAudio === DEFAULT_VOICE_REFERENCE ? DEFAULT_VOICE_REFERENCE_TEXT : "");
    },
    /**
     * Optional second clip of the same voice singing (file or https URL), offered
     * to the model as voice "dafeiyu_sing". Empty: not offered.
     */
    get singReferenceAudio() {
      const value = str("TTS_SING_REFERENCE_AUDIO");
      return value.toLowerCase() === "none" ? "" : value;
    },
    /** What the singing clip sings. */
    get singReferenceText() {
      return str("TTS_SING_REFERENCE_TEXT");
    },
    /** The API's `instructions`: a standing direction for every line, e.g. "软萌可爱的小女孩". The model can add its own. */
    get instructions() {
      return str("TTS_INSTRUCTIONS");
    },
    /** Extra request body fields, e.g. {"speed":1.1} or {"provider":{"options":{...}}}. */
    get extraBody() {
      return jsonObject("TTS_EXTRA_BODY");
    },
    get timeoutMs() {
      return int("TTS_TIMEOUT_MS", 120_000);
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
     * Runs plan their steps and calls around it (agent/budget.ts).
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
    return str("WORKER_SECRET") || config.llm.apiKey + str("QQ_APP_SECRET") + str("TELEGRAM_BOT_TOKEN");
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
