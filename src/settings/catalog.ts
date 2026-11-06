/**
 * Every setting the admin console manages: one entry per environment
 * variable it stands in for, with its default, how to edit it and how to check
 * it. The single source of truth for defaults: config.ts reads them from here.
 *
 * Not listed, so never stored in the database: what the gateway needs before
 * it can reach the database (ADMIN_PASSWORD, SUPABASE_*, POSTGRES_*), what
 * Vercel sets (VERCEL_*), and AGENT_MAX_DURATION_SECONDS, which must match
 * vercel.json.
 *
 * No imports: config.ts, the settings service and the console all read this.
 */

export type SettingKind = "text" | "textarea" | "secret" | "url" | "int" | "number" | "json" | "enum";

export interface SettingOption {
  value: string;
  label: string;
}

export interface SettingDef {
  /** The environment variable this stands in for. */
  key: string;
  group: SettingGroupId;
  label: string;
  kind: SettingKind;
  /** Used when neither the database nor the environment has a value. */
  default?: string;
  help?: string;
  /** For "enum". */
  options?: SettingOption[];
  /** For "int" and "number": the smallest value accepted (int: 1 unless set). */
  min?: number;
}

export type SettingGroupId = "llm" | "image" | "tts" | "search" | "memory" | "sandbox" | "qq" | "telegram" | "http" | "agent" | "console";

export interface SettingGroup {
  id: SettingGroupId;
  label: string;
  help: string;
  /** The setting that turns the feature on when filled in. */
  enabledBy?: string;
}

const OPENROUTER = "https://openrouter.ai/api/v1";

export const DEFAULT_VOICE_REFERENCE = "assets/voice/dafeiyu.mp3";
export const DEFAULT_SELF_IMAGE = "assets/persona/dafeiyu.webp";

export const SETTING_GROUPS: SettingGroup[] = [
  { id: "llm", label: "模型", help: "任何兼容 OpenAI Responses API 的服务（POST {服务地址}/responses），默认 OpenRouter。", enabledBy: "OPENAI_RESPONSES_API_KEY" },
  { id: "image", label: "画图", help: "generate_image 工具，用 OpenRouter 的 Image API。需要沙盒。", enabledBy: "IMAGE_API_KEY" },
  { id: "tts", label: "语音", help: "send_voice 工具：POST {服务地址}/audio/speech，默认克隆大肥鱼的声音。", enabledBy: "TTS_API_KEY" },
  { id: "search", label: "搜索", help: "DeepSeek 的 web_search / web_fetch，每千次约 ¥5。", enabledBy: "DEEPSEEK_API_KEY" },
  { id: "memory", label: "长期记忆", help: "remember / recall / forget，存在 Upstash Vector（Dense，TEXT_EMBEDDING_3_SMALL，COSINE）。", enabledBy: "UPSTASH_VECTOR_REST_TOKEN" },
  { id: "sandbox", label: "沙盒", help: "bash、读写文件、发文件，每个聊天一个 Vercel Sandbox 工作区。部署在 Vercel 上时自动认证。" },
  { id: "qq", label: "QQ", help: "QQ 开放平台的机器人。回调地址填 https://你的域名/api/webhook/qq，大陆必须绑自定义域名。", enabledBy: "QQ_APP_SECRET" },
  { id: "telegram", label: "Telegram", help: "@BotFather 给的 token。保存后点“设置 Webhook”。", enabledBy: "TELEGRAM_BOT_TOKEN" },
  { id: "http", label: "HTTP", help: "通用 HTTP 接口：POST /api/webhook/http，带 Authorization: Bearer <token>。", enabledBy: "HTTP_CHANNEL_TOKEN" },
  { id: "agent", label: "Agent 参数", help: "步数、上下文、插话频率等。" },
  { id: "console", label: "管理", help: "管理端自己的设置。" },
];

export const SETTINGS: SettingDef[] = [
  // ── Model ──
  { key: "OPENAI_RESPONSES_BASE_URL", group: "llm", label: "服务地址", kind: "url", default: OPENROUTER },
  { key: "OPENAI_RESPONSES_API_KEY", group: "llm", label: "API Key", kind: "secret" },
  { key: "OPENAI_RESPONSES_MODEL", group: "llm", label: "模型", kind: "text", default: "openai/gpt-6-luna" },
  {
    key: "OPENAI_RESPONSES_EXTRA_BODY",
    group: "llm",
    label: "额外请求参数",
    kind: "json",
    help: '合并进每次请求体，例如 {"provider":{"only":["openai"],"allow_fallbacks":false}}。不能覆盖 instructions、input、tools、tool_choice。',
  },
  { key: "OPENAI_RESPONSES_EXTRA_HEADERS", group: "llm", label: "额外请求头", kind: "json", help: '例如 {"X-Title":"my-bot"}' },
  { key: "OPENAI_RESPONSES_TIMEOUT_MS", group: "llm", label: "单次调用超时（毫秒）", kind: "int", default: "280000" },
  {
    key: "MODEL_PRICE_INPUT",
    group: "llm",
    label: "输入单价（美元 / 百万 token）",
    kind: "number",
    min: 0,
    help: "接口没返回花费时，用这三个单价估算每个群的花费（每群额度按它算）。OpenRouter 会返回花费，可以不填。",
  },
  { key: "MODEL_PRICE_CACHED", group: "llm", label: "缓存命中单价（美元 / 百万 token）", kind: "number", min: 0 },
  { key: "MODEL_PRICE_OUTPUT", group: "llm", label: "输出单价（美元 / 百万 token）", kind: "number", min: 0 },

  // ── Images ──
  { key: "IMAGE_API_KEY", group: "image", label: "API Key", kind: "secret" },
  { key: "IMAGE_BASE_URL", group: "image", label: "服务地址", kind: "url", default: OPENROUTER },
  { key: "IMAGE_MODEL", group: "image", label: "模型", kind: "text", default: "openai/gpt-image-2.6-sunburst" },
  {
    key: "IMAGE_QUALITY",
    group: "image",
    label: "质量",
    kind: "enum",
    default: "low",
    options: ["auto", "low", "medium", "high", "xhigh", "max"].map((v) => ({ value: v, label: v })),
    help: "决定价格，由这里定，不让模型选。",
  },
  {
    key: "IMAGE_RESOLUTION",
    group: "image",
    label: "分辨率",
    kind: "enum",
    default: "",
    options: [{ value: "", label: "不发送" }, ...["512", "768", "1K", "1.5K", "2K", "4K"].map((v) => ({ value: v, label: v }))],
    help: "只对支持这个参数的模型有用；默认的 gpt-image 不支持，总是约 1024px。",
  },
  { key: "IMAGE_EXTRA_BODY", group: "image", label: "额外请求参数", kind: "json", help: '例如 {"provider":{"options":{"openai":{"moderation":"low"}}}}' },
  { key: "IMAGE_TIMEOUT_MS", group: "image", label: "超时（毫秒）", kind: "int", default: "180000" },
  {
    key: "IMAGE_SELF_REFERENCE",
    group: "image",
    label: "形象参考图",
    kind: "text",
    default: DEFAULT_SELF_IMAGE,
    help: "画她自己时一起发过去的参考图：部署里的文件或 https 链接；填 none 关闭。",
  },

  // ── Voice ──
  { key: "TTS_API_KEY", group: "tts", label: "API Key", kind: "secret" },
  { key: "TTS_BASE_URL", group: "tts", label: "服务地址", kind: "url", default: OPENROUTER },
  { key: "TTS_MODEL", group: "tts", label: "模型", kind: "text", default: "fish-audio/drama-3" },
  { key: "TTS_VOICE", group: "tts", label: "音色 ID", kind: "text", help: "服务商的音色 ID。留空时由参考音频决定声音。" },
  { key: "TTS_REFERENCE_AUDIO", group: "tts", label: "参考音频", kind: "text", default: DEFAULT_VOICE_REFERENCE, help: "要克隆的声音：部署里的文件或 https 链接；填 none 关闭克隆。" },
  { key: "TTS_REFERENCE_TEXT", group: "tts", label: "参考音频的文字", kind: "textarea", help: "参考音频里说的话。用内置音频时自动填好。" },
  { key: "TTS_SING_REFERENCE_AUDIO", group: "tts", label: "唱歌参考音频", kind: "text", help: "同一个声音唱歌的片段，提供给模型作为 dafeiyu_sing。" },
  { key: "TTS_SING_REFERENCE_TEXT", group: "tts", label: "唱歌参考的文字", kind: "textarea" },
  { key: "TTS_INSTRUCTIONS", group: "tts", label: "固定语气指示", kind: "text", help: "每句话都带上的 instructions，例如“软萌可爱的小女孩”。" },
  { key: "TTS_EXTRA_BODY", group: "tts", label: "额外请求参数", kind: "json", help: '例如 {"speed":1.1}' },
  { key: "TTS_TIMEOUT_MS", group: "tts", label: "超时（毫秒）", kind: "int", default: "120000" },

  // ── Search ──
  { key: "DEEPSEEK_API_KEY", group: "search", label: "DeepSeek API Key", kind: "secret" },
  { key: "DEEPSEEK_BASE_URL", group: "search", label: "服务地址", kind: "url", default: "https://api.deepseek.com" },

  // ── Long-term memory ──
  { key: "UPSTASH_VECTOR_REST_URL", group: "memory", label: "REST URL", kind: "url" },
  { key: "UPSTASH_VECTOR_REST_TOKEN", group: "memory", label: "REST Token", kind: "secret" },

  // ── Sandbox ──
  {
    key: "SANDBOX_ENABLED",
    group: "sandbox",
    label: "沙盒",
    kind: "enum",
    default: "",
    options: [
      { value: "", label: "自动（在 Vercel 上开启）" },
      { value: "1", label: "开" },
      { value: "0", label: "关" },
    ],
  },
  { key: "SANDBOX_REGION", group: "sandbox", label: "区域", kind: "text", help: "默认 iad1。工作区盘建好以后不能改区域，要改请在第一次使用前改。" },
  { key: "SANDBOX_COMMAND_TIMEOUT_SECONDS", group: "sandbox", label: "单条命令时限（秒）", kind: "int", default: "60" },

  // ── Channels ──
  { key: "QQ_APP_ID", group: "qq", label: "AppID", kind: "text" },
  { key: "QQ_APP_SECRET", group: "qq", label: "AppSecret", kind: "secret" },
  { key: "TELEGRAM_BOT_TOKEN", group: "telegram", label: "Bot Token", kind: "secret" },
  { key: "TELEGRAM_WEBHOOK_SECRET", group: "telegram", label: "Webhook Secret", kind: "secret", help: "设置 Webhook 时自动生成。" },
  { key: "TELEGRAM_BOT_USERNAME", group: "telegram", label: "机器人用户名", kind: "text", help: "不带 @。设置 Webhook 时自动填。填了以后群里只回 @ 它的消息。" },
  { key: "HTTP_CHANNEL_TOKEN", group: "http", label: "Bearer Token", kind: "secret" },

  // ── Agent ──
  { key: "AGENT_TIMEZONE", group: "agent", label: "时区", kind: "text", default: "Asia/Shanghai", help: "每条消息前的时间用这个时区。" },
  { key: "AGENT_MAX_STEPS", group: "agent", label: "每轮最多步数", kind: "int", default: "40" },
  { key: "AGENT_CONTEXT_TOKENS", group: "agent", label: "上下文预算（token）", kind: "int", default: "200000", help: "超过 80% 时压缩旧对话。" },
  {
    key: "AGENT_AMBIENT_INTERVAL_SECONDS",
    group: "agent",
    label: "插话频率（秒）",
    kind: "int",
    default: "10",
    min: 0,
    help: "群里没 @ 的消息，每个群每这么多秒最多给模型看一次，由它决定插不插话。0 = 从不插话。每个群可以单独改。",
  },
  { key: "STICKER_BASE_URL", group: "agent", label: "表情包地址", kind: "url", help: "留空用内置的梗鲸表情包 CDN。" },

  // ── Console ──
  {
    key: "CHAT_DEFAULT_MODE",
    group: "console",
    label: "新聊天的回复方式",
    kind: "enum",
    default: "normal",
    options: [
      { value: "normal", label: "正常" },
      { value: "mention", label: "只回 @" },
      { value: "record", label: "只记录" },
      { value: "block", label: "屏蔽" },
    ],
    help: "第一次出现的群和私聊按这个处理，可以在聊天页里单独改。",
  },
  { key: "WORKER_SECRET", group: "console", label: "Worker 签名密钥", kind: "secret", help: "一轮跑不完交给新函数时用来签名。留空时由其他密钥拼出来。" },
];

const byKey = new Map(SETTINGS.map((d) => [d.key, d]));

export const settingDef = (key: string): SettingDef | undefined => byKey.get(key);

/** The default of a listed setting ("" when it has none or isn't listed). */
export const settingDefault = (key: string): string => byKey.get(key)?.default ?? "";

/**
 * Check a value typed into the console and return it normalized. An empty
 * value is valid for every kind: it clears the setting.
 */
export function validateSetting(def: SettingDef, raw: string): { value: string } | { error: string } {
  const value = def.kind === "textarea" || def.kind === "json" ? raw.trim() : raw.trim().replace(/\s*\n\s*/g, "");
  if (!value) return { value: "" };
  switch (def.kind) {
    case "url":
      return /^https?:\/\/[^\s/]+/i.test(value) ? { value: value.replace(/\/+$/, "") } : { error: "要以 http:// 或 https:// 开头" };
    case "int": {
      const min = def.min ?? 1;
      return /^\d+$/.test(value) && Number(value) >= min ? { value: String(Number(value)) } : { error: `要填不小于 ${min} 的整数` };
    }
    case "number": {
      const n = Number(value);
      return Number.isFinite(n) && n >= (def.min ?? 0) ? { value: String(n) } : { error: `要填不小于 ${def.min ?? 0} 的数字` };
    }
    case "json": {
      try {
        const parsed: unknown = JSON.parse(value);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "要填一个 JSON 对象，例如 {\"a\":1}" };
        return { value: JSON.stringify(parsed) };
      } catch (err) {
        return { error: `不是合法的 JSON：${err instanceof Error ? err.message : String(err)}` };
      }
    }
    case "enum":
      return def.options?.some((o) => o.value === value) ? { value } : { error: `只能是 ${def.options?.map((o) => o.value || "（空）").join("、")}` };
    default:
      return { value };
  }
}
