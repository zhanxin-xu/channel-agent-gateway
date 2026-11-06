/**
 * Settings kept in the database (gateway.settings), set from the admin
 * console. Each request calls refreshSettings() first; an instance re-reads
 * the table at most every RELOAD_MS, so a change reaches every instance within
 * that time without a redeploy.
 *
 * Until the database has the admin schema, nothing is overridden and the
 * gateway runs on its environment variables, as before.
 */
import { config } from "../config.js";
import { getStore, SchemaOutdatedError, type SettingsStore, type StoredSetting } from "../store/index.js";
import { SETTING_GROUPS, SETTINGS, settingDef, validateSetting, type SettingDef } from "./catalog.js";
import { setOverrides } from "./overrides.js";
import { decryptSecret, encryptSecret, maskSecret, SecretKeyError } from "./secrets.js";

export const RELOAD_MS = 30_000;

let loadedAt = -Infinity;
let loading: Promise<void> | undefined;
/** Keys whose stored secret can't be decrypted with the current ADMIN_PASSWORD. */
let undecryptable = new Set<string>();
let warned = "";

function warnOnce(message: string) {
  if (message === warned) return;
  warned = message;
  console.warn(`[settings] ${message}`);
}

/** Decrypt what was stored; returns the usable values and the keys that couldn't be read. */
function decode(rows: StoredSetting[], password: string): { values: Map<string, string>; failed: Set<string> } {
  const values = new Map<string, string>();
  const failed = new Set<string>();
  for (const row of rows) {
    if (!settingDef(row.key)) continue;
    if (!row.secret) {
      values.set(row.key, row.value);
      continue;
    }
    try {
      values.set(row.key, decryptSecret(row.value, password));
    } catch (err) {
      if (!(err instanceof SecretKeyError)) throw err;
      failed.add(row.key);
    }
  }
  return { values, failed };
}

async function load(store: SettingsStore): Promise<StoredSetting[]> {
  try {
    const rows = await store.listSettings();
    const { values, failed } = decode(rows, config.admin.password);
    setOverrides(values);
    undecryptable = failed;
    if (failed.size) warnOnce(`${failed.size} secret(s) were encrypted under another ADMIN_PASSWORD; using the environment for them`);
    return rows;
  } catch (err) {
    if (err instanceof SchemaOutdatedError) {
      setOverrides(new Map());
      warnOnce("the database has no settings table yet; using environment variables only");
      return [];
    }
    // The database is unreachable: keep what this instance last loaded.
    warnOnce(`couldn't load settings, keeping the last ones: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/** Load the console's settings into config, unless this instance did within RELOAD_MS. */
export async function refreshSettings(opts: { force?: boolean } = {}): Promise<void> {
  if (!opts.force && Date.now() - loadedAt < RELOAD_MS) return;
  loading ??= load(getStore())
    .then(() => void (loadedAt = Date.now()))
    .finally(() => (loading = undefined));
  await loading;
}

// ── For the admin console ──

export type SettingSource = "db" | "env" | "default";

export interface SettingView {
  key: string;
  source: SettingSource;
  /** The value in effect; for secrets only a masked preview. */
  value: string;
  updatedAt?: number;
  /** Stored, but encrypted under another ADMIN_PASSWORD. */
  undecryptable?: boolean;
}

function envValue(def: SettingDef): string {
  const legacy = def.key.startsWith("OPENAI_RESPONSES_") ? process.env[def.key.replace("OPENAI_RESPONSES_", "OPENROUTER_")] : undefined;
  return (process.env[def.key] ?? legacy ?? "").trim();
}

/** Every setting with where its value comes from. Reads the table now, so it is current. */
export async function describeSettings(): Promise<{ groups: typeof SETTING_GROUPS; settings: typeof SETTINGS; values: SettingView[] }> {
  const rows = await load(getStore());
  loadedAt = Date.now();
  const stored = new Map(rows.map((r) => [r.key, r]));
  const { values: decoded } = decode(rows, config.admin.password);
  const values = SETTINGS.map((def): SettingView => {
    const row = stored.get(def.key);
    const dbValue = decoded.get(def.key);
    const fromEnv = envValue(def);
    const source: SettingSource = dbValue !== undefined ? "db" : fromEnv ? "env" : "default";
    const value = dbValue ?? (fromEnv || def.default || "");
    return {
      key: def.key,
      source,
      value: def.kind === "secret" && value ? maskSecret(value) : value,
      ...(row ? { updatedAt: row.updatedAt } : {}),
      ...(row && undecryptable.has(def.key) ? { undecryptable: true } : {}),
    };
  });
  return { groups: SETTING_GROUPS, settings: SETTINGS, values };
}

export class SettingsError extends Error {
  constructor(readonly errors: Record<string, string>) {
    super(Object.entries(errors).map(([k, e]) => `${k}: ${e}`).join("; "));
    this.name = "SettingsError";
  }
}

/**
 * Save values typed in the console. An empty string or null clears a key
 * (back to the environment or the default). Throws SettingsError, naming each
 * bad field, without saving anything.
 */
export async function saveSettings(changes: Record<string, string | null>, action = "settings"): Promise<string[]> {
  const password = config.admin.password;
  const errors: Record<string, string> = {};
  const entries: Array<{ key: string; value: string | null; secret: boolean }> = [];
  for (const [key, input] of Object.entries(changes)) {
    const def = settingDef(key);
    if (!def) {
      errors[key] = "不认识的设置";
      continue;
    }
    const checked = validateSetting(def, input ?? "");
    if ("error" in checked) {
      errors[key] = checked.error;
      continue;
    }
    const secret = def.kind === "secret";
    if (secret && checked.value && !password) {
      errors[key] = "没有设置 ADMIN_PASSWORD，不能保存密钥";
      continue;
    }
    entries.push({ key, value: checked.value ? (secret ? encryptSecret(checked.value, password) : checked.value) : null, secret });
  }
  if (Object.keys(errors).length) throw new SettingsError(errors);
  if (!entries.length) return [];
  const store = getStore();
  await store.putSettings(entries);
  const keys = entries.map((e) => e.key);
  await store.log(action, null, { keys });
  await refreshSettings({ force: true });
  return keys;
}

/** Settings that come from the environment now and aren't in the database. */
export function envOnlySettings(): string[] {
  return SETTINGS.filter((def) => envValue(def) !== "").map((d) => d.key);
}

/** Copy every setting the environment provides into the database (keys already there are skipped). */
export async function importEnv(): Promise<string[]> {
  const stored = new Set((await getStore().listSettings()).map((r) => r.key));
  const changes: Record<string, string> = {};
  for (const def of SETTINGS) {
    const value = envValue(def);
    if (value && !stored.has(def.key)) changes[def.key] = value;
  }
  return saveSettings(changes, "import-env");
}

/**
 * After ADMIN_PASSWORD changed: re-encrypt the stored secrets made under the
 * old one. Returns how many were re-encrypted; throws if `oldPassword` opens none.
 */
export async function rekeySecrets(oldPassword: string): Promise<number> {
  const password = config.admin.password;
  const store = getStore();
  const rows = (await store.listSettings()).filter((r) => r.secret);
  const entries: Array<{ key: string; value: string; secret: boolean }> = [];
  for (const row of rows) {
    try {
      decryptSecret(row.value, password);
      continue; // already under the current password
    } catch {
      // try the old one below
    }
    try {
      entries.push({ key: row.key, value: encryptSecret(decryptSecret(row.value, oldPassword), password), secret: true });
    } catch (err) {
      if (!(err instanceof SecretKeyError)) throw err;
    }
  }
  if (!entries.length) throw new SettingsError({ oldPassword: "旧密码解不开任何一个密钥" });
  await store.putSettings(entries);
  await store.log("rekey", null, { keys: entries.map((e) => e.key) });
  await refreshSettings({ force: true });
  return entries.length;
}
