/** The overview page: spend against the provider limits, today's usage, recent problems; and the admin log. */
import { channels } from "../../channels/index.js";
import { utcDay } from "../../chats/day.js";
import { config } from "../../config.js";
import { getStore, type UsageCounts } from "../../store/index.js";
import { keyReport, searchBalanceReport } from "../../tools/account.js";
import type { Route } from "../http.js";

const DAY_MS = 86_400_000;

/** A report that failed shows its error in place of the numbers. */
const settle = <T>(p: Promise<T>) => p.catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));

function sum(byChat: Record<string, UsageCounts>): UsageCounts {
  const total: UsageCounts = {};
  for (const counts of Object.values(byChat)) for (const [k, v] of Object.entries(counts)) total[k] = (total[k] ?? 0) + v;
  return total;
}

export const overviewRoutes: Route[] = [
  {
    method: "GET",
    path: "overview",
    async handler() {
      const store = getStore();
      const { llm, image } = config;
      const sameKey = Boolean(image.apiKey) && image.apiKey === llm.apiKey;
      const [modelKey, imageKey, search, today, problems] = await Promise.all([
        llm.apiKey ? keyReport(llm.baseUrl, llm.apiKey, llm.extraHeaders) : undefined,
        image.apiKey && !sameKey ? keyReport(image.baseUrl, image.apiKey) : undefined,
        config.deepseek.apiKey ? settle(searchBalanceReport()) : undefined,
        store.usageOfDay(utcDay()),
        store.problems(Date.now() - DAY_MS, 20),
      ]);
      return {
        keys: { model: modelKey ?? null, image: sameKey ? "same" : (imageKey ?? null) },
        search: search ?? null,
        today: { total: sum(today), chats: Object.keys(today).length },
        problems,
        channels: [...channels.values()].map((c) => ({ name: c.name, configured: c.isConfigured() })),
      };
    },
  },
  { method: "GET", path: "admin-log", handler: () => getStore().adminLog(100) },
];
