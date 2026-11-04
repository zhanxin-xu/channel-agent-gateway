/**
 * A per-chat workspace: the interface the sandbox tools use, and its
 * lifetime (one per agent run). The Vercel implementation is in vercel.ts.
 *
 * Each chat has its own Vercel Drive (persistent storage), mounted at
 * /workspace in a sandbox that lives for one agent run: created on the first
 * workspace tool call, stopped when the run ends. Files under /workspace
 * survive; everything else (/tmp, system packages) is gone next time.
 * `persistent: false` keeps the sandbox from snapshotting itself on stop, so
 * only the drive uses storage.
 *
 * `pip install` and `npm install -g` go to the drive too (PACKAGE_ENV in vercel.ts), so
 * each chat keeps its own dependencies between turns.
 *
 * A drive can be mounted read-write by one sandbox at a time, so two runs in
 * the same chat at once wait for each other (see openVercelWorkspace).
 */
import type { ToolContext } from "../types.js";

export const WORKDIR = "/workspace";

export interface Workspace {
  /** Run a bash command in WORKDIR; output is stdout and stderr combined. */
  run(command: string, timeoutSeconds: number): Promise<{ exitCode: number | null; output: string }>;
  /** Create or overwrite a file (parent folders are created). */
  write(file: string, content: string | Uint8Array): Promise<void>;
  /** null when the file doesn't exist. */
  read(file: string): Promise<Buffer | null>;
  close(): Promise<void>;
}

export type WorkspaceFactory = (chatKey: string) => Promise<Workspace>;

let factory: WorkspaceFactory | undefined;

/** Tests swap in a fake workspace. */
export function setWorkspaceFactory(f: WorkspaceFactory) {
  factory = f;
}

const open = new WeakMap<ToolContext, Promise<Workspace>>();

export function workspaceFor(ctx: ToolContext): Promise<Workspace> {
  let ws = open.get(ctx);
  if (!ws) {
    // The Vercel implementation is loaded on first use.
    ws = (factory ? Promise.resolve(factory) : import("./vercel.js").then((m) => m.openVercelWorkspace)).then((f) =>
      f(ctx.chat.key),
    );
    open.set(ctx, ws);
    ws.catch(() => open.delete(ctx)); // let a later call try again
    ctx.onRunEnd(() => closeWorkspace(ctx));
  }
  return ws;
}

/** Stop the run's sandbox, if one was started (registered with ctx.onRunEnd when it starts). */
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
