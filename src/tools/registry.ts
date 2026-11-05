/**
 * Every tool the agent can call. Add one by writing a `Tool` (types.ts) in
 * its own module and listing it here: a JSON-schema definition the model
 * sees, and a `run` function that returns a string.
 */
import { llmKeyLimit, searchBalance } from "./account.js";
import { chatMembers, endTurn, sendMessage, sendSticker } from "./chat.js";
import { generateImage } from "./image.js";
import { forget, recall, remember } from "./memory.js";
import { bash, readFile, saveAttachment, sendFile, writeFile } from "./sandbox/tools.js";
import type { Tool, ToolContext, ToolRole } from "./types.js";
import { calculate, getCurrentTime } from "./utility.js";
import { sendVoice } from "./voice.js";
import { webFetch, webSearch } from "./web.js";

const tools: Tool[] = [
  sendMessage,
  sendSticker,
  sendVoice,
  endTurn,
  chatMembers,
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
  saveAttachment,
  generateImage,
];

export function activeTools(): Tool[] {
  return tools.filter((t) => t.enabled?.() ?? true);
}

/** Names of the active tools with one of these roles. */
export function toolNames(...roles: ToolRole[]): Set<string> {
  return new Set(activeTools().filter((t) => t.role && roles.includes(t.role)).map((t) => t.name));
}

/** The active "say" tool: what the last step of a turn must call. */
export function sayTool(): string {
  const [name] = toolNames("say");
  if (!name) throw new Error('no active tool has role "say"');
  return name;
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
