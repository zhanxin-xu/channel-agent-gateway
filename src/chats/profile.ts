/**
 * A chat's own settings, set in the admin console (gateway.chat_profiles):
 * a name for people, how the bot replies there, how often it may chime in,
 * which tools it may use, extra instructions, and daily quotas.
 *
 * Read on every message, so each instance keeps profiles for CACHE_MS; a
 * change reaches every instance within that time.
 */
import { config } from "../config.js";
import { settingDef, type SettingOption } from "../settings/catalog.js";
import { getStore, SchemaOutdatedError, type ProfileStore } from "../store/index.js";
import type { ToolFeature } from "../tools/types.js";

/**
 *   normal:  an @ or a DM is always answered; ordinary group messages are sampled (it may chime in).
 *   mention: only an @ or a DM is answered.
 *   record:  messages are logged (the bot sees them later as context) but never answered.
 *   block:   messages are dropped, not even logged.
 */
export type ReplyMode = "normal" | "mention" | "record" | "block";

/** Daily limits; see usage.ts for how each is counted. */
export type QuotaKey = "cost_usd" | "images" | "voices" | "searches";

/**
 * What a chat's settings can be, with their names for people (the console
 * shows these). The reply modes are CHAT_DEFAULT_MODE's options in the catalog.
 */
export const PROFILE_CHOICES: { modes: SettingOption[]; features: SettingOption[]; quotas: SettingOption[] } = {
  modes: settingDef("CHAT_DEFAULT_MODE")!.options!,
  features: [
    { value: "image", label: "画图" },
    { value: "voice", label: "语音" },
    { value: "search", label: "搜索" },
    { value: "memory", label: "记忆" },
    { value: "sandbox", label: "沙盒" },
  ],
  quotas: [
    { value: "cost_usd", label: "模型花费（美元）" },
    { value: "images", label: "画图（张）" },
    { value: "voices", label: "语音（条）" },
    { value: "searches", label: "搜索（次）" },
  ],
};
const REPLY_MODES = PROFILE_CHOICES.modes.map((o) => o.value) as ReplyMode[];
const TOOL_FEATURES = PROFILE_CHOICES.features.map((o) => o.value) as ToolFeature[];
const QUOTA_KEYS = PROFILE_CHOICES.quotas.map((o) => o.value) as QuotaKey[];
const isReplyMode = (value: unknown): value is ReplyMode => REPLY_MODES.includes(value as ReplyMode);

export interface ChatProfile {
  title?: string;
  /** Unset: CHAT_DEFAULT_MODE. */
  mode?: ReplyMode;
  /** Unset: AGENT_AMBIENT_INTERVAL_SECONDS. */
  ambientIntervalSeconds?: number;
  disabledTools?: ToolFeature[];
  /** Appended to the system prompt in this chat. */
  prompt?: string;
  quota?: Partial<Record<QuotaKey, number>>;
}

const MAX_TITLE = 60;
const MAX_PROMPT = 2000;

/**
 * Check a profile from the console. Returns the cleaned profile, or a message
 * per bad field. Empty fields are dropped (back to the defaults).
 */
export function validateProfile(input: unknown): { profile: ChatProfile } | { errors: Record<string, string> } {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const errors: Record<string, string> = {};
  const profile: ChatProfile = {};

  if (raw.title !== undefined && raw.title !== null && raw.title !== "") {
    if (typeof raw.title !== "string" || raw.title.trim().length > MAX_TITLE) errors.title = `最多 ${MAX_TITLE} 个字`;
    else profile.title = raw.title.trim();
  }
  if (raw.mode !== undefined && raw.mode !== null && raw.mode !== "") {
    if (!isReplyMode(raw.mode)) errors.mode = `只能是 ${REPLY_MODES.join("、")}`;
    else profile.mode = raw.mode;
  }
  if (raw.ambientIntervalSeconds !== undefined && raw.ambientIntervalSeconds !== null && raw.ambientIntervalSeconds !== "") {
    const n = Number(raw.ambientIntervalSeconds);
    if (!Number.isInteger(n) || n < 0) errors.ambientIntervalSeconds = "要填不小于 0 的整数";
    else profile.ambientIntervalSeconds = n;
  }
  if (raw.disabledTools !== undefined && raw.disabledTools !== null) {
    const list = Array.isArray(raw.disabledTools) ? raw.disabledTools : [];
    if (!Array.isArray(raw.disabledTools) || list.some((f) => !TOOL_FEATURES.includes(f as ToolFeature))) {
      errors.disabledTools = `只能是 ${TOOL_FEATURES.join("、")}`;
    } else if (list.length) {
      profile.disabledTools = [...new Set(list as ToolFeature[])];
    }
  }
  if (raw.prompt !== undefined && raw.prompt !== null && raw.prompt !== "") {
    if (typeof raw.prompt !== "string" || raw.prompt.trim().length > MAX_PROMPT) errors.prompt = `最多 ${MAX_PROMPT} 个字`;
    else if (raw.prompt.trim()) profile.prompt = raw.prompt.trim();
  }
  if (raw.quota !== undefined && raw.quota !== null) {
    const quota = raw.quota && typeof raw.quota === "object" ? (raw.quota as Record<string, unknown>) : null;
    if (!quota) errors.quota = "要是一个对象";
    for (const [key, value] of Object.entries(quota ?? {})) {
      if (value === null || value === "" || value === undefined) continue;
      const n = Number(value);
      if (!QUOTA_KEYS.includes(key as QuotaKey)) errors[`quota.${key}`] = "不认识的额度";
      else if (!Number.isFinite(n) || n < 0) errors[`quota.${key}`] = "要填不小于 0 的数字";
      else (profile.quota ??= {})[key as QuotaKey] = n;
    }
  }
  return Object.keys(errors).length ? { errors } : { profile };
}

/** A stored profile, read leniently: anything malformed is left at its default. */
export function parseProfile(stored: unknown): ChatProfile {
  const checked = validateProfile(stored);
  if ("profile" in checked) return checked.profile;
  // Drop the bad fields one by one rather than the whole profile.
  const raw = { ...(stored as Record<string, unknown>) };
  for (const key of Object.keys(checked.errors)) delete raw[key.split(".")[0]!];
  const retry = validateProfile(raw);
  return "profile" in retry ? retry.profile : {};
}

/** The chat's mode, else CHAT_DEFAULT_MODE; an environment value that isn't a mode counts as "normal". */
export function replyMode(p: ChatProfile): ReplyMode {
  if (p.mode) return p.mode;
  const fallback = config.chats.defaultMode;
  return isReplyMode(fallback) ? fallback : "normal";
}

/** Seconds between ambient samples in this chat; 0 = never chime in. */
export function ambientInterval(p: ChatProfile): number {
  if (replyMode(p) !== "normal") return 0;
  return p.ambientIntervalSeconds ?? config.agent.ambientIntervalSeconds;
}

// ── Reading and writing, cached per instance ──

const CACHE_MS = 30_000;
const cache = new Map<string, { profile: ChatProfile; at: number }>();
let warned = false;

export async function chatProfile(chat: string, store: ProfileStore = getStore()): Promise<ChatProfile> {
  const hit = cache.get(chat);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.profile;
  let profile: ChatProfile = {};
  try {
    profile = parseProfile((await store.getProfile(chat)) ?? {});
  } catch (err) {
    if (!(err instanceof SchemaOutdatedError)) throw err;
    if (!warned) console.warn("[profile] the database has no chat profiles yet; every chat uses the defaults");
    warned = true;
  }
  cache.set(chat, { profile, at: Date.now() });
  return profile;
}

/** Save a validated profile (an empty one deletes it). */
export async function saveChatProfile(chat: string, profile: ChatProfile, store: ProfileStore = getStore()): Promise<void> {
  await store.putProfile(chat, Object.keys(profile).length ? (profile as Record<string, unknown>) : null);
  cache.set(chat, { profile, at: Date.now() });
}
