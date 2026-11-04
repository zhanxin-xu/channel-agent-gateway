/**
 * Live check of the per-chat workspace against real Vercel Sandbox + Drive:
 *   npx vercel env pull && npx tsx scripts/sandbox-smoke.ts
 * Needs VERCEL_OIDC_TOKEN (read from .env.local if present). Uses, then
 * deletes, the drive for the chat key "smoke:test".
 */
import { existsSync } from "node:fs";
import { runTool, type ToolContext } from "../src/agent/tools.js";
import { closeWorkspace, driveName } from "../src/agent/sandbox.js";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
process.env.SANDBOX_ENABLED = "1";
const chat = { key: "smoke:test", scene: "私聊" as const, sender: "#SMOKE" };
const newCtx = (): ToolContext => ({
  sent: [],
  send: async () => {},
  sendSticker: async () => {},
  sendFile: async () => {},
  deadline: Date.now() + 300_000,
  chat,
  images: [],
});
const step = async (ctx: ToolContext, name: string, args: unknown) => {
  const t = Date.now();
  const out = await runTool(name, JSON.stringify(args), ctx);
  console.log(`\n▶ ${name} ${JSON.stringify(args).slice(0, 100)} (${Date.now() - t}ms)\n${out.slice(0, 600)}`);
  return out;
};

const first = newCtx();
await step(first, "bash", { command: "pwd; uname -sm; python3 --version; node --version; df -h /workspace | tail -1; ls -la" });
await step(first, "write_file", { path: "notes/hello.md", content: "你好，大肥鱼\n" });
await step(first, "bash", {
  command:
    "python3 -c \"import zlib,struct;w=h=8;raw=b''.join(b'\\x00'+b'\\xff\\x00\\x00'*w for _ in range(h));" +
    "c=lambda t,d:struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d));" +
    "open('red.png','wb').write(b'\\x89PNG\\r\\n\\x1a\\n'+c(b'IHDR',struct.pack('>IIBBBBB',w,h,8,2,0,0,0))+c(b'IDAT',zlib.compress(raw))+c(b'IEND',b''))\" && ls -la",
});
await step(first, "read_file", { path: "red.png" });
console.log(`images queued for the model: ${first.images.length} (${first.images[0]?.image_url.slice(0, 40)}…)`);
await step(first, "bash", { command: "sleep 70; echo never" });
await closeWorkspace(first);

// A new run (new sandbox) still sees the drive's files.
const second = newCtx();
await step(second, "read_file", { path: "notes/hello.md" });
await step(second, "bash", { command: "ls -la; ls /tmp | head -3" });
await closeWorkspace(second);

const { Drive } = await import("@vercel/sandbox");
await (await Drive.get({ name: driveName(chat.key) })).delete();
console.log(`\ndeleted drive ${driveName(chat.key)}`);
