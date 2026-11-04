import { activeTools } from "../src/tools/registry.js";
import { channels } from "../src/channels/index.js";
import { config } from "../src/config.js";
import { storeBackend } from "../src/store/index.js";

function extraBodyStatus(): string {
  try {
    const keys = Object.keys(config.llm.extraBody);
    return keys.length ? `ok (${keys.join(", ")})` : "none";
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// GET /api/health — what is configured (no secrets exposed).
export default {
  fetch() {
    return Response.json({
      ok: true,
      model: config.llm.model,
      baseUrl: config.llm.baseUrl,
      apiKey: Boolean(config.llm.apiKey),
      extraBody: extraBodyStatus(),
      // Old OPENROUTER_* variables still in use; rename them to OPENAI_RESPONSES_*.
      ...(config.llm.legacyEnv.length ? { legacyEnv: config.llm.legacyEnv } : {}),
      tools: activeTools().map((t) => t.name),
      store: storeBackend(),
      memory: Boolean(config.memory.url && config.memory.token),
      sandbox: config.sandbox.enabled,
      channels: Object.fromEntries([...channels.values()].map((c) => [c.name, c.isConfigured()])),
    });
  },
};
