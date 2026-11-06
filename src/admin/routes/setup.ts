/**
 * The setup guide's checks and actions: what's configured, creating the
 * database, and testing each service with the settings in effect.
 */
import { createResponse, outputText } from "../../agent/model.js";
import { channels } from "../../channels/index.js";
import { utcDay } from "../../chats/day.js";
import { config } from "../../config.js";
import { describeSettings, saveSettings } from "../../settings/service.js";
import { getStore, SCHEMA_VERSION, storeBackend } from "../../store/index.js";
import { searchBalanceReport } from "../../tools/account.js";
import { applySchema, connectionVar, readSchema } from "../database.js";
import { HttpError, type Route } from "../http.js";

async function databaseStatus() {
  const backend = storeBackend();
  const schemaVersion = backend === "supabase" ? await getStore().schemaVersion() : SCHEMA_VERSION;
  return { backend, schemaVersion, expected: SCHEMA_VERSION, ready: schemaVersion === SCHEMA_VERSION, connectionVar: connectionVar() ?? null };
}

/** Run a check, timing it; a failure is a result to show, not an error. */
async function attempt(fn: () => Promise<string>): Promise<{ ok: boolean; message: string; ms: number }> {
  const started = Date.now();
  try {
    return { ok: true, message: await fn(), ms: Date.now() - started };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err), ms: Date.now() - started };
  }
}

function adapterFor(name: string) {
  const adapter = channels.get(name);
  if (!adapter) throw new HttpError(404, `没有 ${name} 渠道`);
  return adapter;
}

export const setupRoutes: Route[] = [
  {
    method: "GET",
    path: "status",
    async handler(req) {
      const database = await databaseStatus();
      const { values } = database.ready ? await describeSettings() : { values: [] };
      const chats = database.ready ? await getStore().chats(utcDay()) : [];
      return {
        origin: req.origin,
        database,
        model: Boolean(config.llm.apiKey),
        channels: [...channels.values()].map((c) => ({
          name: c.name,
          configured: c.isConfigured(),
          webhook: `${req.origin}/api/webhook/${c.name}`,
          canVerify: Boolean(c.verify),
          canConnect: Boolean(c.connect),
        })),
        features: {
          image: Boolean(config.image.apiKey),
          tts: Boolean(config.tts.apiKey),
          search: Boolean(config.deepseek.apiKey),
          memory: Boolean(config.memory.url && config.memory.token),
          sandbox: config.sandbox.enabled,
        },
        firstMessage: chats.length > 0,
        /** Settings still read from the environment: can be imported. */
        envOnly: values.filter((v) => v.source === "env").map((v) => v.key),
        undecryptable: values.filter((v) => v.undecryptable).map((v) => v.key),
      };
    },
  },
  { method: "GET", path: "setup/schema", handler: async () => ({ sql: await readSchema() }) },
  {
    method: "POST",
    path: "setup/database",
    async handler() {
      if (storeBackend() !== "supabase") throw new HttpError(409, "还没有连接 Supabase：先在 Vercel 的 Storage 页面添加，再重新部署");
      try {
        await applySchema();
      } catch (err) {
        throw new HttpError(502, `执行 schema.sql 失败：${err instanceof Error ? err.message : String(err)}`);
      }
      await getStore().log("schema", null, { version: SCHEMA_VERSION });
      return databaseStatus();
    },
  },
  {
    method: "POST",
    path: "checks/model",
    handler: () =>
      attempt(async () => {
        if (!config.llm.apiKey) throw new Error("还没填 API Key");
        const response = await createResponse(
          { model: config.llm.model, ...config.llm.extraBody, instructions: "用不超过十个字打个招呼。", input: "你好" },
          { timeoutMs: 60_000 },
        );
        return `${config.llm.model} 回复：${outputText(response.output ?? []).trim() || "（空）"}`;
      }),
  },
  {
    method: "POST",
    path: "checks/search",
    handler: () =>
      attempt(async () => {
        if (!config.deepseek.apiKey) throw new Error("还没填 DeepSeek API Key");
        const report = await searchBalanceReport();
        return report.balances.map((b) => `余额 ${b.total} ${b.currency}`).join("，") || "账户可用";
      }),
  },
  {
    method: "POST",
    path: "channels/:name/verify",
    handler: (_req, { name }) =>
      attempt(async () => {
        const adapter = adapterFor(name!);
        if (adapter.verify) return adapter.verify();
        if (!adapter.isConfigured()) throw new Error("还没填完凭据");
        return "已配置";
      }),
  },
  {
    method: "POST",
    path: "channels/:name/connect",
    async handler(req, { name }) {
      const adapter = adapterFor(name!);
      if (!adapter.connect) throw new HttpError(400, `${name} 不需要自动设置`);
      return attempt(async () => {
        const { message, settings } = await adapter.connect!(req.origin);
        if (settings) await saveSettings(settings, `connect-${name}`);
        return message;
      });
    },
  },
];
