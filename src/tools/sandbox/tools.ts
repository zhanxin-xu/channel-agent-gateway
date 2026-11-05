import path from "node:path";
/** The workspace tools: bash, read_file, write_file, send_file, save_attachment. */
import type { Attachment } from "../../channels/types.js";
import { config } from "../../config.js";
import { messageLabel } from "../../conversation/events.js";
import type { ImagePart } from "../../media/images.js";
import { QUOTE, REPLY_TO, replyTo, sendOptions } from "../chat.js";
import type { Tool, ToolContext } from "../types.js";
import { WORKDIR, workspaceFor } from "./workspace.js";

const MAX_OUTPUT_CHARS = 8_000;
const MAX_TEXT_CHARS = 12_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** QQ's direct (non-chunked) upload limit; also plenty for chat. */
const MAX_SEND_BYTES = 5 * 1024 * 1024;
/** `timeout -k` sends KILL this long after TERM; the command's limit leaves room for it. */
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

/** A command's time limit: the configured one, cut to the run's time budget (and the kill grace). */
export function commandLimitSeconds(ctx: ToolContext): number {
  const left = Math.floor(ctx.callBudgetMs() / 1000) - KILL_GRACE_SECONDS;
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
    if (limit < 5) throw new Error("no time left in this function to run commands; the turn continues in a fresh function, run it again there");
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

/** Where save_attachment puts originals. */
const INBOX = `${WORKDIR}/inbox`;
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  voice: ".silk",
};

/** Single-quote a string for bash. */
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** A safe file name for attachment `i` of message `seq`: "{seq}-{name}", the name kept readable. */
export function attachmentFileName(seq: number, i: number, a: Attachment): string {
  let name = path.posix.basename(a.name.replace(/\\/g, "/")).replace(/[^\p{L}\p{N}._ -]+/gu, "_").replace(/^[.\s]+/, "").trim();
  if (!name) name = `attachment-${i + 1}${EXTENSIONS[a.contentType] ?? ""}`;
  if (name.length > 120) {
    const ext = path.posix.extname(name).slice(0, 12);
    name = name.slice(0, 120 - ext.length) + ext;
  }
  return `${seq}-${name}`;
}

/**
 * Download into the workspace. curl inside the sandbox streams straight to the
 * drive (no size limit, nothing held in the function's memory); if the sandbox
 * can't reach the platform's CDN, the function downloads it and writes it in.
 */
async function download(ctx: ToolContext, a: Attachment, file: string): Promise<number> {
  const ws = await workspaceFor(ctx);
  const limit = commandLimitSeconds(ctx);
  const errors: string[] = [];
  if (limit >= 5) {
    const { exitCode, output } = await ws.run(
      `mkdir -p ${shellQuote(INBOX)} && curl -fsSL --retry 2 -o ${shellQuote(file)} ${shellQuote(a.url)} && stat -c %s ${shellQuote(file)}`,
      limit,
    );
    const size = Number(output.trim().split("\n").at(-1));
    if (exitCode === 0 && Number.isFinite(size)) return size;
    errors.push(`sandbox: ${exitCode === 124 ? "timed out" : output.trim().split("\n").at(-1) || `exit ${exitCode}`}`);
  }
  try {
    const left = ctx.callBudgetMs();
    if (left < 5_000) throw new Error("no time left in this function");
    const res = await fetch(a.url, { signal: AbortSignal.timeout(Math.min(left, 290_000)) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    await ws.write(file, bytes);
    return bytes.byteLength;
  } catch (err) {
    errors.push(`direct: ${err instanceof Error ? err.message : String(err)}`);
  }
  throw new Error(errors.join("; "));
}

export const saveAttachment: Tool = {
  name: "save_attachment",
  description:
    "Save the original of an image or file someone sent (a picture in their message, or [文件：…] / [视频] / [语音]) " +
    `into your workspace, under ${INBOX}/. Use it whenever you need the actual file: to edit a photo, read a document, ` +
    "convert or analyze it. The pictures you see in the chat are small previews; this gets the full original, any size. " +
    "It also works when a picture didn't load for you (（有图片没加载出来）): save it, then look at it with read_file, " +
    "instead of asking them to send it again. " +
    "Then work on it with bash (python3, Pillow, ffmpeg via pip, …), look at images with read_file, and send results with send_file. " +
    "Platform links expire after a while, so for an old message it may fail: then ask them to send it again.",
  parameters: {
    type: "object",
    properties: {
      message: { type: "integer", description: "The N of the 第N条 label of the message that has the attachment." },
      index: { type: "integer", description: "Which attachment, 1-based, in the order they were sent. Default: all of them." },
    },
    required: ["message"],
  },
  enabled,
  async run(args, ctx) {
    const seq = Number(args.message);
    const all = Number.isInteger(seq) ? ctx.attachments(seq) : undefined;
    if (!all) throw new Error(`${Number.isInteger(seq) ? messageLabel(seq) : String(args.message)} isn't a message in this chat; message takes the N of a 第N条 label`);
    if (!all.length) throw new Error(`${messageLabel(seq)} has no attachments that can be saved`);
    const index = args.index === undefined || args.index === null ? undefined : Number(args.index);
    if (index !== undefined && !(Number.isInteger(index) && index >= 1 && index <= all.length)) {
      throw new Error(`${messageLabel(seq)} has ${all.length} attachment(s); index is 1 to ${all.length}`);
    }
    const picked = index === undefined ? all.map((a, i) => ({ a, i })) : [{ a: all[index - 1]!, i: index - 1 }];

    const lines: string[] = [];
    for (const { a, i } of picked) {
      const file = `${INBOX}/${attachmentFileName(seq, i, a)}`;
      try {
        const size = await download(ctx, a, file);
        lines.push(`saved ${file} (${size} bytes${a.contentType ? `, ${a.contentType}` : ""})`);
      } catch (err) {
        lines.push(`could not save attachment ${i + 1}: ${err instanceof Error ? err.message : String(err)} (the link may have expired; ask them to send it again)`);
      }
    }
    if (lines.every((l) => l.startsWith("could not"))) throw new Error(lines.join("\n"));
    return lines.join("\n");
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
    properties: { path: { type: "string", description: `File path (relative paths are under ${WORKDIR}).` }, reply_to: REPLY_TO, quote: QUOTE },
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
    const status = await ctx.send({ kind: "file", file: { name: path.posix.basename(file), data } }, replyTo(args), sendOptions(args));
    return `${status}. If you're done, call end_turn (in the same step as your last message).`;
  },
};
