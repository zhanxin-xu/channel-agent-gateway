/** Reading and changing the settings (src/settings). */
import crypto from "node:crypto";
import { settingDef } from "../../settings/catalog.js";
import { describeSettings, saveSettings, SettingsError } from "../../settings/service.js";
import { field, HttpError, type Route } from "../http.js";

/** Secrets the console can make up itself. */
const GENERATED = new Set(["HTTP_CHANNEL_TOKEN", "WORKER_SECRET", "TELEGRAM_WEBHOOK_SECRET"]);

/** Turn a settings validation error into a 400 naming each field. */
async function checked<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SettingsError) throw new HttpError(400, "有设置没填对", err.errors);
    throw err;
  }
}

export const settingsRoutes: Route[] = [
  { method: "GET", path: "settings", handler: () => describeSettings() },
  {
    method: "PUT",
    path: "settings",
    async handler(req) {
      const { changes } = await req.json<{ changes?: unknown }>();
      if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new HttpError(400, "changes 要是一个对象");
      for (const value of Object.values(changes)) {
        if (value !== null && typeof value !== "string") throw new HttpError(400, "每个设置的值要是字符串或 null");
      }
      const saved = await checked(() => saveSettings(changes as Record<string, string | null>));
      return { saved };
    },
  },
  {
    method: "POST",
    path: "settings/generate",
    async handler(req) {
      const key = field(await req.json(), "key");
      if (!GENERATED.has(key) || settingDef(key)?.kind !== "secret") throw new HttpError(400, `${key} 不能自动生成`);
      const value = crypto.randomBytes(24).toString("base64url");
      await checked(() => saveSettings({ [key]: value }));
      // Shown once, so it can be copied to whoever calls the HTTP channel.
      return { saved: [key], value };
    },
  },
];
