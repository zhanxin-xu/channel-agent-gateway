/**
 * Live check of the per-chat workspace against real Vercel Sandbox + Drive:
 *   npx vercel env pull && npx tsx scripts/sandbox-smoke.ts
 * Needs VERCEL_OIDC_TOKEN (read from .env.local if present). Uses, then
 * deletes, the drive for the chat key "smoke:test".
 */
import { existsSync } from "node:fs";
import { runTool } from "../src/tools/registry.js";
import type { ToolContext } from "../src/tools/types.js";
import { driveName } from "../src/tools/sandbox/vercel.js";
import { closeWorkspace } from "../src/tools/sandbox/workspace.js";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
process.env.SANDBOX_ENABLED = "1";
const chat = { key: "smoke:test", scene: "私聊" as const, sender: "#SMOKE" };
const newCtx = (): ToolContext => ({
  sent: [],
  send: async () => "sent",
  deadline: Date.now() + 300_000,
  callBudgetMs: () => 280_000,
  chat,
  images: [],
  onRunEnd: () => {},
  // Message 第1条 "has" one attachment: a public image, to check save_attachment's curl into the drive.
  attachments: (seq) =>
    seq === 1 ? [{ name: "logo.png", url: "https://serverless-agent.cnday.cn/logo.png", contentType: "image/png" }] : undefined,
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
await step(first, "save_attachment", { message: 1 });
await step(first, "bash", { command: "ls -la inbox && python3 -c \"import struct;d=open('inbox/1-logo.png','rb').read(24);print('png', struct.unpack('>II', d[16:24]))\"" });
console.log(`images queued for the model: ${first.images.length} (${first.images[0]?.image_url.slice(0, 40)}…)`);
await step(first, "bash", { command: "sleep 70; echo never" });

await step(first, "bash", { command: "pip install -q six && npm install -g --silent cowsay && which cowsay" });
await closeWorkspace(first);

// A new run (new sandbox) still sees the drive's files and this chat's packages.
const second = newCtx();
await step(second, "read_file", { path: "notes/hello.md" });
await step(second, "bash", { command: "python3 -c 'import six; print(\"six\", six.__version__)' && cowsay -f tux persisted | tail -3" });
await step(second, "bash", { command: "ls -la; ls /tmp | head -3" });
await closeWorkspace(second);

const { Drive } = await import("@vercel/sandbox");
await (await Drive.get({ name: driveName(chat.key) })).delete();
console.log(`\ndeleted drive ${driveName(chat.key)}`);
