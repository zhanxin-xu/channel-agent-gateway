import path from "node:path";
/** The workspace tools: bash, read_file, write_file, send_file. */
import { config } from "../../config.js";
import type { ImagePart } from "../../media/images.js";
import { REPLY_TO, replyTo } from "../chat.js";
import type { Tool, ToolContext } from "../types.js";
import { WORKDIR, workspaceFor } from "./workspace.js";

const MAX_OUTPUT_CHARS = 8_000;
const MAX_TEXT_CHARS = 12_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** QQ's direct (non-chunked) upload limit; also plenty for chat. */
const MAX_SEND_BYTES = 5 * 1024 * 1024;
/** Time left for the model to reply after a command, and for `timeout -k` to kill it. */
const REPLY_RESERVE_MS = 15_000;
const KILL_GRACE_SECONDS = 5;
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Relative paths are under WORKDIR. */
const resolvePath = (file: string) => path.posix.resolve(WORKDIR, file);

/** Keep the start and the end of long output; the end usually has the error. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.3);
  return `${text.slice(0, head)}\n…[${text.length - max} characters cut]…\n${text.slice(text.length - (max - head))}`;
}

/**
 * A command's time limit: the configured one, cut short near the function's
 * deadline so the model still has REPLY_RESERVE_MS to answer afterwards.
 */
export function commandLimitSeconds(ctx: ToolContext): number {
  const left = Math.floor((ctx.deadline - Date.now() - REPLY_RESERVE_MS) / 1000) - KILL_GRACE_SECONDS;
  return Math.min(config.sandbox.commandTimeoutSeconds, left);
}

const enabled = () => config.sandbox.enabled;

const WORKSPACE_NOTE =
  `Your workspace is a Linux sandbox (bash, python3, node, curl, git, internet). ${WORKDIR} is this chat's ` +
  "own folder and is kept between turns; everything outside it (/tmp, system packages) is wiped after each turn. " +
  "`pip install` and `npm install -g` install into it, so packages stay installed for this chat.";

export const bash: Tool = {
  name: "bash",
  description:
    `Run a bash command in your workspace (working directory ${WORKDIR}). ${WORKSPACE_NOTE} ` +
    "Each command is killed after a time limit (60s by default, shorter when this turn is running out of time); " +
    "output is stdout+stderr, clipped when long. " +
    "Starting the sandbox takes a few seconds, so batch work into one command where you can.",
  parameters: {
    type: "object",
    properties: { command: { type: "string", description: "The bash command or script." } },
    required: ["command"],
  },
  enabled,
  async run(args, ctx) {
    const command = String(args.command ?? "");
    if (!command.trim()) throw new Error("command is empty");
    const limit = commandLimitSeconds(ctx);
    if (limit < 5) throw new Error("no time left in this turn to run commands; tell them what you have so far");
    const { exitCode, output } = await (await workspaceFor(ctx)).run(command, limit);
    const status = exitCode === 124 ? `timed out after ${limit}s` : `exit ${exitCode ?? "?"}`;
    return `${status}\n${clip(output, MAX_OUTPUT_CHARS) || "(no output)"}`;
  },
};

export const writeFile: Tool = {
  name: "write_file",
  description: `Write a text file in your workspace (relative paths are under ${WORKDIR}; parent folders are created). Overwrites.`,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: `e.g. "notes/todo.md" (= ${WORKDIR}/notes/todo.md)` },
      content: { type: "string", description: "The full file content." },
    },
    required: ["path", "content"],
  },
  enabled,
  async run(args, ctx) {
    const file = resolvePath(String(args.path ?? ""));
    const content = String(args.content ?? "");
    await (await workspaceFor(ctx)).write(file, content);
    return `wrote ${file} (${Buffer.byteLength(content)} bytes)`;
  },
};

export const readFile: Tool = {
  name: "read_file",
  description:
    `Read a file from your workspace (relative paths are under ${WORKDIR}). Text comes back as text; ` +
    "images (png/jpg/gif/webp) are shown to you so you can look at them, e.g. a chart you just plotted.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "File path." } },
    required: ["path"],
  },
  enabled,
  async run(args, ctx) {
    const file = resolvePath(String(args.path ?? ""));
    const bytes = await (await workspaceFor(ctx)).read(file);
    if (!bytes) throw new Error(`${file} not found`);

    const imageType = IMAGE_TYPES[path.posix.extname(file).toLowerCase()];
    if (imageType) {
      if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error(`image too large (${bytes.byteLength} bytes)`);
      const part: ImagePart = { type: "input_image", image_url: `data:${imageType};base64,${bytes.toString("base64")}`, detail: "auto" };
      ctx.images.push(part);
      return `image ${file} (${bytes.byteLength} bytes): it is shown to you right after this.`;
    }
    if (bytes.includes(0)) return `${file} is a binary file (${bytes.byteLength} bytes); inspect it with bash instead.`;
    return clip(bytes.toString("utf8"), MAX_TEXT_CHARS);
  },
};

export const sendFile: Tool = {
  name: "send_file",
  role: "talk",
  description:
    "Send a file from your workspace to the chat, as its own message (it counts as a reply like send_message). " +
    "png/jpg/gif show as pictures, mp4 as video, " +
    "mp3/wav/silk as voice, anything else as a file attachment. At most 5 MB.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: `File path (relative paths are under ${WORKDIR}).` }, reply_to: REPLY_TO },
    required: ["path"],
  },
  enabled,
  async run(args, ctx) {
    const file = resolvePath(String(args.path ?? ""));
    const data = await (await workspaceFor(ctx)).read(file);
    if (!data) throw new Error(`${file} not found`);
    if (data.byteLength > MAX_SEND_BYTES) {
      throw new Error(`${file} is ${data.byteLength} bytes, over the 5 MB limit; compress or split it`);
    }
    const status = await ctx.send({ kind: "file", file: { name: path.posix.basename(file), data } }, replyTo(args));
    return `${status}. If you're done, call end_turn (in the same step as your last message).`;
  },
};
