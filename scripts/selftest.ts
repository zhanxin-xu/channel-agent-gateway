/**
 * Offline end-to-end test: `npm test`.
 * Stubs global fetch (Responses API, DeepSeek tools, QQ, Telegram, Supabase,
 * Upstash Vector) and
 * Vercel's waitUntil, then drives each channel through the real webhook
 * handler, event log and agent loop.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.OPENAI_RESPONSES_API_KEY = "test-key";
process.env.OPENAI_RESPONSES_BASE_URL = "https://gw.example.com/api/v1/";
process.env.OPENAI_RESPONSES_MODEL = "openai/gpt-6-luna";
process.env.OPENAI_RESPONSES_EXTRA_BODY = '{"provider":{"only":["openai"],"allow_fallbacks":false},"max_output_tokens":2000}';
process.env.OPENAI_RESPONSES_EXTRA_HEADERS = '{"X-Title":"selftest"}';
process.env.DEEPSEEK_API_KEY = "ds-key";
process.env.QQ_APP_ID = "102000000";
process.env.QQ_APP_SECRET = "naOC0ocQE3shWLAfffVLB1rhYPG7";
process.env.TELEGRAM_BOT_TOKEN = "123:abc";
process.env.TELEGRAM_WEBHOOK_SECRET = "tg-secret";
process.env.HTTP_CHANNEL_TOKEN = "http-secret";
for (const name of [
  "UPSTASH_VECTOR_REST_URL",
  "UPSTASH_VECTOR_REST_TOKEN",
  "VERCEL",
  "VERCEL_OIDC_TOKEN",
  "SANDBOX_ENABLED",
  "WORKER_SECRET",
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
]) {
  delete process.env[name];
}

// ── Capture waitUntil promises ──
const pending: Promise<unknown>[] = [];
(globalThis as Record<symbol, unknown>)[Symbol.for("@vercel/request-context")] = {
  get: () => ({ waitUntil: (p: Promise<unknown>) => pending.push(p) }),
};
const drain = async () => {
  while (pending.length) await Promise.all(pending.splice(0));
};

// ── A clock tests can move forward ──
const realNow = Date.now;
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;

// ── Stub fetch ──
interface Call {
  url: string;
  body: any;
  headers: Headers;
}
const calls: Call[] = [];
let llmCalls = 0;
/** Model calls in flight right now, and the most seen at once. */
let inFlight = 0;
let maxInFlight = 0;
/** Tests can hold the fake model until they release this gate. */
let gate: Promise<void> | undefined;
let fakeInputTokens: number | undefined;

const textMessage = (text: string) => ({
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
});
const fnCall = (callId: string, name: string, args: unknown) => ({
  type: "function_call",
  id: `fc_${callId}`,
  call_id: callId,
  name,
  arguments: JSON.stringify(args),
});
const sendCall = (callId: string, text: string, extra: Record<string, unknown> = {}) => fnCall(callId, "send_message", { text, ...extra });

/**
 * Supabase's Data API: the real functions of supabase/schema.sql in a local
 * Postgres when TEST_DATABASE_URL is set, else a MemoryStore behind the same URLs.
 */
const { MemoryStore } = await import("../src/store/index.js");
const { memoryRpc, postgresRpc, rpcResponse } = await import("./rpc-shim.js");
const pgBackend = process.env.TEST_DATABASE_URL ? await postgresRpc(process.env.TEST_DATABASE_URL) : undefined;
const supabaseRpc = pgBackend?.rpc ?? memoryRpc(new MemoryStore());
const fakeSupabase = rpcResponse(supabaseRpc, "sb_secret_test");

/** Minimal Upstash Vector emulator: "similarity" is just shared characters with the query. */
const vectors = new Map<string, { data: string; metadata: unknown }>();
function fakeVector(url: string, method: string, body: any) {
  const path = new URL(url).pathname;
  if (path === "/upsert-data" && method === "POST") {
    vectors.set(body.id, { data: body.data, metadata: body.metadata });
    return Response.json({ result: "Success" });
  }
  if (path === "/query-data" && method === "POST") {
    const score = (text: string) => [...new Set(body.data)].filter((ch) => text.includes(ch as string)).length / new Set(body.data).size;
    const hits = [...vectors].map(([id, v]) => ({ id, score: score(v.data), data: v.data, metadata: v.metadata }));
    return Response.json({ result: hits.sort((a, b) => b.score - a.score).slice(0, body.topK) });
  }
  if (path === "/delete" && method === "DELETE") {
    return Response.json({ result: { deleted: body.ids.filter((id: string) => vectors.delete(id)).length } });
  }
  return Response.json({ error: `unexpected ${method} ${path}`, status: 400 }, { status: 400 });
}

const textOf = (m: any): string => (typeof m.content === "string" ? m.content : m.content.find((p: any) => p.type === "input_text").text);

/**
 * Fake Responses API, keyed off the newest user message (its header line dropped).
 * By default: first step calls calculate, the next answers in plain text
 * (the fallback path). Talk-only outputs get an end_turn, like a good model.
 */
async function fakeResponses(body: any) {
  llmCalls++;
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  try {
    // The compaction call: summarize, no tools.
    const last = body.input.at(-1);
    if (last.role === "user" && textOf(last).includes("对话压缩器")) {
      assert.equal(body.tool_choice, "none");
      return respond(body, [textMessage("摘要：大家聊过天气和算术。")]);
    }
    // Only this turn's tool results count (the log keeps earlier turns' too).
    const turnStart = body.input.findLastIndex((i: any) => i.role === "developer" && /轮开始/.test(i.content));
    const toolOutput = body.input.slice(turnStart).findLast((i: any) => i.type === "function_call_output");
    const lastUser = body.input.findLast((i: any) => i.role === "user" && !textOf(i).startsWith("（系统提示）"));
    const userText = textOf(lastUser).split("\n").slice(1).join("\n");
    if (userText.startsWith("慢") && gate) await gate;

    let output: unknown[];
    if (userText.includes("表情")) {
      output = toolOutput ? [] : [fnCall("call_s1", "send_sticker", { name: "红温了" }), sendCall("call_s2", "气死我了")];
    } else if (userText.startsWith("路过")) {
      output = [fnCall(`call_end${llmCalls}`, "end_turn", {})];
    } else if (userText.includes("连发")) {
      output = toolOutput ? [textMessage("这句是收尾文字，不应该被发出去")] : [sendCall("call_a", "第一条"), sendCall("call_b", "第二条")];
    } else if (userText.startsWith("刷屏")) {
      output = toolOutput ? [] : [1, 2, 3, 4, 5, 6].map((i) => sendCall(`call_f${i}`, `第${i}遍`));
    } else if (/^回复(\d+)/.test(userText)) {
      output = toolOutput ? [] : [sendCall("call_r", "回你之前那条", { reply_to: Number(/^回复(\d+)/.exec(userText)![1]) })];
    } else if (userText.startsWith("先挂")) {
      // Hangs up first, then talks and calculates: everything in the step still runs, in order.
      output = [fnCall("call_e", "end_turn", {}), sendCall("call_1", "第一条"), fnCall("call_c", "calculate", { expression: "6*7" }), sendCall("call_2", "第二条")];
    } else if (userText.startsWith("死循环")) {
      // Keeps calling tools until the last-step note shows up, then reports.
      const calc = fnCall(`call_l${llmCalls}`, "calculate", { expression: "1+1" });
      output = last.role === "developer" && last.content.includes("最后一步") ? [sendCall("call_done", "做到一半")] : [calc];
    } else if (userText.startsWith("发文件")) {
      output = toolOutput ? [textMessage(`结果：${toolOutput.output}`)] : [fnCall("call_f", "send_file", { path: userText.slice(3).trim() })];
    } else if (userText.startsWith("存附件")) {
      const seq = Number(/^存附件\s*(\d+)/.exec(userText)?.[1] ?? 0);
      output = toolOutput ? [textMessage(`结果：${toolOutput.output}`)] : [fnCall("call_sa", "save_attachment", { message: seq })];
    } else if (userText.startsWith("读图")) {
      output = toolOutput ? [textMessage("看到了")] : [fnCall("call_r", "read_file", { path: "out/plot.png" })];
    } else if (toolOutput) {
      output = [{ type: "reasoning", id: "rs_2", summary: [] }, textMessage(`答案是 ${toolOutput.output}`)];
    } else {
      output = [
        { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "先算一下" }], encrypted_content: "enc" },
        userText.startsWith("搜索")
          ? fnCall("call_s", "web_search", { query: userText.slice(2).trim() })
          : fnCall(`call_${llmCalls}`, "calculate", { expression: "(2+3)*4" }),
      ];
    }
    const TALK = ["send_message", "send_sticker", "send_file"];
    if (output.length && output.every((o: any) => o.type === "function_call" && TALK.includes(o.name))) {
      output = [...output, fnCall(`call_end${llmCalls}`, "end_turn", {})];
    }
    return respond(body, output);
  } finally {
    inFlight--;
  }
}
function respond(body: any, output: unknown[]) {
  return Response.json({
    id: "resp_1",
    object: "response",
    status: "completed",
    model: body.model,
    output,
    usage: { input_tokens: fakeInputTokens ?? 10, input_tokens_details: { cached_tokens: 6 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 3 } },
  });
}

let worker: ((request: Request) => Promise<Response>) | undefined;
/** What the fake image API answers; set by the generate_image test. */
let imageResponse: (() => Response) | undefined;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const req = new Request(input, init);
  const url = req.url;
  if (url.endsWith("/api/worker")) {
    calls.push({ url, body: await req.clone().json(), headers: req.headers });
    return worker!(req);
  }
  const text = await req.text();
  const body = text && req.headers.get("content-type")?.includes("json") !== false ? safeJson(text) : text;
  calls.push({ url, body, headers: req.headers });

  if (url === "https://gw.example.com/api/v1/responses") return fakeResponses(body);
  if (url === "https://img.example.com/api/v1/images") return imageResponse!();
  if (url === "https://img.example.com/api/v1/key") {
    return Response.json({
      data: { label: "sk-or-v1-img...", limit: 2, limit_remaining: 1.88, limit_reset: "daily", usage: 0.12, usage_daily: 0.12, usage_weekly: 0.12, usage_monthly: 0.12 },
    });
  }
  if (url === "https://img.example.com/broken/key") return new Response("not found", { status: 404 });
  if (url === "https://api.deepseek.com/v1/tools/search") {
    return Response.json({ results: [{ title: "DeepSeek V4", url: "https://example.com/v4", summary: "发布了", rerank_score: 2.1, authority: 3 }] });
  }
  if (url === "https://api.deepseek.com/v1/tools/fetch") return Response.json({ title: "T", content: "# body" });
  if (url === "https://api.deepseek.com/user/balance") {
    return Response.json({
      is_available: true,
      balance_infos: [{ currency: "CNY", total_balance: "12.50", granted_balance: "2.50", topped_up_balance: "10.00" }],
    });
  }
  if (url === "https://gw.example.com/api/v1/key") {
    return Response.json({
      data: {
        label: "sk-or-v1-abc...xyz",
        limit: 20,
        limit_remaining: 14.5,
        limit_reset: "monthly",
        usage: 5.5,
        usage_daily: 0.3,
        usage_weekly: 1.2,
        usage_monthly: 5.5,
        byok_usage: 3,
        byok_usage_daily: 0.34,
        byok_usage_weekly: 1,
        byok_usage_monthly: 3,
        include_byok_in_limit: true,
        is_free_tier: false,
        effective_budget: { scope: "api_key", limit_usd: 20, spend_usd: 5.5, remaining_usd: 14.5, reset_interval: "monthly", resets_at: "2026-12-01T00:00:00Z", include_byok: true },
      },
    });
  }
  if (url.startsWith("https://db.example.supabase.co/rest/v1/rpc/")) return fakeSupabase(url, req.headers, body);
  if (url.startsWith("https://vector.example.com/")) return fakeVector(url, req.method, body);
  if (url.startsWith("https://multimedia.nt.qq.com.cn/")) {
    if (url.includes("missing")) return new Response("gone", { status: 404 });
    if (url.includes("flaky") && calls.filter((c) => c.url === url).length === 1) return new Response("busy", { status: 503 });
    return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { "content-type": "image/png" } });
  }
  if (url === "https://bots.qq.com/app/getAppAccessToken") return Response.json({ access_token: "qq-token", expires_in: "7200" });
  if (url.startsWith("https://api.sgroup.qq.com/v2/") && url.endsWith("/files")) {
    return Response.json({ file_uuid: "u1", file_info: "FILEINFO", ttl: 3600 });
  }
  if (url.startsWith("https://api.sgroup.qq.com/")) return Response.json({ id: "sent", timestamp: 1 });
  if (url.startsWith("https://api.telegram.org/")) return Response.json({ ok: true, result: {} });
  throw new Error(`unexpected fetch ${url}`);
}) as typeof fetch;

function safeJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const { handleWebhook } = await import("../src/webhook.js");
const { handleWorker } = await import("../src/worker.js");
worker = handleWorker;
const { activeTools, runTool } = await import("../src/tools/registry.js");
const { evaluate } = await import("../src/tools/utility.js");
const { messageHeader } = await import("../src/channels/format.js");
const { getStore, resetStore, storeBackend } = await import("../src/store/index.js");
const qqHint = (await import("../src/channels/qq.js")).qqAdapter.promptHint!;
const { config } = await import("../src/config.js");
const { setWorkspaceFactory } = await import("../src/tools/sandbox/workspace.js");
const { attachmentFileName } = await import("../src/tools/sandbox/tools.js");
const { driveName } = await import("../src/tools/sandbox/vercel.js");

/** Tool context for calling tools directly, outside a conversation. */
const testChat = { key: "http:c0", scene: "私聊" as const, sender: "#USER01" };
const noCtx = {
  sent: [] as string[],
  send: async () => "sent",
  deadline: Number.POSITIVE_INFINITY,
  chat: testChat,
  images: [],
  onRunEnd: () => {},
  attachments: (_seq: number) => undefined as Array<{ name: string; url: string; contentType: string }> | undefined,
};

/** A chat's events as stored. */
async function events(chatKey: string): Promise<Array<{ seq: number; type: string; data: any }>> {
  return (await getStore().open(chatKey, -1)).events;
}

// ── QQ signing helpers (independent of the implementation under test) ──
function qqKeys(secret: string) {
  let seed = secret;
  while (seed.length < 32) seed += seed;
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seed.slice(0, 32))]),
    format: "der",
    type: "pkcs8",
  });
  return { privateKey, publicKey: crypto.createPublicKey(privateKey) };
}
const keys = qqKeys(process.env.QQ_APP_SECRET!);

function qqRequest(payload: unknown, sign = true) {
  const body = JSON.stringify(payload);
  const ts = "1725000000";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sign) {
    headers["x-signature-timestamp"] = ts;
    headers["x-signature-ed25519"] = crypto.sign(null, Buffer.from(ts + body), keys.privateKey).toString("hex");
  }
  return new Request("https://bot.example.com/api/webhook/qq", { method: "POST", headers, body });
}
const c2c = (id: string, content: string, user = "USER1", extra: Record<string, unknown> = {}) =>
  qqRequest({ op: 0, t: "C2C_MESSAGE_CREATE", d: { id, content, author: { user_openid: user }, ...extra } });

const httpCall = (text: string, conversationId = "c1") =>
  handleWebhook(
    new Request("http://localhost/api/webhook/http", {
      method: "POST",
      headers: { authorization: "Bearer http-secret" },
      body: JSON.stringify({ conversationId, text }),
    }),
    "http",
  ).then((r) => r.json() as Promise<{ reply: string | null; messages: string[]; queued?: true }>);

const llmRequests = () => calls.filter((c) => c.url.endsWith("/responses"));
const sentTo = (path: string) => calls.filter((c) => c.url.endsWith(path)).map((c) => c.body);

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  calls.length = 0;
  llmCalls = 0;
  maxInFlight = 0;
  await fn();
  await drain();
  passed++;
  console.log(`✓ ${name}`);
}

await test("calculator", () => {
  assert.equal(evaluate("(2+3)*4"), 20);
  assert.equal(evaluate("2^3^2"), 512);
  assert.equal(evaluate("-1.5 + 10 % 4"), 0.5);
  assert.throws(() => evaluate("2 +"));
});

await test("config: extra body / base url parsing", () => {
  assert.equal(config.llm.baseUrl, "https://gw.example.com/api/v1");
  const saved = process.env.OPENAI_RESPONSES_EXTRA_BODY;
  process.env.OPENAI_RESPONSES_EXTRA_BODY = "{bad";
  assert.throws(() => config.llm.extraBody, /OPENAI_RESPONSES_EXTRA_BODY is not valid JSON/);
  process.env.OPENAI_RESPONSES_EXTRA_BODY = "[1]";
  assert.throws(() => config.llm.extraBody, /must be a JSON object/);
  process.env.OPENAI_RESPONSES_EXTRA_BODY = saved;
});

await test("config: old OPENROUTER_* names still work; the new names win", () => {
  const saved = { ...process.env };
  try {
    for (const k of Object.keys(process.env)) if (k.startsWith("OPENAI_RESPONSES_")) delete process.env[k];
    process.env.OPENROUTER_API_KEY = "old-key";
    process.env.OPENROUTER_MODEL = "old/model";
    process.env.OPENROUTER_EXTRA_BODY = "{bad";
    assert.equal(config.llm.apiKey, "old-key");
    assert.equal(config.llm.model, "old/model");
    assert.equal(config.llm.baseUrl, "https://openrouter.ai/api/v1", "unset everywhere: the default");
    assert.throws(() => config.llm.extraBody, /OPENROUTER_EXTRA_BODY is not valid JSON/, "errors name the variable actually read");
    assert.deepEqual(config.llm.legacyEnv, ["OPENROUTER_API_KEY", "OPENROUTER_MODEL", "OPENROUTER_EXTRA_BODY"]);
    process.env.OPENAI_RESPONSES_API_KEY = "new-key";
    assert.equal(config.llm.apiKey, "new-key");
    assert.deepEqual(config.llm.legacyEnv, ["OPENROUTER_MODEL", "OPENROUTER_EXTRA_BODY"]);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
  assert.deepEqual(config.llm.legacyEnv, []);
});

await test("DeepSeek-backed tools only enabled with DEEPSEEK_API_KEY", () => {
  assert.deepEqual(
    activeTools().map((t) => t.name),
    ["send_message", "send_sticker", "end_turn", "get_current_time", "calculate", "web_search", "web_fetch", "get_search_balance", "get_llm_key_limit"],
  );
  process.env.DEEPSEEK_API_KEY = "";
  assert.deepEqual(
    activeTools().map((t) => t.name),
    ["send_message", "send_sticker", "end_turn", "get_current_time", "calculate", "get_llm_key_limit"],
  );
  process.env.DEEPSEEK_API_KEY = "ds-key";
});

await test("get_search_balance: DeepSeek /user/balance", async () => {
  const out = JSON.parse(await runTool("get_search_balance", "{}", noCtx));
  const req = calls.find((c) => c.url === "https://api.deepseek.com/user/balance")!;
  assert.equal(req.headers.get("authorization"), "Bearer ds-key");
  assert.equal(out.available, true);
  assert.deepEqual(out.balances[0], { currency: "CNY", total: "12.50", granted: "2.50", topped_up: "10.00", approx_search_calls_left: 2500 });
});

await test("get_llm_key_limit: {baseUrl}/key with extra headers", async () => {
  const out = JSON.parse(await runTool("get_llm_key_limit", "{}", noCtx));
  const req = calls.find((c) => c.url === "https://gw.example.com/api/v1/key")!;
  assert.equal(req.headers.get("authorization"), "Bearer test-key");
  assert.equal(req.headers.get("x-title"), "selftest");
  const model = out.model_key;
  assert.equal(model.limit_remaining, 14.5);
  assert.deepEqual(model.usage, { today: 0.3, this_week: 1.2, this_month: 5.5, all_time: 5.5 });
  assert.deepEqual(model.byok_usage, { today: 0.34, this_week: 1, this_month: 3, all_time: 3 }, "BYOK spend reported apart from credits");
  assert.equal(model.limit_counts_byok, true);
  assert.equal(model.effective_budget.remaining, 14.5);
  assert.equal(model.effective_budget.counts_byok, true);
  assert.equal(model.effective_budget.reset_interval, "monthly");
  assert.equal(out.image_key, undefined, "no image key configured");
  assert.match(out.note, /00:00 UTC/);
});

await test("get_llm_key_limit: the image key is reported on its own, or marked as shared", async () => {
  process.env.IMAGE_API_KEY = "img-key";
  process.env.IMAGE_BASE_URL = "https://img.example.com/api/v1";
  try {
    const out = JSON.parse(await runTool("get_llm_key_limit", "{}", noCtx));
    const req = calls.find((c) => c.url === "https://img.example.com/api/v1/key")!;
    assert.equal(req.headers.get("authorization"), "Bearer img-key");
    assert.equal(req.headers.get("x-title"), null, "the model's extra headers stay with the model key");
    assert.equal(out.model_key.limit_remaining, 14.5);
    assert.deepEqual(out.image_key.usage, { today: 0.12, this_week: 0.12, this_month: 0.12, all_time: 0.12 });
    assert.equal(out.image_key.limit_remaining, 1.88);

    process.env.IMAGE_BASE_URL = "https://img.example.com/broken";
    const broken = JSON.parse(await runTool("get_llm_key_limit", "{}", noCtx));
    assert.equal(broken.model_key.limit_remaining, 14.5, "one key failing doesn't hide the other");
    assert.match(broken.image_key.error, /HTTP 404/);

    process.env.IMAGE_API_KEY = "test-key";
    const shared = JSON.parse(await runTool("get_llm_key_limit", "{}", noCtx));
    assert.match(shared.image_key, /^same key as model_key/);
  } finally {
    delete process.env.IMAGE_API_KEY;
    delete process.env.IMAGE_BASE_URL;
  }
});

await test("qq: op13 callback validation", async () => {
  const res = await handleWebhook(qqRequest({ op: 13, d: { plain_token: "abc", event_ts: "123" } }, false), "qq");
  const data = (await res.json()) as { plain_token: string; signature: string };
  assert.equal(data.plain_token, "abc");
  assert.ok(crypto.verify(null, Buffer.from("123abc"), keys.publicKey, Buffer.from(data.signature, "hex")));
});

await test("qq: rejects bad signature", async () => {
  const req = c2c("m0", "hi", "u");
  req.headers.set("x-signature-ed25519", "00".repeat(64));
  assert.equal((await handleWebhook(req, "qq")).status, 401);
});

await test("qq: c2c → ACK, turn on the event log, tool loop, passive reply", async () => {
  const res = await handleWebhook(c2c("msg-1", " 算一下 (2+3)*4 "), "qq");
  assert.deepEqual(await res.json(), { op: 12, d: 0 });
  await drain();

  assert.equal(llmCalls, 2, "tool round-trip = 2 model calls");
  const [first, second] = llmRequests();
  assert.equal(first!.headers.get("authorization"), "Bearer test-key");
  assert.equal(first!.headers.get("x-title"), "selftest");
  assert.equal(first!.body.model, "openai/gpt-6-luna");
  assert.deepEqual(first!.body.provider, { only: ["openai"], allow_fallbacks: false }, "extra body passed through");
  assert.equal(first!.body.max_output_tokens, 2000);
  assert.ok(first!.body.instructions.startsWith("# 身份"), "built-in persona prompt");
  assert.ok(first!.body.instructions.endsWith(qqHint), "channel hint appended");
  assert.equal(first!.body.tool_choice, "required");
  const [message, note] = first!.body.input;
  assert.match(message.content, /^\[第0条｜\d{4}\/\d{2}\/\d{2}.* Asia\/Shanghai｜私聊｜发送人 #USER1\]\n算一下 \(2\+3\)\*4$/);
  assert.deepEqual(note, { role: "developer", content: note.content });
  assert.match(note.content, /^（系统提示）第1轮开始。待处理的消息：第0条（#USER1，@你）。发消息默认回复第0条/);

  // Stateless replay of the log: reasoning (encrypted_content kept) + function_call, then the output.
  assert.deepEqual(second!.body.input.slice(2).map((i: any) => i.type), ["reasoning", "function_call", "function_call_output"]);
  assert.equal(second!.body.input[2].encrypted_content, "enc");
  assert.deepEqual(second!.body.input[4], { type: "function_call_output", call_id: "call_1", output: "20" });

  const sent = calls.find((c) => c.url.includes("/v2/users/USER1/messages"))!;
  assert.equal(sent.headers.get("authorization"), "QQBot qq-token");
  assert.deepEqual(sent.body, { content: "答案是 20", msg_type: 0, msg_id: "msg-1", msg_seq: 1 });

  // The log holds everything, in dsh's vocabulary.
  assert.deepEqual(
    (await events("qq:c2c:USER1")).map((e) => e.type),
    [
      "user/message",
      "turn/start",
      "developer/message",
      "step/start",
      "assistant/message",
      "tool/call",
      "tool/result",
      "step/end",
      "step/start",
      "assistant/message",
      "step/end",
      "turn/end",
    ],
  );
});

await test("event log: the next turn replays the last request verbatim (cache prefix), reasoning included", async () => {
  await httpCall("first", "replay");
  const turn1 = llmRequests().length;
  const lastOfTurn1 = llmRequests().at(-1)!.body.input;
  await httpCall("second", "replay");
  const firstOfTurn2 = llmRequests()[turn1]!.body.input;
  // Turn 2's request starts with turn 1's last request plus turn 1's final output: a strict extension.
  assert.deepEqual(firstOfTurn2.slice(0, lastOfTurn1.length), lastOfTurn1);
  assert.equal(firstOfTurn2[2].type, "reasoning");
  assert.deepEqual(firstOfTurn2[2].summary, [{ type: "summary_text", text: "先算一下" }]);
  assert.equal(firstOfTurn2[2].encrypted_content, "enc");
  assert.match(firstOfTurn2.at(-1).content, /^（系统提示）第2轮开始。待处理的消息：第\d+条/);
});

await test("qq: send_message twice + end_turn in one step → two passive replies, one model call", async () => {
  await handleWebhook(c2c("msg-2", "连发两条"), "qq");
  await drain();
  assert.deepEqual(sentTo("/v2/users/USER1/messages"), [
    { content: "第一条", msg_type: 0, msg_id: "msg-2", msg_seq: 1 },
    { content: "第二条", msg_type: 0, msg_id: "msg-2", msg_seq: 2 },
  ]);
  assert.equal(llmCalls, 1);
});

await test("reply_to: replies go to the chosen message; msg_seq and the reply count carry over between turns", async () => {
  await handleWebhook(c2c("ra", "连发", "RUSER"), "qq");
  await drain();
  await handleWebhook(c2c("rb", "回复0", "RUSER"), "qq");
  await drain();
  assert.deepEqual(
    sentTo("/v2/users/RUSER/messages").map((b) => [b.msg_id, b.msg_seq, b.content]),
    [
      ["ra", 1, "第一条"],
      ["ra", 2, "第二条"],
      ["ra", 3, "回你之前那条"],
    ],
  );
  const result = (await events("qq:c2c:RUSER")).findLast((e) => e.type === "tool/result" && e.data.callId === "call_r")!;
  assert.match(result.data.output, /^sent as a reply to 第0条 \(3\/5\)/);
});

await test("reply cap: 5 replies per message, the 6th is refused and the model sees why", async () => {
  await handleWebhook(c2c("cap", "刷屏", "CAPUSER"), "qq");
  await drain();
  assert.equal(sentTo("/v2/users/CAPUSER/messages").length, 5);
  const sixth = (await events("qq:c2c:CAPUSER")).find((e) => e.type === "tool/result" && e.data.callId === "call_f6")!;
  assert.match(sixth.data.output, /^Error: already replied to 第0条 5 times/);
  assert.equal(llmCalls, 2, "a failed send keeps the turn going after end_turn");
});

await test("stickers: CDN hotlink by default, STICKER_BASE_URL override", async () => {
  const { STICKERS, stickerUrl, DEFAULT_STICKER_BASE_URL } = await import("../src/tools/stickers.js");
  assert.ok(Object.keys(STICKERS).length >= 30);
  assert.ok(Object.values(STICKERS).every((s) => /^(meme\/\d+\.gif|0_preview\/meme\/\d+\.webp)$/.test(s.file)));
  assert.equal(stickerUrl(DEFAULT_STICKER_BASE_URL, "红温了"), "https://img.aigengtu.com/meme/3153.gif");
  assert.equal(stickerUrl(DEFAULT_STICKER_BASE_URL, "得加钱"), "https://img.aigengtu.com/0_preview/meme/097.webp");
  assert.equal(stickerUrl("https://my.cdn/s/", "得加钱"), "https://my.cdn/s/0_preview/meme/097.webp");
});

await test("qq: send_sticker → upload by URL, msg_type 7, then text with next msg_seq", async () => {
  await handleWebhook(c2c("msg-3", "来个表情"), "qq");
  await drain();
  const upload = calls.find((c) => c.url === "https://api.sgroup.qq.com/v2/users/USER1/files")!;
  assert.deepEqual(upload.body, { file_type: 1, url: "https://img.aigengtu.com/meme/3153.gif", srv_send_msg: false });
  assert.deepEqual(sentTo("/v2/users/USER1/messages"), [
    { msg_type: 7, media: { file_info: "FILEINFO" }, msg_id: "msg-3", msg_seq: 1 },
    { content: "气死我了", msg_type: 0, msg_id: "msg-3", msg_seq: 2 },
  ]);
});

const tgUpdate = (id: number, messageId: number, text: string) =>
  new Request("https://bot.example.com/api/webhook/telegram", {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": "tg-secret" },
    body: JSON.stringify({ update_id: id, message: { message_id: messageId, text, chat: { id: 42, type: "private" }, from: { id: 7 } } }),
  });

await test("telegram: GIF sticker goes through sendAnimation; only the first reply quotes", async () => {
  await handleWebhook(tgUpdate(10, 6, "表情来"), "telegram");
  await drain();
  const anim = calls.find((c) => c.url.endsWith("/sendAnimation"))!;
  assert.equal(anim.body.animation, "https://img.aigengtu.com/meme/3153.gif");
  assert.equal(anim.body.reply_parameters.message_id, 6, "first message quotes the user");
  assert.equal(calls.find((c) => c.url.endsWith("/sendMessage"))!.body.reply_parameters, undefined);
});

await test("telegram: secret check + reply", async () => {
  const bad = new Request("http://localhost/api/webhook/telegram", { method: "POST", body: "{}" });
  assert.equal((await handleWebhook(bad, "telegram")).status, 401);
  assert.equal((await handleWebhook(tgUpdate(9, 5, "hello"), "telegram")).status, 200);
  await drain();
  assert.equal(calls.find((c) => c.url.endsWith("/sendMessage"))!.body.chat_id, "42");
  assert.ok(calls.some((c) => c.url.endsWith("/sendChatAction")));
});

await test("http: sticker degrades to a text line", async () => {
  const { messages } = await httpCall("表情", "stk");
  assert.deepEqual(messages, ["[表情包：红温了] https://img.aigengtu.com/meme/3153.gif", "气死我了"]);
});

await test("message header: time, scene, sender, @你 (the 第N条 number is added from the seq)", () => {
  const base = { channel: "qq", eventId: "e", conversationId: "g", text: "hi", replyContext: {} };
  const now = new Date("2026-11-03T12:43:00Z");
  assert.match(messageHeader({ ...base, chatType: "group", userId: "5f0ee621a747e4683b6834" }, now), /^2026\/11\/03.*20:43 Asia\/Shanghai｜群聊｜发送人 #3B6834｜@你$/);
  assert.match(messageHeader({ ...base, chatType: "group", mode: "ambient", userId: "5f0ee621a747e4683b6834", senderName: "老王" }, now), /｜群聊｜发送人 老王 #3B6834$/);
  assert.match(messageHeader({ ...base, chatType: "private", userId: "7", senderName: "Alice" }, now), /｜私聊｜发送人 Alice #7$/);
});

await test("postgres store: one function call per operation over /rest/v1/rpc with the secret key", async () => {
  const { PostgresStore } = await import("../src/store/index.js");
  const store = new PostgresStore("https://db.example.supabase.co/", "sb_secret_test");
  calls.length = 0;
  const ingest = {
    chat: "qq:shape",
    channel: "qq",
    conversationId: "shape",
    chatType: "group" as const,
    eventId: "s1",
    direct: true,
    event: { type: "user/message", data: { text: "hi" } },
    reset: false,
    wake: true,
    ambientIntervalSeconds: 10,
    lockOwner: "me",
    lockTtlMs: 60_000,
  };
  assert.deepEqual(await store.ingest(ingest), { status: "acquired", seq: 0 });
  assert.equal(await store.append("qq:shape", "me", [{ type: "turn/start", data: { turn: 1 } }]), 1);
  assert.deepEqual((await store.open("qq:shape", 0)).events.map((e) => e.type), ["turn/start"]);
  assert.equal(await store.getReply("qq:shape", "s1"), null);
  const call = calls.find((c) => c.url === "https://db.example.supabase.co/rest/v1/rpc/chat_ingest")!;
  assert.equal(call.headers.get("apikey"), "sb_secret_test");
  assert.equal(call.headers.get("authorization"), null, "a sb_secret_ key is not a bearer token");
  assert.deepEqual(call.body, {
    p_chat: "qq:shape",
    p_channel: "qq",
    p_conversation_id: "shape",
    p_chat_type: "group",
    p_origin: null,
    p_event_id: "s1",
    p_direct: true,
    p_event: ingest.event,
    p_reset: false,
    p_upgrade: null,
    p_wake: true,
    p_ambient_interval_s: 10,
    p_lock_owner: "me",
    p_lock_ttl_ms: 60000,
  });
  assert.equal(calls.length, 4);
});

await test("supabase store: picked when configured; a whole conversation runs on it", async () => {
  const memory = getStore();
  process.env.SUPABASE_URL = "https://db.example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test";
  resetStore();
  try {
    assert.equal(storeBackend(), "supabase");
    assert.equal((await httpCall("first", "pgchat")).reply, "答案是 20");
    await httpCall("second", "pgchat");
    const { session, events: stored } = (await supabaseRpc("chat_open", { p_chat: "http:pgchat", p_after_seq: -1 })) as any;
    const types = stored.map((e: any) => e.type);
    assert.equal(types.filter((t: string) => t === "turn/end").length, 2);
    assert.deepEqual(stored.map((e: any) => e.seq), [...stored.keys()], "contiguous seqs from 0");
    assert.equal(session.cursor, stored.findLast((e: any) => e.type === "user/message").seq);
    assert.equal(session.turn, 2);
  } finally {
    for (const k of ["SUPABASE_URL", "SUPABASE_SECRET_KEY"]) delete process.env[k];
    resetStore(memory);
  }
});

await test("qq: retried event is de-duplicated", async () => {
  await handleWebhook(c2c("msg-1", "again"), "qq");
  await drain();
  assert.equal(llmCalls, 0);
});

await test("qq reply window: the turn's default target is a message that can still be answered", async () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const groupAtOld = (id: string, m: number) =>
    qqRequest({ op: 0, t: "GROUP_AT_MESSAGE_CREATE", d: { id, content: "hi", timestamp: minutesAgo(m), group_openid: "GROUP2", author: { member_openid: "M2" } } });
  // Group message from 6 minutes ago: past the 5-minute window, so nothing is posted to QQ.
  await handleWebhook(groupAtOld("g-old", 6), "qq");
  await drain();
  assert.equal(sentTo("/v2/groups/GROUP2/messages").length, 0, "expired group reply is not sent");
  assert.ok(llmCalls > 0, "the model still ran");
  // 4 minutes ago: still inside the window.
  await handleWebhook(groupAtOld("g-new", 4), "qq");
  await drain();
  assert.deepEqual(sentTo("/v2/groups/GROUP2/messages").map((b) => b.msg_id), ["g-new"]);
  // C2C: 30 minutes is fine (60-minute window), 61 is not; arriving together, the run answers the one it can.
  await handleWebhook(c2c("c-30", "hi", "USER9", { timestamp: minutesAgo(30) }), "qq");
  await handleWebhook(c2c("c-61", "hi", "USER9", { timestamp: minutesAgo(61) }), "qq");
  await drain();
  assert.deepEqual(sentTo("/v2/users/USER9/messages").map((b) => b.msg_id), ["c-30"]);
});

await test("qq adapter: 5 replies per message, the 6th is refused before calling QQ", async () => {
  const { qqAdapter } = await import("../src/channels/qq.js");
  const msg = {
    channel: "qq", eventId: "e", conversationId: "c2c:U", chatType: "private" as const, userId: "U", text: "x",
    replyContext: { scope: "c2c", target: "U5", msgId: "m-5", expiresAt: String(Date.now() + 60_000) } as Record<string, string>,
  };
  for (let i = 1; i <= 5; i++) await qqAdapter.send!(msg, `第${i}条`);
  await assert.rejects(qqAdapter.send!(msg, "第6条"), /at most 5 replies/);
  assert.deepEqual(sentTo("/v2/users/U5/messages").map((b) => b.msg_seq), [1, 2, 3, 4, 5]);
});

await test("http: web_search via DeepSeek tool API", async () => {
  const { reply } = await httpCall("搜索 DeepSeek V4", "search");
  const search = calls.find((c) => c.url.endsWith("/v1/tools/search"))!;
  assert.equal(search.headers.get("authorization"), "Bearer ds-key");
  assert.deepEqual(search.body, { query: "DeepSeek V4", count: 5 });
  assert.ok(reply!.includes("https://example.com/v4"), "search results reach the model");
});

await test("http: sync reply, /reset hides everything before it", async () => {
  assert.equal((await httpCall("first", "rst")).reply, "答案是 20");
  assert.equal((await httpCall("/reset", "rst")).reply, "已清空本会话的历史记录。");
  await httpCall("after", "rst");
  const input = llmRequests().at(-1)!.body.input;
  assert.ok(!input.some((i: any) => i.role === "user" && /first/.test(textOf(i))), "nothing before /reset");
  assert.match(input[0].content, /\]\nafter$/);
  const stored = await events("http:rst");
  assert.equal(stored[0]!.type, "session/reset", "events before the reset were deleted");
});

await test("http: busy conversation → queued; the running turn picks the message up", async () => {
  const store = getStore();
  // Another run holds the chat: it took the lock with an earlier message.
  await store.ingest({
    chat: "http:busy",
    channel: "http",
    conversationId: "busy",
    chatType: "private",
    eventId: "earlier",
    direct: true,
    event: { type: "user/message", data: { eventId: "earlier", header: "h", text: "先来的", sender: "#A", mentioned: true, reply: {} } },
    reset: false,
    wake: true,
    ambientIntervalSeconds: 10,
    lockOwner: "someone-else",
    lockTtlMs: 60_000,
  });
  const res = await httpCall("排队", "busy");
  assert.deepEqual(res, { reply: null, messages: [], queued: true });
  assert.equal(llmCalls, 0);
  assert.equal((await events("http:busy")).at(-1)!.type, "user/message", "the message is in the log");
  await store.lock("http:busy", "someone-else", 0, "release");
});

// ── One run per chat ──
await test("concurrency: messages during a turn are seen at the next step; one model call at a time", async () => {
  let release!: () => void;
  gate = new Promise((r) => (release = r));
  await handleWebhook(c2c("k1", "慢慢算 (2+3)*4", "CONC"), "qq");
  // The first run is now waiting on the model; two more people write.
  await new Promise((r) => setTimeout(r, 20));
  await handleWebhook(c2c("k2", "顺便问个事", "CONC"), "qq");
  await new Promise((r) => setTimeout(r, 20));
  release();
  gate = undefined;
  await drain();
  assert.equal(maxInFlight, 1, "never two model calls for one chat at once");
  const step2 = llmRequests()[1]!.body.input;
  assert.match(textOf(step2.findLast((i: any) => i.role === "user")), /\]\n顺便问个事$/);
  assert.match(step2.at(-1).content, /^（系统提示）第1轮：你处理期间又来了 第\d+条（#CONC，@你）/);
  assert.equal(llmCalls, 2, "handled inside the same turn, no second run");
});

await test("lost lock: a run whose lease was taken over stops without writing or replying", async () => {
  let release!: () => void;
  gate = new Promise((r) => (release = r));
  await handleWebhook(c2c("ll1", "慢慢算 (2+3)*4", "LOST"), "qq");
  await new Promise((r) => setTimeout(r, 20)); // the run is now waiting on the model
  // Its lease runs out (renewals failed) and another run takes the chat.
  clockOffset += 61_000;
  assert.equal(await getStore().lock("qq:c2c:LOST", "thief", 60_000, "acquire"), true);
  const before = (await events("qq:c2c:LOST")).length;
  release();
  gate = undefined;
  await drain();
  clockOffset = 0;
  assert.equal(llmCalls, 1, "no further steps");
  assert.equal(sentTo("/v2/users/LOST/messages").length, 0, "nothing sent, not even the error apology");
  assert.equal((await events("qq:c2c:LOST")).length, before, "nothing appended by the old run");
});

await test("concurrency: two @ at once in a group → one run answers both", async () => {
  const at = (id: string, text: string, who: string) =>
    qqRequest({ op: 0, t: "GROUP_AT_MESSAGE_CREATE", d: { id, content: text, group_openid: "GPAIR", author: { member_openid: who } } });
  await Promise.all([handleWebhook(at("p1", " 问题一", "MA"), "qq"), handleWebhook(at("p2", " 问题二", "MB"), "qq")]);
  await drain();
  assert.equal(maxInFlight, 1);
  const turnStarts = (await events("qq:group:GPAIR")).filter((e) => e.type === "turn/start");
  const notes = llmRequests().map((r) => r.body.input.find((i: any) => i.role === "developer")?.content ?? "");
  assert.equal(turnStarts.length, 1, "both arrived before the run read the log: one turn");
  assert.ok(notes.some((n: string) => /待处理的消息：第0条（#MA，@你）、第1条（#MB，@你）/.test(n)));
});

// ── Full group messages (GROUP_MESSAGE_CREATE) ──
const groupMsg = (group: string, id: string, content: string, author: Record<string, unknown> = { member_openid: "MA", username: "老王" }) =>
  qqRequest({ op: 0, t: "GROUP_MESSAGE_CREATE", d: { id, content, group_openid: group, author } });
const groupAt = (group: string, id: string, content: string, author: Record<string, unknown> = { member_openid: "MB" }) =>
  qqRequest({ op: 0, t: "GROUP_AT_MESSAGE_CREATE", d: { id, content, group_openid: group, author } });
const userLines = (req: Call) => req.body.input.filter((i: any) => i.role === "user").map(textOf);

await test("qq group: ordinary messages logged; ≤1 ambient wake per window; ambient text not auto-sent; @ sees it all", async () => {
  await handleWebhook(groupMsg("GROUP3", "a1", "今天吃啥"), "qq");
  await drain();
  assert.equal(llmCalls, 2, "first ordinary message wakes an ambient turn");
  const ambient = llmRequests()[0]!.body.input;
  assert.match(ambient.at(-1).content, /第1轮开始。待处理的消息：第0条（老王 #MA）。.*这些消息都没 @ 你/);
  assert.match(ambient[0].content, /｜群聊｜发送人 老王 #MA\]\n今天吃啥$/, "no @你 marker, nickname shown");
  assert.equal(sentTo("/v2/groups/GROUP3/messages").length, 0, "ambient turn's plain text is not auto-sent");

  await handleWebhook(groupMsg("GROUP3", "a2", "火锅吧"), "qq");
  await drain();
  assert.equal(llmCalls, 2, "second message inside the window is only logged");

  await handleWebhook(groupAt("GROUP3", "a3", " 你觉得呢"), "qq");
  await drain();
  const direct = llmRequests()[2]!;
  const lines = userLines(direct);
  assert.deepEqual(lines.map((l: string) => l.split("\n")[1]), ["今天吃啥", "火锅吧", "你觉得呢"]);
  assert.match(lines[2]!, /｜@你\]\n你觉得呢$/);
  assert.match(direct.body.input.at(-1).content, /待处理的消息：第\d+条（老王 #MA）、第\d+条（#MB，@你）。发消息默认回复第\d+条/);
  assert.equal(sentTo("/v2/groups/GROUP3/messages").length, 1, "the @ is answered");
});

await test("cost: a silent ambient wake (model only hangs up) is a handful of store calls", async () => {
  // Each store call is one function call (one HTTP request) on Supabase.
  const store = getStore() as unknown as Record<string, (...args: any[]) => Promise<unknown>>;
  const counts: Record<string, number> = {};
  const originals: Record<string, any> = {};
  for (const name of ["ingest", "open", "append", "trim", "lock", "claimAmbient", "beginTurn", "setCursor", "getReply", "putReply", "putImage", "getImages"]) {
    originals[name] = store[name];
    store[name] = async (...args: any[]) => {
      counts[name] = (counts[name] ?? 0) + 1;
      return originals[name]!.apply(store, args);
    };
  }
  try {
    await handleWebhook(groupMsg("GQUIET", "q1", "路过"), "qq");
    await drain();
  } finally {
    Object.assign(store, originals);
  }
  assert.equal(llmCalls, 1);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`  silent ambient wake: ${total} store calls ${JSON.stringify(counts)}`);
  assert.equal(counts.ingest, 1, "ingest de-duplicates, logs and takes the lock in one call");
  assert.ok(total <= 12, `${total} calls`);
});

await test("qq group: one message as both full and @ events → logged once, answered once", async () => {
  await handleWebhook(groupMsg("GROUP4", "b1", "<@!102000000> 在吗", { member_openid: "MC" }), "qq");
  await handleWebhook(groupAt("GROUP4", "b1", " 在吗", { member_openid: "MC" }), "qq");
  await drain();
  assert.equal(llmCalls, 2, "one turn");
  assert.equal(sentTo("/v2/groups/GROUP4/messages").length, 1);
  assert.equal((await events("qq:group:GROUP4")).filter((e) => e.type === "user/message").length, 1);
});

await test("qq group: a bare @ (no text) is still answered", async () => {
  await handleWebhook(groupAt("GROUP7", "e1", " "), "qq");
  await drain();
  assert.match(userLines(llmRequests()[0]!).at(-1), /｜@你\]\n（只 @ 了你，没说话）$/);
  assert.equal(sentTo("/v2/groups/GROUP7/messages").length, 1);
  await handleWebhook(groupMsg("GROUP7", "e2", " "), "qq");
  await drain();
  assert.equal(sentTo("/v2/groups/GROUP7/messages").length, 1, "an empty ordinary message is ignored");
});

await test("qq group: other bots ignored; AGENT_AMBIENT_INTERVAL_SECONDS=0 logs without waking the agent", async () => {
  process.env.AGENT_AMBIENT_INTERVAL_SECONDS = "0";
  await handleWebhook(groupMsg("GROUP5", "c1", "hello"), "qq");
  await handleWebhook(groupMsg("GROUP5", "c2", "我是机器人", { member_openid: "BOT", bot: true }), "qq");
  await drain();
  assert.equal(llmCalls, 0);
  delete process.env.AGENT_AMBIENT_INTERVAL_SECONDS;
  await handleWebhook(groupAt("GROUP5", "c3", " 刚才说啥了"), "qq");
  await drain();
  assert.deepEqual(userLines(llmRequests()[0]!).map((l: string) => l.split("\n")[1]), ["hello", "刚才说啥了"]);
});

// ── Attachments ──
const c2cWith = (id: string, content: string, attachments: unknown[]) =>
  qqRequest({ op: 0, t: "C2C_MESSAGE_CREATE", d: { id, content, attachments, author: { user_openid: "IMGUSER" } } });

await test("qq image: stored once, replayed in later turns (detail low)", async () => {
  await handleWebhook(c2cWith("i1", "这是啥", [{ content_type: "image/png", url: "//multimedia.nt.qq.com.cn/a.png" }]), "qq");
  await drain();
  assert.ok(calls.some((c) => c.url === "https://multimedia.nt.qq.com.cn/a.png"), "// URL normalized to https and fetched");
  const msg = llmRequests()[0]!.body.input[0];
  assert.match(msg.content[0].text, /｜私聊｜发送人 #MGUSER\]\n这是啥\n\[图片\]$/);
  assert.deepEqual(msg.content[1], { type: "input_image", image_url: "data:image/png;base64,iVBORw==", detail: "low" });

  // The next run on this (warm) instance reads only the new image from the store.
  const store = getStore() as unknown as { getImages(keys: string[]): Promise<Record<string, string>> };
  const getImages = store.getImages;
  const asked: string[][] = [];
  store.getImages = (keys) => (asked.push(keys), getImages.call(store, keys));
  try {
    await handleWebhook(c2cWith("i2", "", [{ content_type: "image/jpeg", url: "https://multimedia.nt.qq.com.cn/b.jpg" }]), "qq");
    await drain();
  } finally {
    store.getImages = getImages;
  }
  const input = llmRequests().at(-2)!.body.input;
  assert.deepEqual(input[0], msg, "the earlier image is still there, byte for byte");
  assert.equal(calls.filter((c) => c.url.endsWith("/a.png")).length, 1, "downloaded once");
  assert.deepEqual(asked.flat().filter((k) => k.includes(":i1:")), [], "the earlier image came from the instance's cache");
});

await test("qq image: download failure tells the model instead of failing the turn", async () => {
  await handleWebhook(c2cWith("i3", "看看", [{ content_type: "image/png", url: "https://multimedia.nt.qq.com.cn/missing.png" }]), "qq");
  await drain();
  const msg = llmRequests()[0]!.body.input.findLast((i: any) => i.role === "user");
  assert.match(textOf(msg), /看看\n（有图片没加载出来）$/);
  assert.equal(sentTo("/v2/users/IMGUSER/messages").length, 1, "still replies");
  assert.equal(calls.filter((c) => c.url.endsWith("/missing.png")).length, 1, "a 404 is not retried: the link is gone");
});

await test("qq image: a slow or failing CDN gets one more try", async () => {
  await handleWebhook(c2cWith("i4", "再看", [{ content_type: "image/png", url: "https://multimedia.nt.qq.com.cn/flaky.png" }]), "qq");
  await drain();
  assert.equal(calls.filter((c) => c.url.endsWith("/flaky.png")).length, 2, "503, then OK");
  const msg = llmRequests()[0]!.body.input.findLast((i: any) => i.role === "user");
  assert.doesNotMatch(textOf(msg), /没加载出来/);
  assert.ok(msg.content.some((p: any) => p.type === "input_image"), "the image reaches the model");
});

await test("qq voice/video/file: voice uses QQ's transcript, others become placeholders", async () => {
  await handleWebhook(
    qqRequest({
      op: 0,
      t: "C2C_MESSAGE_CREATE",
      d: {
        id: "v1",
        content: "",
        author: { user_openid: "VOICE" },
        attachments: [
          { content_type: "voice", url: "//x/v.silk", asr_refer_text: "你好呀" },
          { content_type: "video/mp4", url: "//x/v.mp4" },
          { content_type: "file", url: "//x/f", filename: "报告.pdf" },
        ],
      },
    }),
    "qq",
  );
  await drain();
  assert.match(llmRequests()[0]!.body.input[0].content, /\n\[语音\] 你好呀\n\[视频\]\n\[文件：报告\.pdf\]$/);
});

// ── Compaction, recovery, hand-off ──
await test("compaction: past 80% of the context, older events become a summary (cache-friendly call), then deleted", async () => {
  await httpCall("first", "cmp");
  await httpCall("second", "cmp");
  process.env.AGENT_CONTEXT_TOKENS = "100";
  fakeInputTokens = 90;
  try {
    calls.length = 0;
    const { reply } = await httpCall("搜索 天气", "cmp");
    assert.ok(reply);
    const [step1, summarize, step2] = llmRequests().map((r) => r.body);
    // The summary call replays the start of the request just made, plus one instruction.
    assert.match(textOf(summarize!.input.at(-1)), /对话压缩器/);
    assert.deepEqual(summarize!.input.slice(0, -1), step1!.input.slice(0, summarize!.input.length - 1));
    assert.equal(summarize!.instructions, step1!.instructions);
    // The next request starts from the summary.
    assert.match(step2!.input[0].content, /^（系统提示）以下是更早对话的摘要.*\n摘要：大家聊过天气和算术。$/);
    assert.ok(!step2!.input.some((i: any) => i.role === "user" && /\]\nfirst$/.test(textOf(i))), "summarized messages are gone");
    const stored = await events("http:cmp");
    assert.ok(!stored.some((e) => e.type === "user/message" && e.data.text === "first"), "deleted from the store");
    assert.ok(stored.some((e) => e.type === "compaction/summary"));
    assert.ok(stored[0]!.seq > 0, "seq numbering continues after deletion");
  } finally {
    delete process.env.AGENT_CONTEXT_TOKENS;
    fakeInputTokens = undefined;
  }
});

await test("recovery: a turn cut off mid-tool is closed with interrupted results, not rewritten", async () => {
  const store = getStore();
  await store.ingest({
    chat: "http:crash",
    channel: "http",
    conversationId: "crash",
    chatType: "private",
    eventId: "x0",
    direct: true,
    event: { type: "user/message", data: { eventId: "x0", header: "h", text: "跑个长任务", sender: "#A", mentioned: true, reply: {} } },
    reset: false,
    wake: true,
    ambientIntervalSeconds: 10,
    lockOwner: "crashed-run",
    lockTtlMs: 60_000,
  });
  await store.append(
    "http:crash",
    "crashed-run",
    [
    { type: "turn/start", data: { turn: 1, trigger: "direct" } },
    { type: "step/start", data: { turn: 1, step: 1 } },
    { type: "assistant/message", data: { turn: 1, step: 1, output: [fnCall("call_long", "calculate", { expression: "1" })] } },
    { type: "tool/call", data: { turn: 1, step: 1, callId: "call_long", name: "calculate" } },
    ],
  );
  await store.lock("http:crash", "crashed-run", 0, "release"); // its lease ran out
  await httpCall("还在吗", "crash");
  const stored = await events("http:crash");
  const fix = stored.find((e) => e.type === "tool/result" && e.data.callId === "call_long")!;
  assert.equal(fix.data.interrupted, true);
  assert.match(fix.data.output, /may or may not have taken effect/);
  const at = stored.indexOf(fix);
  assert.deepEqual(
    stored.slice(at, at + 3).map((e) => [e.type, e.data.reason]),
    [["tool/result", undefined], ["step/end", undefined], ["turn/end", "interrupted"]],
  );
  const input = llmRequests()[0]!.body.input;
  assert.ok(input.some((i: any) => i.type === "function_call_output" && i.call_id === "call_long"), "the request stays valid");
});

await test("hand-off: out of time with work left → signed call to /api/worker, which carries on", async () => {
  process.env.AGENT_MAX_DURATION_SECONDS = "100"; // below the time a new turn needs
  const original = worker!;
  worker = async (req) => {
    delete process.env.AGENT_MAX_DURATION_SECONDS; // the fresh function has its full budget
    return original(req);
  };
  try {
    await handleWebhook(c2c("h1", "接力一下", "HANDOFF"), "qq");
    await drain();
  } finally {
    worker = original;
    delete process.env.AGENT_MAX_DURATION_SECONDS;
  }
  const handOff = calls.find((c) => c.url === "https://bot.example.com/api/worker")!;
  assert.deepEqual(handOff.body, { chatKey: "qq:c2c:HANDOFF" });
  assert.match(handOff.headers.get("x-worker-signature")!, /^[0-9a-f]{64}$/);
  assert.deepEqual(sentTo("/v2/users/HANDOFF/messages").map((b) => b.msg_id), ["h1"], "answered by the worker's run");
  const forged = await handleWorker(new Request("https://bot.example.com/api/worker", { method: "POST", body: '{"chatKey":"qq:c2c:HANDOFF"}', headers: { "x-worker-signature": "00" } }));
  assert.equal(forged.status, 401);
});

// ── Tools ──
await test("memory: remember / recall / forget on Upstash Vector, shared across chats", async () => {
  assert.ok(!activeTools().some((t) => t.name === "remember"), "off without credentials");
  process.env.UPSTASH_VECTOR_REST_URL = "https://vector.example.com/";
  process.env.UPSTASH_VECTOR_REST_TOKEN = "vec-token";
  try {
    const groupCtx = { ...noCtx, chat: { key: "qq:group:G1", scene: "群聊" as const, sender: "老王 #3B6834" } };
    const saved = await runTool("remember", JSON.stringify({ content: "#3B6834 叫老王，是前端程序员" }), groupCtx);
    const id = /id (m_\w+)/.exec(saved)![1]!;
    const upsert = calls.find((c) => c.url === "https://vector.example.com/upsert-data")!;
    assert.equal(upsert.headers.get("authorization"), "Bearer vec-token");
    assert.deepEqual({ ...upsert.body.metadata, at: "" }, { at: "", chat: "qq:group:G1", scene: "群聊", by: "老王 #3B6834" });
    await runTool("remember", JSON.stringify({ content: "这个群在聊考研" }), groupCtx);
    const hits = JSON.parse(await runTool("recall", JSON.stringify({ query: "老王是做什么的", limit: 1 }), noCtx));
    assert.equal(hits.length, 1);
    assert.equal(hits[0].memory, "#3B6834 叫老王，是前端程序员");
    assert.equal(hits[0].same_chat, false);
    assert.equal(JSON.parse(await runTool("recall", '{"query":"老王"}', groupCtx))[0].same_chat, true);
    assert.equal(await runTool("forget", JSON.stringify({ ids: [id] }), noCtx), "deleted 1");
    assert.match(await runTool("remember", JSON.stringify({ content: "x".repeat(501) }), noCtx), /^Error: too long/);
  } finally {
    delete process.env.UPSTASH_VECTOR_REST_URL;
    delete process.env.UPSTASH_VECTOR_REST_TOKEN;
  }
});

/** In-memory stand-in for a sandbox with the chat's drive mounted. */
function fakeWorkspaces() {
  const opened: string[] = [];
  let closed = 0;
  const files = new Map<string, Buffer>();
  setWorkspaceFactory(async (chatKey) => {
    opened.push(chatKey);
    return {
      async run(command, timeoutSeconds) {
        if (command === "sleep 999") return { exitCode: 124, output: "partial" };
        return { exitCode: 0, output: `ran: ${command} (limit ${timeoutSeconds}s)` };
      },
      async write(file, content) {
        files.set(file, Buffer.from(content));
      },
      async read(file) {
        return files.get(file) ?? null;
      },
      async close() {
        closed++;
      },
    };
  });
  return { opened, files, closed: () => closed };
}

await test("workspace: bash / write_file / read_file share one sandbox per run", async () => {
  assert.ok(!activeTools().some((t) => t.name === "bash"), "off without Vercel credentials");
  process.env.SANDBOX_ENABLED = "1";
  try {
    const ws = fakeWorkspaces();
    const ctx = { ...noCtx, images: [] };
    assert.equal(await runTool("write_file", '{"path":"notes/a.md","content":"你好"}', ctx), "wrote /workspace/notes/a.md (6 bytes)");
    assert.equal(await runTool("read_file", '{"path":"/workspace/notes/a.md"}', ctx), "你好");
    assert.equal(await runTool("bash", '{"command":"ls"}', ctx), "exit 0\nran: ls (limit 60s)");
    assert.equal(await runTool("bash", '{"command":"sleep 999"}', ctx), "timed out after 60s\npartial");
    assert.match(await runTool("read_file", '{"path":"nope.txt"}', ctx), /^Error: \/workspace\/nope.txt not found/);
    ws.files.set("/workspace/a.bin", Buffer.from([1, 0, 2]));
    assert.match(await runTool("read_file", '{"path":"a.bin"}', ctx), /binary file \(3 bytes\)/);
    assert.deepEqual(ws.opened, ["http:c0"], "one sandbox for the whole run");
    assert.match(driveName("qq:group:ABC"), /^chat-[0-9a-f]{20}$/);
    assert.notEqual(driveName("qq:group:ABC"), driveName("qq:group:ABD"));
  } finally {
    delete process.env.SANDBOX_ENABLED;
  }
});

await test("workspace: read_file shows an image to the model, kept in the log; the sandbox stops after the run", async () => {
  process.env.SANDBOX_ENABLED = "1";
  try {
    const ws = fakeWorkspaces();
    ws.files.set("/workspace/out/plot.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const res = await httpCall("读图", "c-img");
    assert.equal(res.reply, "看到了");
    const second = llmRequests()[1]!.body.input;
    assert.match(second.find((i: any) => i.type === "function_call_output").output, /image \/workspace\/out\/plot.png \(4 bytes\)/);
    const shown = second.at(-1);
    assert.equal(shown.role, "user");
    assert.deepEqual(shown.content[1], { type: "input_image", image_url: "data:image/png;base64,iVBORw==", detail: "auto" });
    assert.deepEqual(ws.opened, ["http:c-img"]);
    assert.equal(ws.closed(), 1, "sandbox stopped when the run ended");
    await httpCall("1+1", "c-img");
    assert.ok(llmRequests().at(-1)!.body.input.some((i: any) => i.role === "user" && i.content[1]?.detail === "auto"), "replayed in the next turn");
  } finally {
    delete process.env.SANDBOX_ENABLED;
  }
});

await test("workspace: bash time limit shrinks near the function's deadline, leaving 15s to reply", async () => {
  process.env.SANDBOX_ENABLED = "1";
  try {
    fakeWorkspaces();
    const at = (seconds: number) => ({ ...noCtx, images: [], deadline: Date.now() + seconds * 1000 });
    assert.equal(await runTool("bash", '{"command":"ls"}', at(300)), "exit 0\nran: ls (limit 60s)");
    assert.match(await runTool("bash", '{"command":"ls"}', at(40)), /\(limit 19s\)$|\(limit 20s\)$/);
    assert.match(await runTool("bash", '{"command":"ls"}', at(20)), /^Error: no time left in this turn/);
  } finally {
    delete process.env.SANDBOX_ENABLED;
  }
});

await test("send_file: QQ uploads the bytes (file_data) with the right file_type, then sends msg_type 7", async () => {
  process.env.SANDBOX_ENABLED = "1";
  try {
    const ws = fakeWorkspaces();
    ws.files.set("/workspace/report.pdf", Buffer.from("%PDF-1"));
    ws.files.set("/workspace/out/plot.png", Buffer.from([0x89, 0x50]));
    await handleWebhook(c2c("f1", "发文件 report.pdf", "FILEUSER"), "qq");
    await drain();
    await handleWebhook(c2c("f2", "发文件 out/plot.png", "FILEUSER"), "qq");
    await drain();
    const uploads = calls.filter((c) => c.url.endsWith("/v2/users/FILEUSER/files"));
    assert.deepEqual(uploads[0]!.body, { file_type: 4, file_name: "report.pdf", file_data: Buffer.from("%PDF-1").toString("base64"), srv_send_msg: false });
    assert.equal(uploads[1]!.body.file_type, 1);
    assert.deepEqual(sentTo("/v2/users/FILEUSER/messages")[0], { msg_type: 7, media: { file_info: "FILEINFO" }, msg_id: "f1", msg_seq: 1 });
    assert.equal(llmRequests().length, 2, "send_file + end_turn: one model call per message");
  } finally {
    delete process.env.SANDBOX_ENABLED;
  }
});

await test("save_attachment: a QQ attachment's original is logged, then curled into the workspace", async () => {
  process.env.SANDBOX_ENABLED = "1";
  try {
    const runs: string[] = [];
    setWorkspaceFactory(async () => ({
      async run(command) {
        runs.push(command);
        return { exitCode: 0, output: "2840113" };
      },
      async write() {
        throw new Error("curl worked; nothing to write");
      },
      read: async () => null,
      close: async () => {},
    }));
    await handleWebhook(
      qqRequest({
        op: 0,
        t: "C2C_MESSAGE_CREATE",
        d: {
          id: "att1",
          content: "存附件 0",
          author: { user_openid: "ATTUSER" },
          attachments: [{ content_type: "file", url: "//multimedia.nt.qq.com.cn/download?fileid=abc", filename: "retouch 1.jpg" }],
        },
      }),
      "qq",
    );
    await drain();
    const logged = (await events("qq:c2c:ATTUSER")).find((e) => e.type === "user/message")!;
    assert.equal(logged.seq, 0);
    assert.deepEqual(logged.data.attachments, [{ name: "retouch 1.jpg", url: "https://multimedia.nt.qq.com.cn/download?fileid=abc", contentType: "file" }]);
    assert.match(llmRequests()[0]!.body.input[0].content, /\n\[文件：retouch 1\.jpg\]$/, "the model still sees the placeholder");
    assert.equal(runs.length, 1);
    assert.ok(
      runs[0]!.includes(`curl -fsSL --retry 2 -o '/workspace/inbox/0-retouch 1.jpg' 'https://multimedia.nt.qq.com.cn/download?fileid=abc'`),
      runs[0],
    );
    const out = llmRequests()[1]!.body.input.find((i: any) => i.type === "function_call_output").output;
    assert.equal(out, "saved /workspace/inbox/0-retouch 1.jpg (2840113 bytes, file)");
  } finally {
    delete process.env.SANDBOX_ENABLED;
  }
});

await test("save_attachment: downloads it itself when the sandbox can't; bad numbers and expired links", async () => {
  process.env.SANDBOX_ENABLED = "1";
  try {
    const written = new Map<string, Buffer>();
    setWorkspaceFactory(async () => ({
      run: async () => ({ exitCode: 6, output: "curl: (6) Could not resolve host: multimedia.nt.qq.com.cn" }),
      async write(file, content) {
        written.set(file, Buffer.from(content));
      },
      read: async () => null,
      close: async () => {},
    }));
    const atts = [
      { name: "", url: "https://multimedia.nt.qq.com.cn/ok.png", contentType: "image/png" },
      { name: "../../etc/passwd", url: "https://multimedia.nt.qq.com.cn/missing", contentType: "file" },
    ];
    const ctx = { ...noCtx, images: [], attachments: (seq: number) => (seq === 7 ? atts : seq === 8 ? [] : undefined) };
    const out = await runTool("save_attachment", '{"message":7}', ctx);
    assert.equal(out.split("\n")[0], "saved /workspace/inbox/7-attachment-1.png (4 bytes, image/png)");
    assert.match(out.split("\n")[1]!, /^could not save attachment 2: sandbox: curl: \(6\) Could not resolve host.*; direct: HTTP 404 \(the link may have expired/);
    assert.deepEqual([...written.entries()], [["/workspace/inbox/7-attachment-1.png", Buffer.from([0x89, 0x50, 0x4e, 0x47])]]);
    assert.match(await runTool("save_attachment", '{"message":7,"index":2}', ctx), /^Error: could not save attachment 2/);
    assert.match(await runTool("save_attachment", '{"message":7,"index":3}', ctx), /^Error: 第7条 has 2 attachment\(s\); index is 1 to 2/);
    assert.match(await runTool("save_attachment", '{"message":8}', ctx), /^Error: 第8条 has no attachments/);
    assert.match(await runTool("save_attachment", '{"message":9}', ctx), /^Error: 第9条 isn't a message in this chat/);
    assert.equal(attachmentFileName(3, 1, atts[1]!), "3-passwd", "no path tricks");
    assert.equal(attachmentFileName(3, 0, { name: "a'b; rm -rf ~.jpg", url: "", contentType: "" }), "3-a_b_ rm -rf _.jpg");
  } finally {
    delete process.env.SANDBOX_ENABLED;
  }
});

await test("generate_image: workspace references become data URLs; results capped at 1080p, saved and shown", async () => {
  process.env.SANDBOX_ENABLED = "1";
  process.env.IMAGE_API_KEY = "img-key";
  process.env.IMAGE_BASE_URL = "https://img.example.com/api/v1";
  const sharp = (await import("sharp")).default;
  try {
    const ws = fakeWorkspaces();
    ws.files.set("/workspace/inbox/5-photo.jpg", await sharp({ create: { width: 40, height: 30, channels: 3, background: "#cc9966" } }).jpeg().toBuffer());
    const big = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: "#336699" } }).png().toBuffer();
    imageResponse = () => Response.json({ created: 1, data: [{ b64_json: big.toString("base64"), media_type: "image/png" }], usage: { cost: 0.011 } });
    assert.ok(activeTools().some((t) => t.name === "generate_image"));
    const ctx = { ...noCtx, images: [] as import("../src/media/images.js").ImagePart[] };
    const out = await runTool(
      "generate_image",
      JSON.stringify({ prompt: "暖金胶片氛围", input_references: ["inbox/5-photo.jpg", "https://example.com/style.png"], aspect_ratio: "3:2" }),
      ctx,
    );
    const req = calls.find((c) => c.url === "https://img.example.com/api/v1/images")!;
    assert.equal(req.headers.get("authorization"), "Bearer img-key");
    assert.equal(req.body.model, "openai/gpt-image-2.5-sunburst");
    assert.equal(req.body.quality, "low");
    assert.equal(req.body.resolution, "1K");
    assert.equal(req.body.aspect_ratio, "3:2");
    assert.equal(req.body.n, undefined, "the API's default unless asked");
    assert.equal(req.body.input_references[0].type, "image_url");
    assert.match(req.body.input_references[0].image_url.url, /^data:image\/jpeg;base64,\/9j\//, "a workspace file sent as a data URL");
    assert.deepEqual(req.body.input_references[1], { type: "image_url", image_url: { url: "https://example.com/style.png" } });
    const saved = [...ws.files.keys()].find((k) => k.startsWith("/workspace/images/"))!;
    assert.match(saved, /^\/workspace\/images\/\d{8}-\d{6}-1\.png$/);
    const meta = await sharp(ws.files.get(saved)!).metadata();
    assert.deepEqual([meta.width, meta.height], [1620, 1080], "2400x1600 scaled down to fit 1080p");
    assert.match(out, /^generated 1 image\(s\), cost \$0\.011/);
    assert.ok(out.includes(`${saved} (1620x1080, `), out);
    assert.equal(ctx.images.length, 1, "shown to the model");
    assert.match(ctx.images[0]!.image_url, /^data:image\/jpeg;base64,/);

    assert.match(await runTool("generate_image", '{"prompt":"x","input_references":["nope.png"]}', ctx), /^Error: reference \/workspace\/nope.png not found/);
    assert.match(await runTool("generate_image", '{"prompt":"x","n":11}', ctx), /^Error: n is 1 to 10/);
    imageResponse = () => Response.json({ error: { message: "rejected by the safety system" } }, { status: 400 });
    assert.match(await runTool("generate_image", '{"prompt":"x"}', ctx), /^Error: image API HTTP 400: .*safety system/);
  } finally {
    delete process.env.SANDBOX_ENABLED;
    delete process.env.IMAGE_API_KEY;
    delete process.env.IMAGE_BASE_URL;
    imageResponse = undefined;
  }
  assert.ok(!activeTools().some((t) => t.name === "generate_image"), "off without IMAGE_API_KEY");
});

await test("send_file: missing file, size limit, and channels that can't send files", async () => {
  process.env.SANDBOX_ENABLED = "1";
  try {
    const ws = fakeWorkspaces();
    ws.files.set("/workspace/big.bin", Buffer.alloc(5 * 1024 * 1024 + 1));
    assert.match(await runTool("send_file", '{"path":"nope.txt"}', noCtx), /^Error: \/workspace\/nope.txt not found/);
    assert.match(await runTool("send_file", '{"path":"big.bin"}', noCtx), /over the 5 MB limit/);
    ws.files.set("/workspace/a.txt", Buffer.from("hi"));
    const res = await httpCall("发文件 a.txt", "c-file");
    assert.match(res.reply!, /^结果：not ended: a message failed to send/);
    const outputs = llmRequests()[1]!.body.input.filter((i: any) => i.type === "function_call_output");
    assert.match(outputs.find((o: any) => o.call_id === "call_f").output, /^Error: the http channel can't send files/);
  } finally {
    delete process.env.SANDBOX_ENABLED;
  }
});

await test("end_turn: talking alone doesn't end the turn, end_turn does", async () => {
  const res = await httpCall("搜索 天气", "c-end");
  assert.match(res.reply!, /^答案是 /);
  assert.ok(llmRequests().every((r) => r.body.tool_choice === "required"));
  await httpCall("连发", "c-end2");
  assert.equal(llmRequests().length, 3);
});

await test("end_turn: wherever it sits, every call in the step still runs, in order; then the turn ends", async () => {
  const ran: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => {
    const m = /^\[agent\] tool (\w+)/.exec(String(args[0]));
    if (m) ran.push(m[1]!);
    log(...args);
  };
  try {
    assert.equal((await httpCall("先挂", "c-order")).reply, "第一条\n第二条");
  } finally {
    console.log = log;
  }
  assert.deepEqual(ran, ["send_message", "calculate", "send_message"]);
  assert.equal(llmRequests().length, 1);
  const results = (await events("http:c-order")).filter((e) => e.type === "tool/result").map((e) => e.data.callId);
  assert.deepEqual(results, ["call_1", "call_c", "call_2", "call_e"], "every call has its result in the log");
});

await test("step limit: the last step gets a wrap-up note and must send", async () => {
  process.env.AGENT_MAX_STEPS = "3";
  try {
    assert.equal((await httpCall("死循环", "c-steps")).reply, "做到一半");
    const reqs = llmRequests();
    assert.equal(reqs.length, 3);
    const last = reqs[2]!.body;
    assert.deepEqual(last.tool_choice, { type: "function", name: "send_message" });
    assert.equal(reqs[1]!.body.tool_choice, "required");
    assert.match(last.input.at(-1).content, /^（系统提示）第\d+轮：步数用完了，这是最后一步：必须现在用 send_message 发一条消息/);
    assert.ok(!reqs[1]!.body.input.some((i: any) => i.role === "developer" && /最后一步/.test(i.content)));
    assert.equal((await events("http:c-steps")).at(-1)!.data.reason, "max-steps");
  } finally {
    delete process.env.AGENT_MAX_STEPS;
  }
});

await test("time limit: close to the function's deadline, the next step is the last", async () => {
  process.env.AGENT_MAX_DURATION_SECONDS = "200";
  try {
    // The first model call "takes" 120s, leaving 80s (< 90s reserve).
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const res = await original(input, init);
      if (String(input instanceof Request ? input.url : input).endsWith("/responses") && llmCalls === 1) clockOffset += 120_000;
      return res;
    }) as typeof fetch;
    try {
      assert.equal((await httpCall("死循环", "c-time")).reply, "做到一半");
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(llmRequests().length, 2);
    assert.match(llmRequests()[1]!.body.input.at(-1).content, /^（系统提示）第\d+轮：时间快用完了/);
  } finally {
    delete process.env.AGENT_MAX_DURATION_SECONDS;
    clockOffset = 0;
  }
});

await test("unknown channel → 404", async () => {
  assert.equal((await handleWebhook(new Request("http://x/api/webhook/nope", { method: "POST" }), "nope")).status, 404);
});

await pgBackend?.client.end();
console.log(`\n${passed} tests passed`);
process.exit(0);
