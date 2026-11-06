/**
 * Settings kept in the database (gateway.settings), set from the admin
 * console. Each request calls refreshSettings() first; an instance re-reads
 * the table at most every RELOAD_MS, so a change reaches every instance within
 * that time without a redeploy.
 *
 * Values are stored as typed. The table sits in a private schema with RLS, and
 * only the server key may call its functions; secrets (`secret`) never leave
 * the server whole: the console shows a masked preview only.
 *
 * Until the database has the admin schema, nothing is overridden and the
 * gateway runs on its environment variables, as before.
 */
import { getStore, SchemaOutdatedError, type SettingsStore, type StoredSetting } from "../store/index.js";
import { SETTING_GROUPS, SETTINGS, settingDef, validateSetting, type SettingDef } from "./catalog.js";
import { setOverrides } from "./overrides.js";

export const RELOAD_MS = 30_000;

let loadedAt = -Infinity;
let loading: Promise<void> | undefined;
let warned = "";

function warnOnce(message: string) {
  if (message === warned) return;
  warned = message;
  console.warn(`[settings] ${message}`);
}

/** The stored values of the settings the catalog knows. */
const valuesOf = (rows: StoredSetting[]) => new Map(rows.filter((r) => settingDef(r.key)).map((r) => [r.key, r.value]));

async function load(store: SettingsStore): Promise<StoredSetting[] | undefined> {
  try {
    const rows = await store.listSettings();
    setOverrides(valuesOf(rows));
    return rows;
  } catch (err) {
    if (err instanceof SchemaOutdatedError) {
      setOverrides(new Map());
      warnOnce("the database has no settings table yet; using environment variables only");
      return [];
    }
    // The database is unreachable: keep what this instance last loaded.
    warnOnce(`couldn't load settings, keeping the last ones: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
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
}

/** How a secret is shown: enough to recognize it, not to use it. */
export function maskSecret(plain: string): string {
  return plain.length > 12 ? `${plain.slice(0, 6)}…${plain.slice(-4)}` : "••••••";
}

function envValue(def: SettingDef): string {
  const legacy = def.key.startsWith("OPENAI_RESPONSES_") ? process.env[def.key.replace("OPENAI_RESPONSES_", "OPENROUTER_")] : undefined;
  return (process.env[def.key] ?? legacy ?? "").trim();
}

/** Every setting with where its value comes from. Reads the table now, so it is current. */
export async function describeSettings(): Promise<{ groups: typeof SETTING_GROUPS; settings: typeof SETTINGS; values: SettingView[] }> {
  const rows = await load(getStore());
  if (!rows) throw new Error("读不到数据库里的设置，稍后再试");
  loadedAt = Date.now();
  const stored = new Map(rows.map((r) => [r.key, r]));
  const values = SETTINGS.map((def): SettingView => {
    const row = stored.get(def.key);
    const fromEnv = envValue(def);
    const source: SettingSource = row ? "db" : fromEnv ? "env" : "default";
    const value = row?.value ?? (fromEnv || def.default || "");
    return {
      key: def.key,
      source,
      value: def.kind === "secret" && value ? maskSecret(value) : value,
      ...(row ? { updatedAt: row.updatedAt } : {}),
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
  const errors: Record<string, string> = {};
  const entries: Array<{ key: string; value: string | null; secret: boolean }> = [];
  for (const [key, input] of Object.entries(changes)) {
    const def = settingDef(key);
    if (!def) {
      errors[key] = "不认识的设置";
      continue;
    }
    const checked = validateSetting(def, input ?? "");
    if ("error" in checked) errors[key] = checked.error;
    else entries.push({ key, value: checked.value || null, secret: def.kind === "secret" });
  }
  if (Object.keys(errors).length) throw new SettingsError(errors);
  if (!entries.length) return [];
  const store = getStore();
  await store.putSettings(entries);
  const keys = entries.map((e) => e.key);
  // Names only: the log never holds a secret.
  await store.log(action, null, { keys });
  await refreshSettings({ force: true });
  return keys;
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

const ENV_IMPORTED = "env_imported_at";

/**
 * The first time the console finds the admin schema in place: import what
 * the environment provides, once. After that the console is where settings
 * change (the database wins over the environment), and a key cleared in the
 * console stays cleared. Returns the keys imported ([] when it already ran).
 */
export async function importEnvOnce(): Promise<string[]> {
  const store = getStore();
  if (await store.meta(ENV_IMPORTED)) return [];
  const saved = await importEnv();
  await store.setMeta(ENV_IMPORTED, new Date().toISOString());
  return saved;
}
