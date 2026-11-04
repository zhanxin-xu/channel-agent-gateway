import { activeTools } from "../src/agent/tools.js";
import { channels } from "../src/channels/index.js";
import { config } from "../src/config.js";

function extraBodyStatus(): string {
  try {
    const keys = Object.keys(config.openrouter.extraBody);
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
      model: config.openrouter.model,
      baseUrl: config.openrouter.baseUrl,
      apiKey: Boolean(config.openrouter.apiKey),
      extraBody: extraBodyStatus(),
      reasoningEffort: config.openrouter.reasoningEffort || "default",
      tools: activeTools().map((t) => t.name),
      store: config.store.url ? "upstash" : "memory",
      memory: Boolean(config.memory.url && config.memory.token),
      sandbox: config.sandbox.enabled,
      channels: Object.fromEntries([...channels.values()].map((c) => [c.name, c.isConfigured()])),
    });
  },
};
