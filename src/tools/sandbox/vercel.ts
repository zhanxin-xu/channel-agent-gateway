/** The workspace on Vercel Sandbox, with the chat's Drive mounted at WORKDIR. */
import crypto from "node:crypto";
import path from "node:path";
import { config } from "../../config.js";
import { WORKDIR, type Workspace } from "./workspace.js";

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
/** Drive names are unique per Vercel project; hash the chat key into a safe one. */
export const driveName = (chatKey: string) =>
  `chat-${crypto.createHash("sha256").update(chatKey).digest("hex").slice(0, 20)}`;

export async function openVercelWorkspace(chatKey: string): Promise<Workspace> {
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
