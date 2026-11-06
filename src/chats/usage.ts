/**
 * Per-chat usage and daily quotas.
 *
 * Usage is read off the event log rather than reported by the agent loop:
 * every model call's `usage` is in its assistant/message (and a compaction's
 * in its summary), every tool call in a tool/call with its tool/result. After
 * a turn the runner adds up the turn's events (turnUsage) and stores them per
 * UTC day (gateway.usage_daily).
 *
 * Quotas are checked against what's stored for today: a turn doesn't start
 * once the cost quota is used up, and a metered tool is refused once its count
 * is (quotaPolicy). The model is told why, so it can say so in its own words.
 */
import { config } from "../config.js";
import { isEvent, type SessionEvent, type Usage } from "../conversation/events.js";
import { getStore, SchemaOutdatedError, type UsageCounts, type UsageStore } from "../store/index.js";
import { toolFeature, type ToolPolicy } from "../tools/registry.js";
import type { ToolFeature } from "../tools/types.js";
import { beijingTime, nextDayStart, utcDay } from "./day.js";
import type { ChatProfile, QuotaKey } from "./profile.js";

/** The counters a tool feature adds to (and whose quota it is under). */
const METERED: Partial<Record<ToolFeature, QuotaKey>> = { image: "images", voice: "voices", search: "searches" };

/** What a call cost: as reported, else estimated from the configured prices. */
function callCost(usage: Usage): number {
  if (typeof usage.cost === "number" && Number.isFinite(usage.cost)) return usage.cost;
  const { input, cached, output } = config.llm.prices;
  const inTokens = usage.input_tokens ?? 0;
  const cachedTokens = Math.min(usage.input_tokens_details?.cached_tokens ?? 0, inTokens);
  return ((inTokens - cachedTokens) * input + cachedTokens * cached + (usage.output_tokens ?? 0) * output) / 1e6;
}

/** What these events (one turn's) used. */
export function turnUsage(events: SessionEvent[]): UsageCounts {
  const counts: UsageCounts = { turns: 0, model_calls: 0, input_tokens: 0, cached_tokens: 0, output_tokens: 0, cost_usd: 0 };
  const add = (usage: Usage | undefined) => {
    if (!usage) return;
    counts.model_calls! += 1;
    counts.input_tokens! += usage.input_tokens ?? 0;
    counts.cached_tokens! += usage.input_tokens_details?.cached_tokens ?? 0;
    counts.output_tokens! += usage.output_tokens ?? 0;
    counts.cost_usd! += callCost(usage);
  };
  const failed = new Set(
    events.filter((e) => isEvent(e, "tool/result") && e.data.output.startsWith("Error:")).map((e) => (e as SessionEvent<"tool/result">).data.callId),
  );
  for (const e of events) {
    if (isEvent(e, "turn/start")) counts.turns! += 1;
    else if (isEvent(e, "assistant/message")) add(e.data.usage);
    else if (isEvent(e, "compaction/summary")) add(e.data.usage);
    else if (isEvent(e, "tool/call") && !failed.has(e.data.callId)) {
      const feature = toolFeature(e.data.name);
      const counter = feature && METERED[feature];
      if (counter) counts[counter] = (counts[counter] ?? 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(counts).filter(([, v]) => v !== 0));
}

let warned = false;
function schemaWarning(err: unknown): void {
  if (!(err instanceof SchemaOutdatedError)) throw err;
  if (!warned) console.warn("[usage] the database has no usage table yet; usage isn't recorded and quotas don't apply");
  warned = true;
}

/** Today's counters of a chat ({} when nothing's recorded, or the table doesn't exist yet). */
export async function usageToday(chat: string, store: UsageStore = getStore()): Promise<UsageCounts> {
  const day = utcDay();
  try {
    return (await store.usage(chat, day, day))[0]?.counts ?? {};
  } catch (err) {
    schemaWarning(err);
    return {};
  }
}

/** Add a turn's usage to today's counters; never fails the turn. */
export async function recordUsage(chat: string, counts: UsageCounts, store: UsageStore = getStore()): Promise<void> {
  if (!Object.keys(counts).length) return;
  try {
    await store.addUsage(chat, utcDay(), counts);
  } catch (err) {
    try {
      schemaWarning(err);
    } catch {
      console.warn(`[usage] couldn't record usage for ${chat}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}


/** True when the chat's cost quota for today is used up. */
export function costQuotaUsed(profile: ChatProfile, today: UsageCounts): boolean {
  const limit = profile.quota?.cost_usd;
  return limit !== undefined && (today.cost_usd ?? 0) >= limit;
}

/**
 * The tool policy for a turn: the chat's disabled features, and metered tools
 * refused once today's count (stored + run so far this turn) reaches the quota.
 */
export function quotaPolicy(profile: ChatProfile, today: UsageCounts): ToolPolicy {
  const used: UsageCounts = { ...today };
  const counterOf = (feature?: ToolFeature) => (feature ? METERED[feature] : undefined);
  return {
    disabled: new Set(profile.disabledTools ?? []),
    refuse(tool) {
      const counter = counterOf(tool.feature);
      const limit = counter ? profile.quota?.[counter] : undefined;
      if (counter && limit !== undefined && (used[counter] ?? 0) >= limit) {
        return `this chat's daily quota for ${tool.name} (${limit}) is used up; it resets at ${beijingTime(nextDayStart())}. Tell them in your own words, don't retry.`;
      }
      return undefined;
    },
    ran(tool) {
      const counter = counterOf(tool.feature);
      if (counter) used[counter] = (used[counter] ?? 0) + 1;
    },
  };
}
