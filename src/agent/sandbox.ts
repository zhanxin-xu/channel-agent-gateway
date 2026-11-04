/**
 * A per-chat workspace on Vercel Sandbox: bash / read_file / write_file.
 *
 * Each chat has its own Vercel Drive (persistent storage), mounted at
 * /workspace in a sandbox that lives for one agent run: created on the first
 * workspace tool call, stopped when the run ends. Files under /workspace
 * survive; everything else (/tmp, system packages) is gone next time.
 * `persistent: false` keeps the sandbox from snapshotting itself on stop, so
 * only the drive uses storage.
 *
 * `pip install` and `npm install -g` go to the drive too (PACKAGE_ENV), so
 * each chat keeps its own dependencies between turns.
 *
 * A drive can be mounted read-write by one sandbox at a time, so two runs in
 * the same chat at once wait for each other (see openVercelWorkspace).
 */
import crypto from "node:crypto";
import path from "node:path";
import { config } from "../config.js";
import type { ImagePart } from "./images.js";
import { REPLY_TO, replyTo } from "./limits.js";
import type { Tool, ToolContext } from "./tools.js";

export const WORKDIR = "/workspace";
const MAX_OUTPUT_CHARS = 8_000;
const MAX_TEXT_CHARS = 12_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** QQ's direct (non-chunked) upload limit; also plenty for chat. */
const MAX_SEND_BYTES = 5 * 1024 * 1024;
/** Time left for the model to reply after a command, and for `timeout -k` to kill it. */
const REPLY_RESERVE_MS = 15_000;
const KILL_GRACE_SECONDS = 5;
/**
 * Send pip (user installs) and npm globals to the chat's drive. Python finds
 * user site-packages under PYTHONUSERBASE by itself; their executables are
 * put on PATH in run().
 */
const PACKAGE_ENV = {
  PYTHONUSERBASE: `${WORKDIR}/.local`,
  PIP_USER: "1",
  NPM_CONFIG_PREFIX: `${WORKDIR}/.npm-global`,
};
const PACKAGE_PATH = `${WORKDIR}/.local/bin:${WORKDIR}/.npm-global/bin`;
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export interface Workspace {
  /** Run a bash command in WORKDIR; output is stdout and stderr combined. */
  run(command: string, timeoutSeconds: number): Promise<{ exitCode: number | null; output: string }>;
  write(file: string, content: string): Promise<void>;
  /** null when the file doesn't exist. */
  read(file: string): Promise<Buffer | null>;
  close(): Promise<void>;
}

export type WorkspaceFactory = (chatKey: string) => Promise<Workspace>;

/** Drive names are unique per Vercel project; hash the chat key into a safe one. */
export const driveName = (chatKey: string) =>
  `chat-${crypto.createHash("sha256").update(chatKey).digest("hex").slice(0, 20)}`;

async function openVercelWorkspace(chatKey: string): Promise<Workspace> {
  // Loaded on first use so runs that never touch the workspace don't pay for it.
  const { Drive, Sandbox } = await import("@vercel/sandbox");
  const region = (config.sandbox.region || undefined) as Parameters<typeof Drive.getOrCreate>[0]["region"];
  const drive = await Drive.getOrCreate({ name: driveName(chatKey), region });

  // The drive may still be mounted by another run in this chat: retry briefly.
  let sandbox: Awaited<ReturnType<typeof Sandbox.create>> | undefined;
  for (let attempt = 1; !sandbox; attempt++) {
    try {
      sandbox = await Sandbox.create({
        mounts: { [WORKDIR]: drive },
        region,
        persistent: false,
        env: PACKAGE_ENV,
        timeout: 5 * 60 * 1000, // backstop if stop() never runs; a function lives at most 300s
      });
    } catch (err) {
      if (attempt >= 3) throw err;
      console.warn(`[sandbox] create failed (attempt ${attempt}), retrying: ${err instanceof Error ? err.message : err}`);
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
  const box = sandbox;
  console.log(`[sandbox] ${box.name} started with drive ${drive.name}`);

  return {
    async run(command, timeoutSeconds) {
      // `timeout` kills the command inside the VM and keeps what it printed (exit 124).
      const result = await box.runCommand({
        cmd: "timeout",
        args: ["-k", "5", String(timeoutSeconds), "bash", "-c", `export PATH="${PACKAGE_PATH}:$PATH"\n${command}`],
        cwd: WORKDIR,
        signal: AbortSignal.timeout((timeoutSeconds + 15) * 1000),
      });
      return { exitCode: result.exitCode, output: await result.output("both") };
    },
    async write(file, content) {
      await box.runCommand("mkdir", ["-p", path.posix.dirname(file)]);
      await box.writeFiles([{ path: file, content }]);
    },
    read: (file) => box.readFileToBuffer({ path: file }),
    async close() {
      await box.stop();
      console.log(`[sandbox] ${box.name} stopped`);
    },
  };
}

let factory: WorkspaceFactory = openVercelWorkspace;

/** Tests swap in a fake workspace. */
export function setWorkspaceFactory(f: WorkspaceFactory) {
  factory = f;
}

const open = new WeakMap<ToolContext, Promise<Workspace>>();

function workspaceFor(ctx: ToolContext): Promise<Workspace> {
  let ws = open.get(ctx);
  if (!ws) {
    ws = factory(ctx.chat.key);
    open.set(ctx, ws);
    ws.catch(() => open.delete(ctx)); // let a later call try again
  }
  return ws;
}

/** Stop the run's sandbox, if one was started. Call once the agent run is over. */
export async function closeWorkspace(ctx: ToolContext): Promise<void> {
  const ws = open.get(ctx);
  if (!ws) return;
  open.delete(ctx);
  try {
    await (await ws).close();
  } catch (err) {
    console.warn(`[sandbox] close failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

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
    const status = await ctx.sendFile({ name: path.posix.basename(file), data }, replyTo(args));
    return `${status}. If you're done, call end_turn (in the same step as your last message).`;
  },
};
