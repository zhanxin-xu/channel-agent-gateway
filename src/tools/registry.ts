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
import type { Tool, ToolContext, ToolFeature, ToolRole } from "./types.js";
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

/**
 * A chat's rules for its tools (src/chats builds them from the chat's
 * profile and quotas). The registry doesn't know why a tool is refused.
 */
export interface ToolPolicy {
  /** Features turned off: their tools aren't offered at all. */
  disabled?: ReadonlySet<ToolFeature>;
  /** Asked before a tool runs; a message here is returned to the model as the error instead. */
  refuse?(tool: Tool): string | undefined;
  /** Told after a tool ran and didn't fail. */
  ran?(tool: Tool): void;
}

/** The tools one turn offers, after the chat's policy. */
export class Toolset {
  readonly tools: Tool[];

  constructor(private policy: ToolPolicy = {}) {
    this.tools = activeTools().filter((t) => !t.feature || !policy.disabled?.has(t.feature));
  }

  /** The `tools` of a Responses API request. */
  definitions() {
    return this.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters }));
  }

  /** Names of the tools with one of these roles. */
  names(...roles: ToolRole[]): Set<string> {
    return new Set(this.tools.filter((t) => t.role && roles.includes(t.role)).map((t) => t.name));
  }

  /** The "say" tool: what the last step of a turn must call. */
  say(): string {
    const [name] = this.names("say");
    if (!name) throw new Error('no active tool has role "say"');
    return name;
  }

  async run(name: string, rawArgs: string, ctx: ToolContext): Promise<string> {
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) return `Error: unknown tool "${name}"`;
    const refused = this.policy.refuse?.(tool);
    if (refused) return `Error: ${refused}`;
    let output: string;
    try {
      const args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
      output = await tool.run(args, ctx);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (!output.startsWith("Error:")) this.policy.ran?.(tool);
    return output;
  }
}

/** The feature of a tool by name (also of tools that are off right now). */
export const toolFeature = (name: string): ToolFeature | undefined => tools.find((t) => t.name === name)?.feature;

/** How a successful call of tool `name` with these (JSON) arguments read in the chat; undefined for tools that don't deliver. */
export function historyLine(name: string, rawArgs: string): string | undefined {
  const tool = tools.find((t) => t.name === name);
  if (!tool?.historyLine) return undefined;
  try {
    return tool.historyLine(rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {});
  } catch {
    return undefined;
  }
}

/** Every active tool, no chat policy: for health checks, scripts and tests. */
export const runTool = (name: string, rawArgs: string, ctx: ToolContext) => new Toolset().run(name, rawArgs, ctx);
