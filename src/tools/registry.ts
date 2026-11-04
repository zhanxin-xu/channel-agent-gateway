/**
 * Every tool the agent can call. Add one by writing a `Tool` (types.ts) in
 * its own module and listing it here: a JSON-schema definition the model
 * sees, and a `run` function that returns a string.
 */
import { llmKeyLimit, searchBalance } from "./account.js";
import { endTurn, sendMessage, sendSticker } from "./chat.js";
import { forget, recall, remember } from "./memory.js";
import { bash, readFile, sendFile, writeFile } from "./sandbox/tools.js";
import type { Tool, ToolContext } from "./types.js";
import { calculate, getCurrentTime } from "./utility.js";
import { webFetch, webSearch } from "./web.js";

const tools: Tool[] = [
  sendMessage,
  sendSticker,
  endTurn,
  getCurrentTime,
  calculate,
  webSearch,
  webFetch,
  searchBalance,
  llmKeyLimit,
  remember,
  recall,
  forget,
  bash,
  readFile,
  writeFile,
  sendFile,
];

export function activeTools(): Tool[] {
  return tools.filter((t) => t.enabled?.() ?? true);
}

export async function runTool(name: string, rawArgs: string, ctx: ToolContext): Promise<string> {
  const tool = activeTools().find((t) => t.name === name);
  if (!tool) return `Error: unknown tool "${name}"`;
  try {
    const args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
    return await tool.run(args, ctx);
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
