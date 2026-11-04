/**
 * Offline end-to-end test: `npm test`.
 * Stubs global fetch (Responses API, DeepSeek tools, QQ, Telegram) and Vercel's
 * waitUntil, then drives each channel through the real webhook handler and agent loop.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.OPENROUTER_API_KEY = "test-key";
process.env.OPENROUTER_BASE_URL = "https://gw.example.com/api/v1/";
process.env.OPENROUTER_MODEL = "openai/gpt-6-luna";
process.env.OPENROUTER_EXTRA_BODY = '{"provider":{"only":["openai"],"allow_fallbacks":false},"max_output_tokens":2000}';
process.env.OPENROUTER_EXTRA_HEADERS = '{"X-Title":"selftest"}';
process.env.DEEPSEEK_API_KEY = "ds-key";
process.env.QQ_APP_ID = "102000000";
process.env.QQ_APP_SECRET = "naOC0ocQE3shWLAfffVLB1rhYPG7";
process.env.TELEGRAM_BOT_TOKEN = "123:abc";
process.env.TELEGRAM_WEBHOOK_SECRET = "tg-secret";
process.env.HTTP_CHANNEL_TOKEN = "http-secret";
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.KV_REST_API_URL;
for (const name of ["UPSTASH_VECTOR_REST_URL", "UPSTASH_VECTOR_REST_TOKEN", "VERCEL", "VERCEL_OIDC_TOKEN", "SANDBOX_ENABLED"]) {
  delete process.env[name];
}

// ── Capture waitUntil promises ──
const pending: Promise<unknown>[] = [];
(globalThis as Record<symbol, unknown>)[Symbol.for("@vercel/request-context")] = {
  get: () => ({ waitUntil: (p: Promise<unknown>) => pending.push(p) }),
};
const drain = async () => {
  await Promise.all(pending.splice(0));
};

// ── Stub fetch ──
interface Call {
  url: string;
  body: any;
  headers: Headers;
}
const calls: Call[] = [];
let llmCalls = 0;

const textMessage = (text: string) => ({
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
});
const sendCall = (callId: string, text: string) => ({
  type: "function_call",
  id: `fc_${callId}`,
  call_id: callId,
  name: "send_message",
  arguments: JSON.stringify({ text }),
});

/** Minimal Upstash REST emulator: POST / with one command, POST /pipeline with many. */
const redis = new Map<string, string | string[]>();
function runRedis([cmd, key, ...args]: string[]): unknown {
  const list = () => (redis.get(key!) as string[] | undefined) ?? [];
  const at = (i: number, len: number) => (i < 0 ? len + i : i);
  switch (cmd) {
    case "SET":
      if (args.includes("NX") && redis.has(key!)) return null;
      redis.set(key!, args[0]!);
      return "OK";
    case "RPUSH":
      redis.set(key!, [...list(), ...args]);
      return list().length;
    case "LTRIM": {
      const l = list();
      redis.set(key!, l.slice(at(Number(args[0]), l.length), at(Number(args[1]), l.length) + 1));
      return "OK";
    }
    case "LRANGE": {
      const l = list();
      return l.slice(at(Number(args[0]), l.length), at(Number(args[1]), l.length) + 1);
    }
    case "EXPIRE":
      return 1;
    case "DEL":
      return redis.delete(key!) ? 1 : 0;
    default:
      return { error: `unknown command ${cmd}` };
  }
}
function fakeUpstash(url: string, body: any) {
  if (new URL(url).pathname === "/pipeline") return Response.json(body.map((c: string[]) => ({ result: runRedis(c) })));
  return Response.json({ result: runRedis(body) });
}

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

/**
 * Fake Responses API. First turn asks for a tool, second turn answers in plain
 * text (exercising the fallback). Messages containing "连发" use send_message twice.
 */
function fakeResponses(body: any) {
  llmCalls++;
  const toolOutput = body.input.findLast((i: any) => i.type === "function_call_output");
  // Drop the "[time｜scene｜sender]" header line the gateway prepends.
  const textOf = (m: any): string => (typeof m.content === "string" ? m.content : m.content.find((p: any) => p.type === "input_text").text);
  // Skip the "（系统提示）" message the loop adds after read_file opens an image.
  const lastUser = body.input.findLast((i: any) => i.role === "user" && !textOf(i).startsWith("（系统提示）"));
  const raw = textOf(lastUser);
  const userText = raw.split("\n").slice(1).join("\n");
  let output: unknown[];
  if (userText.includes("表情")) {
    output = toolOutput
      ? []
      : [{ type: "function_call", id: "fc_s", call_id: "call_s1", name: "send_sticker", arguments: JSON.stringify({ name: "红温了" }) }, sendCall("call_s2", "气死我了")];
  } else if (userText.includes("连发")) {
    output = toolOutput
      ? [textMessage("这句是收尾文字，不应该被发出去")]
      : [sendCall("call_a", "第一条"), sendCall("call_b", "第二条")];
  } else if (userText.startsWith("先挂")) {
    // Hangs up first, then talks: everything in the step still runs, in order.
    const end = { type: "function_call", id: "fc_e", call_id: "call_e", name: "end_turn", arguments: "{}" };
    const search = { type: "function_call", id: "fc_w", call_id: "call_w", name: "web_search", arguments: '{"query":"x"}' };
    output = [end, sendCall("call_1", "第一条"), search, sendCall("call_2", "第二条")];
  } else if (userText.startsWith("死循环")) {
    // Keeps calling tools until the last-step note shows up, then reports (and tries one more tool).
    const last = body.input.at(-1);
    const calc = { type: "function_call", id: "fc_l", call_id: `call_l${llmCalls}`, name: "calculate", arguments: '{"expression":"1+1"}' };
    output = last.role === "developer" && last.content.includes("最后一步") ? [calc, sendCall("call_done", "做到一半")] : [calc];
  } else if (userText.startsWith("发文件")) {
    output = toolOutput
      ? [textMessage(`结果：${toolOutput.output}`)]
      : [{ type: "function_call", id: "fc_f", call_id: "call_f", name: "send_file", arguments: JSON.stringify({ path: userText.slice(3).trim() }) }];
  } else if (userText.startsWith("读图")) {
    output = toolOutput
      ? [textMessage("看到了")]
      : [{ type: "function_call", id: "fc_r", call_id: "call_r", name: "read_file", arguments: JSON.stringify({ path: "out/plot.png" }) }];
  } else if (toolOutput) {
    output = [{ type: "reasoning", id: "rs_2", summary: [] }, textMessage(`答案是 ${toolOutput.output}`)];
  } else {
    output = [
      { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc" },
      userText.startsWith("搜索")
        ? { type: "function_call", id: "fc_1", call_id: "call_s", name: "web_search", arguments: JSON.stringify({ query: userText.slice(2).trim() }) }
        : { type: "function_call", id: "fc_1", call_id: "call_1", name: "calculate", arguments: '{"expression":"(2+3)*4"}' },
    ];
  }
  const TALK = ["send_message", "send_sticker", "send_file"];
  if (output.length && output.every((o: any) => o.type === "function_call" && TALK.includes(o.name))) {
    output = [...output, { type: "function_call", id: "fc_end", call_id: `call_end${llmCalls}`, name: "end_turn", arguments: "{}" }];
  }
  return Response.json({
    id: "resp_1",
    object: "response",
    status: "completed",
    model: body.model,
    output,
    usage: { input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 3 } },
  });
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const req = new Request(input, init);
  const url = req.url;
  const text = await req.text();
  const body = text ? JSON.parse(text) : undefined;
  calls.push({ url, body, headers: req.headers });

  if (url === "https://gw.example.com/api/v1/responses") return fakeResponses(body);
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
        is_free_tier: false,
        effective_budget: { scope: "api_key", limit_usd: 20, spend_usd: 5.5, remaining_usd: 14.5, reset_interval: "monthly", resets_at: "2026-12-01T00:00:00Z" },
      },
    });
  }
  if (url.startsWith("https://redis.example.com")) return fakeUpstash(url, body);
  if (url.startsWith("https://vector.example.com/")) return fakeVector(url, req.method, body);
  if (url.startsWith("https://multimedia.nt.qq.com.cn/")) {
    if (url.includes("missing")) return new Response("gone", { status: 404 });
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

const { handleWebhook } = await import("../src/webhook.js");
const { evaluate, activeTools, runTool } = await import("../src/agent/tools.js");
const { messageHeader } = await import("../src/agent/handle.js");
const qqHint = (await import("../src/channels/qq.js")).qqAdapter.promptHint!;
const { config } = await import("../src/config.js");
const { setWorkspaceFactory, driveName } = await import("../src/agent/sandbox.js");

/** Tool context for calling tools directly, outside a conversation. */
const testChat = { key: "http:c0", scene: "私聊" as const, sender: "#USER01" };
const noCtx = {
  sent: [] as string[],
  send: async () => {},
  sendSticker: async () => {},
  sendFile: async () => {},
  deadline: Number.POSITIVE_INFINITY,
  chat: testChat,
  images: [],
};

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
  return new Request("http://localhost/api/webhook/qq", { method: "POST", headers, body });
}

const httpCall = (text: string, conversationId = "c1") =>
  handleWebhook(
    new Request("http://localhost/api/webhook/http", {
      method: "POST",
      headers: { authorization: "Bearer http-secret" },
      body: JSON.stringify({ conversationId, text }),
    }),
    "http",
  ).then((r) => r.json() as Promise<{ reply: string }>);

const llmRequests = () => calls.filter((c) => c.url.endsWith("/responses"));

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  calls.length = 0;
  llmCalls = 0;
  await fn();
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
  assert.equal(config.openrouter.baseUrl, "https://gw.example.com/api/v1");
  const saved = process.env.OPENROUTER_EXTRA_BODY;
  process.env.OPENROUTER_EXTRA_BODY = "{bad";
  assert.throws(() => config.openrouter.extraBody, /OPENROUTER_EXTRA_BODY is not valid JSON/);
  process.env.OPENROUTER_EXTRA_BODY = "[1]";
  assert.throws(() => config.openrouter.extraBody, /must be a JSON object/);
  process.env.OPENROUTER_EXTRA_BODY = saved;
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
  assert.equal(out.limit_remaining, 14.5);
  assert.deepEqual(out.usage, { today: 0.3, this_week: 1.2, this_month: 5.5, all_time: 5.5 });
  assert.equal(out.effective_budget.remaining, 14.5);
});

await test("qq: op13 callback validation", async () => {
  const res = await handleWebhook(qqRequest({ op: 13, d: { plain_token: "abc", event_ts: "123" } }, false), "qq");
  const data = (await res.json()) as { plain_token: string; signature: string };
  assert.equal(data.plain_token, "abc");
  assert.ok(crypto.verify(null, Buffer.from("123abc"), keys.publicKey, Buffer.from(data.signature, "hex")));
});

await test("qq: rejects bad signature", async () => {
  const req = qqRequest({ op: 0, t: "C2C_MESSAGE_CREATE", d: { id: "m0", content: "hi", author: { user_openid: "u" } } });
  req.headers.set("x-signature-ed25519", "00".repeat(64));
  assert.equal((await handleWebhook(req, "qq")).status, 401);
});

await test("qq: c2c → ACK, Responses API tool loop, passive reply", async () => {
  const event = { op: 0, id: "C2C_MESSAGE_CREATE:1", t: "C2C_MESSAGE_CREATE", d: { id: "msg-1", content: " 算一下 (2+3)*4 ", author: { user_openid: "USER1" } } };
  const res = await handleWebhook(qqRequest(event), "qq");
  assert.deepEqual(await res.json(), { op: 12, d: 0 });
  await drain();

  assert.equal(llmCalls, 2, "tool round-trip = 2 model calls");
  const [first, second] = llmRequests();
  assert.equal(first!.headers.get("authorization"), "Bearer test-key");
  assert.equal(first!.headers.get("x-title"), "selftest");
  assert.equal(first!.body.model, "openai/gpt-6-luna");
  assert.deepEqual(first!.body.provider, { only: ["openai"], allow_fallbacks: false }, "extra body passed through");
  assert.equal(first!.body.max_output_tokens, 2000);
  assert.ok(first!.body.instructions.startsWith("# 角色设定"), "built-in persona prompt");
  assert.ok(first!.body.instructions.endsWith(qqHint), "channel hint appended");
  assert.equal(first!.body.input.length, 1);
  assert.match(first!.body.input[0].content, /^\[\d{4}\/\d{2}\/\d{2}.* Asia\/Shanghai｜私聊｜发送人 #USER1\]\n算一下 \(2\+3\)\*4$/);
  assert.equal(first!.body.tools[0].type, "function");
  assert.equal(first!.body.tools[0].name, "send_message");

  // Stateless replay: reasoning + function_call echoed back, then the output.
  assert.deepEqual(
    second!.body.input.slice(1).map((i: any) => i.type),
    ["reasoning", "function_call", "function_call_output"],
  );
  assert.equal(second!.body.input[1].encrypted_content, "enc");
  assert.deepEqual(second!.body.input[3], { type: "function_call_output", call_id: "call_1", output: "20" });

  const sent = calls.find((c) => c.url.includes("/v2/users/USER1/messages"))!;
  assert.equal(sent.headers.get("authorization"), "QQBot qq-token");
  assert.deepEqual(sent.body, { content: "答案是 20", msg_type: 0, msg_id: "msg-1", msg_seq: 1 });
});

await test("qq: send_message twice in one step → two passive replies, turn ends without a 2nd model call", async () => {
  const event = { op: 0, t: "C2C_MESSAGE_CREATE", d: { id: "msg-2", content: "连发两条", author: { user_openid: "USER1" } } };
  await handleWebhook(qqRequest(event), "qq");
  await drain();
  const sent = calls.filter((c) => c.url.includes("/v2/users/USER1/messages")).map((c) => c.body);
  assert.deepEqual(sent, [
    { content: "第一条", msg_type: 0, msg_id: "msg-2", msg_seq: 1 },
    { content: "第二条", msg_type: 0, msg_id: "msg-2", msg_seq: 2 },
  ]);
  assert.equal(llmCalls, 1, "a step that only talks ends the turn");
});

await test("stickers: CDN hotlink by default, STICKER_BASE_URL override", async () => {
  const { STICKERS, stickerUrl, DEFAULT_STICKER_BASE_URL } = await import("../src/agent/stickers.js");
  assert.ok(Object.keys(STICKERS).length >= 30);
  // GIFs are 512px originals; static memes use the 512px previews so sizes match in chat.
  assert.ok(Object.values(STICKERS).every((s) => /^(meme\/\d+\.gif|0_preview\/meme\/\d+\.webp)$/.test(s.file)));
  assert.equal(stickerUrl(DEFAULT_STICKER_BASE_URL, "红温了"), "https://img.aigengtu.com/meme/3153.gif");
  assert.equal(stickerUrl(DEFAULT_STICKER_BASE_URL, "得加钱"), "https://img.aigengtu.com/0_preview/meme/097.webp");
  assert.equal(stickerUrl("https://my.cdn/s/", "得加钱"), "https://my.cdn/s/0_preview/meme/097.webp");
});

await test("qq: send_sticker → upload by URL, msg_type 7, then text with next msg_seq", async () => {
  const event = { op: 0, t: "C2C_MESSAGE_CREATE", d: { id: "msg-3", content: "来个表情", author: { user_openid: "USER1" } } };
  await handleWebhook(qqRequest(event), "qq");
  await drain();
  const upload = calls.find((c) => c.url === "https://api.sgroup.qq.com/v2/users/USER1/files")!;
  assert.deepEqual(upload.body, { file_type: 1, url: "https://img.aigengtu.com/meme/3153.gif", srv_send_msg: false });
  const sent = calls.filter((c) => c.url.endsWith("/v2/users/USER1/messages")).map((c) => c.body);
  assert.deepEqual(sent, [
    { msg_type: 7, media: { file_info: "FILEINFO" }, msg_id: "msg-3", msg_seq: 1 },
    { content: "气死我了", msg_type: 0, msg_id: "msg-3", msg_seq: 2 },
  ]);
});

await test("telegram: GIF sticker goes through sendAnimation", async () => {
  const update = { update_id: 10, message: { message_id: 6, text: "表情来", chat: { id: 42, type: "private" }, from: { id: 7 } } };
  await handleWebhook(
    new Request("https://bot.example.com/api/webhook/telegram", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "tg-secret" },
      body: JSON.stringify(update),
    }),
    "telegram",
  );
  await drain();
  const anim = calls.find((c) => c.url.endsWith("/sendAnimation"))!;
  assert.equal(anim.body.animation, "https://img.aigengtu.com/meme/3153.gif");
  assert.equal(anim.body.reply_parameters.message_id, 6, "first message quotes the user");
  assert.equal(calls.find((c) => c.url.endsWith("/sendMessage"))!.body.reply_parameters, undefined);
});

await test("http: sticker degrades to a text line; history records it", async () => {
  const { messages } = (await (
    await handleWebhook(
      new Request("http://localhost/api/webhook/http", {
        method: "POST",
        headers: { authorization: "Bearer http-secret", "x-forwarded-host": "qqbot.example.cn", "x-forwarded-proto": "https" },
        body: JSON.stringify({ conversationId: "stk", text: "表情" }),
      }),
      "http",
    )
  ).json()) as { messages: string[] };
  assert.deepEqual(messages, ["[表情包：红温了] https://img.aigengtu.com/meme/3153.gif", "气死我了"]);
  await httpCall("next", "stk");
  const prevAssistant = llmRequests().at(-1)!.body.input[1];
  assert.deepEqual(prevAssistant, { role: "assistant", content: "[表情包：红温了]\n气死我了" });
});

await test("send_message: per-turn limit", async () => {
  const ctx = { ...noCtx, sent: ["1", "2", "3", "4", "5"] };
  assert.match(await runTool("send_message", '{"text":"6"}', ctx), /^Error: already sent 5 messages/);
  assert.match(await runTool("send_message", '{"text":"  "}', noCtx), /^Error: text is empty/);
});

await test("message header: time, scene, sender, @你", () => {
  const base = { channel: "qq", eventId: "e", conversationId: "g", text: "hi", replyContext: {} };
  const now = new Date("2026-11-03T12:43:00Z");
  assert.match(
    messageHeader({ ...base, chatType: "group", userId: "5f0ee621a747e4683b6834" }, now),
    /^\[2026\/11\/03.*20:43 Asia\/Shanghai｜群聊｜发送人 #3B6834｜@你\]$/,
  );
  assert.match(
    messageHeader({ ...base, chatType: "group", mode: "ambient", userId: "5f0ee621a747e4683b6834", senderName: "老王" }, now),
    /｜群聊｜发送人 老王 #3B6834\]$/,
  );
  assert.match(
    messageHeader({ ...base, chatType: "private", userId: "7", senderName: "Alice" }, now),
    /｜私聊｜发送人 Alice #7\]$/,
  );
});

await test("upstash store: claim, append with batched trim, list tail, del", async () => {
  const { UpstashStore } = await import("../src/store/index.js");
  const store = new UpstashStore("https://redis.example.com/", "rd-token");

  assert.equal(await store.claim("evt:x", 60), true);
  assert.equal(await store.claim("evt:x", 60), false, "second claim (webhook retry) is rejected");

  // keep=4 → may grow to floor(4 × 1.25) = 5 before trimming back to 4.
  await store.append("chat:k", ["a", "b", "c"], 4, 600);
  await store.append("chat:k", ["d", "e"], 4, 600);
  assert.deepEqual(await store.list("chat:k"), ["a", "b", "c", "d", "e"], "within slack: no trim yet");
  const pipe = calls.findLast((c) => c.url === "https://redis.example.com/pipeline")!;
  assert.equal(pipe.headers.get("authorization"), "Bearer rd-token");
  assert.deepEqual(pipe.body, [["RPUSH", "chat:k", "d", "e"], ["EXPIRE", "chat:k", "600"]], "no LTRIM on normal writes");

  await store.append("chat:k", ["f"], 4, 600);
  assert.deepEqual(await store.list("chat:k"), ["c", "d", "e", "f"], "over slack: trimmed back to the newest 4");
  assert.deepEqual(await store.list("chat:k", 2), ["e", "f"], "list(key, n) reads only the tail");

  await store.del("chat:k");
  assert.deepEqual(await store.list("chat:k"), []);
});

await test("qq: retried event is de-duplicated", async () => {
  const event = { op: 0, t: "C2C_MESSAGE_CREATE", d: { id: "msg-1", content: "again", author: { user_openid: "USER1" } } };
  await handleWebhook(qqRequest(event), "qq");
  await drain();
  assert.equal(llmCalls, 0);
});

await test("qq: group @ message replies to group", async () => {
  const event = { op: 0, t: "GROUP_AT_MESSAGE_CREATE", d: { id: "g-1", content: " hi", group_openid: "GROUP1", author: { member_openid: "M1" } } };
  await handleWebhook(qqRequest(event), "qq");
  await drain();
  assert.ok(calls.some((c) => c.url.endsWith("/v2/groups/GROUP1/messages") && c.body.msg_id === "g-1"));
});

await test("qq reply window: group 5 min, c2c 60 min (from the message timestamp)", async () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const groupMsgs = () => calls.filter((c) => c.url.endsWith("/v2/groups/GROUP2/messages"));
  const userMsgs = () => calls.filter((c) => c.url.endsWith("/v2/users/USER9/messages"));

  // Group message from 6 minutes ago: past the 5-minute window, so nothing is posted to QQ.
  await handleWebhook(qqRequest({ op: 0, t: "GROUP_AT_MESSAGE_CREATE", d: { id: "g-old", content: "hi", timestamp: minutesAgo(6), group_openid: "GROUP2", author: { member_openid: "M2" } } }), "qq");
  await drain();
  assert.equal(groupMsgs().length, 0, "expired group reply is not sent");
  const toolOut = llmRequests().at(-1)!.body.input.find((i: any) => i.type === "function_call_output");
  assert.ok(toolOut, "model still ran");

  // Group message from 4 minutes ago: still inside the window.
  await handleWebhook(qqRequest({ op: 0, t: "GROUP_AT_MESSAGE_CREATE", d: { id: "g-new", content: "hi", timestamp: minutesAgo(4), group_openid: "GROUP2", author: { member_openid: "M2" } } }), "qq");
  await drain();
  assert.equal(groupMsgs().length, 1);

  // C2C message from 30 minutes ago is fine (60-minute window); 61 minutes is not.
  await handleWebhook(qqRequest({ op: 0, t: "C2C_MESSAGE_CREATE", d: { id: "c-30", content: "hi", timestamp: minutesAgo(30), author: { user_openid: "USER9" } } }), "qq");
  await handleWebhook(qqRequest({ op: 0, t: "C2C_MESSAGE_CREATE", d: { id: "c-61", content: "hi", timestamp: minutesAgo(61), author: { user_openid: "USER9" } } }), "qq");
  await drain();
  assert.deepEqual(userMsgs().map((c) => c.body.msg_id), ["c-30"]);
});

await test("qq: 5 replies per message, the 6th is refused before calling QQ", async () => {
  const { qqAdapter } = await import("../src/channels/qq.js");
  const msg = {
    channel: "qq", eventId: "e", conversationId: "c2c:U", chatType: "private" as const, userId: "U", text: "x",
    replyContext: { scope: "c2c", target: "U5", msgId: "m-5", expiresAt: String(Date.now() + 60_000) } as Record<string, string>,
  };
  for (let i = 1; i <= 5; i++) await qqAdapter.send!(msg, `第${i}条`);
  await assert.rejects(qqAdapter.send!(msg, "第6条"), /at most 5 replies/);
  const seqs = calls.filter((c) => c.url.endsWith("/v2/users/U5/messages")).map((c) => c.body.msg_seq);
  assert.deepEqual(seqs, [1, 2, 3, 4, 5]);
});

await test("telegram: secret check + reply", async () => {
  const update = { update_id: 9, message: { message_id: 5, text: "hello", chat: { id: 42, type: "private" }, from: { id: 7 } } };
  const bad = new Request("http://localhost/api/webhook/telegram", { method: "POST", body: JSON.stringify(update) });
  assert.equal((await handleWebhook(bad, "telegram")).status, 401);

  const good = new Request("http://localhost/api/webhook/telegram", {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": "tg-secret" },
    body: JSON.stringify(update),
  });
  assert.equal((await handleWebhook(good, "telegram")).status, 200);
  await drain();
  const sent = calls.find((c) => c.url.endsWith("/sendMessage"))!;
  assert.equal(sent.body.chat_id, "42");
  assert.ok(calls.some((c) => c.url.endsWith("/sendChatAction")));
});

await test("http: web_search via DeepSeek tool API", async () => {
  const { reply } = await httpCall("搜索 DeepSeek V4", "search");
  const search = calls.find((c) => c.url.endsWith("/v1/tools/search"))!;
  assert.equal(search.headers.get("authorization"), "Bearer ds-key");
  assert.deepEqual(search.body, { query: "DeepSeek V4", count: 5 });
  assert.ok(reply.includes("https://example.com/v4"), "search results reach the model");
});

await test("http: sync reply, history kept, /reset", async () => {
  assert.equal((await httpCall("first")).reply, "答案是 20");
  await httpCall("second");
  const [prevUser, prevAssistant] = llmRequests().at(-1)!.body.input;
  assert.equal(prevUser.role, "user");
  assert.match(prevUser.content, /｜私聊｜发送人 #NYMOUS\]\nfirst$/, "history keeps the header line");
  assert.deepEqual(prevAssistant, { role: "assistant", content: "答案是 20" });
  assert.equal((await httpCall("/reset")).reply, "已清空本会话的历史记录。");
});

// ── Full group messages (GROUP_MESSAGE_CREATE) ──
const groupMsg = (group: string, id: string, content: string, author: Record<string, unknown> = { member_openid: "MA", username: "老王" }) =>
  qqRequest({ op: 0, t: "GROUP_MESSAGE_CREATE", d: { id, content, group_openid: group, author } });
const groupAt = (group: string, id: string, content: string, author: Record<string, unknown> = { member_openid: "MB" }) =>
  qqRequest({ op: 0, t: "GROUP_AT_MESSAGE_CREATE", d: { id, content, group_openid: group, author } });
const sentTo = (group: string) => calls.filter((c) => c.url.endsWith(`/v2/groups/${group}/messages`));
const userLines = (req: Call) => req.body.input.filter((i: any) => i.role === "user").map((i: any) => i.content as string);

await test("qq group: ordinary messages recorded; ≤1 ambient run per window; ambient text not auto-sent; @ sees it all", async () => {
  await handleWebhook(groupMsg("GROUP3", "a1", "今天吃啥"), "qq");
  await drain();
  assert.equal(llmCalls, 2, "first ordinary message is sampled into an ambient run");
  const ambient = llmRequests()[0]!;
  assert.equal(ambient.body.input.at(-1).role, "developer");
  assert.match(ambient.body.input.at(-1).content, /没人 @ 你/);
  assert.match(ambient.body.input.at(-2).content, /｜群聊｜发送人 老王 #MA\]\n今天吃啥$/, "no @你 marker, nickname shown");
  assert.equal(sentTo("GROUP3").length, 0, "ambient run's plain text is not auto-sent");

  await handleWebhook(groupMsg("GROUP3", "a2", "火锅吧"), "qq");
  await drain();
  assert.equal(llmCalls, 2, "second message inside the window is only recorded");

  await handleWebhook(groupAt("GROUP3", "a3", " 你觉得呢"), "qq");
  await drain();
  const direct = llmRequests()[2]!;
  const lines = userLines(direct);
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /今天吃啥$/);
  assert.match(lines[1]!, /火锅吧$/);
  assert.match(lines[2]!, /｜@你\]\n你觉得呢$/);
  assert.match(direct.body.input.at(-1).content, /#MB 刚 @ 了你：「你觉得呢」/);
  assert.equal(sentTo("GROUP3").length, 1, "the @ is answered");
});

await test("qq group: one message as both full and @ events → recorded once, answered once", async () => {
  // Full event first, carrying the <@!AppID> marker → treated as direct.
  await handleWebhook(groupMsg("GROUP4", "b1", "<@!102000000> 在吗", { member_openid: "MC" }), "qq");
  await handleWebhook(groupAt("GROUP4", "b1", " 在吗", { member_openid: "MC" }), "qq");
  await drain();
  assert.equal(llmCalls, 2, "one agent run");
  assert.deepEqual(userLines(llmRequests()[0]!).length, 1);
  assert.equal(sentTo("GROUP4").length, 1);

  // @ event first, then the full event without a marker → the full one is dropped.
  await handleWebhook(groupAt("GROUP4", "b2", " 早", { member_openid: "MC" }), "qq");
  await handleWebhook(groupMsg("GROUP4", "b2", "早", { member_openid: "MC" }), "qq");
  await drain();
  assert.equal(llmCalls, 4, "still one run for b2");
  const lines = userLines(llmRequests()[2]!);
  assert.equal(lines.filter((l: string) => /\n早$/.test(l)).length, 1, "b2 recorded once");
});

await test("qq group: a bare @ (no text) is still answered", async () => {
  await handleWebhook(groupAt("GROUP7", "e1", " "), "qq");
  await drain();
  assert.ok(llmCalls >= 1, "agent ran");
  assert.match(userLines(llmRequests()[0]!).at(-1), /｜@你\]\n（只 @ 了你，没说话）$/);
  assert.equal(sentTo("GROUP7").length, 1);

  // An ordinary message with nothing in it is still ignored.
  await handleWebhook(groupMsg("GROUP7", "e2", " "), "qq");
  await drain();
  assert.equal(sentTo("GROUP7").length, 1);
});

await test("qq group: other bots ignored; AGENT_AMBIENT_INTERVAL_SECONDS=0 records without running the agent", async () => {
  process.env.AGENT_AMBIENT_INTERVAL_SECONDS = "0";
  await handleWebhook(groupMsg("GROUP5", "c1", "hello"), "qq");
  await handleWebhook(groupMsg("GROUP5", "c2", "我是机器人", { member_openid: "BOT", bot: true }), "qq");
  await drain();
  assert.equal(llmCalls, 0);
  delete process.env.AGENT_AMBIENT_INTERVAL_SECONDS;

  await handleWebhook(groupAt("GROUP5", "c3", " 刚才说啥了"), "qq");
  await drain();
  const lines = userLines(llmRequests()[0]!);
  assert.deepEqual(lines.map((l: string) => l.split("\n")[1]), ["hello", "刚才说啥了"], "bot message not recorded");
});

// ── Attachments ──
const c2cWith = (id: string, content: string, attachments: unknown[]) =>
  qqRequest({ op: 0, t: "C2C_MESSAGE_CREATE", d: { id, content, attachments, author: { user_openid: "IMGUSER" } } });

await test("qq image: downloaded, sent to the model inline (detail low); history keeps [图片]", async () => {
  await handleWebhook(c2cWith("i1", "这是啥", [{ content_type: "image/png", url: "//multimedia.nt.qq.com.cn/a.png" }]), "qq");
  await drain();
  assert.ok(calls.some((c) => c.url === "https://multimedia.nt.qq.com.cn/a.png"), "// URL normalized to https and fetched");
  const msg = llmRequests()[0]!.body.input.at(-1);
  assert.equal(msg.role, "user");
  assert.match(msg.content[0].text, /｜私聊｜发送人 #MGUSER\]\n这是啥\n\[图片\]$/);
  assert.deepEqual(msg.content[1], { type: "input_image", image_url: "data:image/png;base64,iVBORw==", detail: "low" });

  // Image-only message, next turn: the earlier image is a text placeholder in history.
  await handleWebhook(c2cWith("i2", "", [{ content_type: "image/jpeg", url: "https://multimedia.nt.qq.com.cn/b.jpg" }]), "qq");
  await drain();
  // First model call of the second turn (each turn here is tool call + answer = 2 calls).
  const input = llmRequests()[2]!.body.input;
  assert.equal(typeof input.find((i: any) => i.role === "user").content, "string", "past image is text only");
  assert.match(input.find((i: any) => i.role === "user").content, /这是啥\n\[图片\]$/);
  assert.equal(input.at(-1).content[1].type, "input_image", "image-only message still runs the agent");
});

await test("qq image: download failure tells the model instead of failing the turn", async () => {
  await handleWebhook(c2cWith("i3", "看看", [{ content_type: "image/png", url: "https://multimedia.nt.qq.com.cn/missing.png" }]), "qq");
  await drain();
  const msg = llmRequests()[0]!.body.input.at(-1);
  assert.equal(msg.content.length, 1);
  assert.match(msg.content[0].text, /看看\n\[图片\]\n（图片没加载出来）$/);
  assert.equal(calls.filter((c) => c.url.endsWith("/v2/users/IMGUSER/messages")).length, 1, "still replies");
});

await test("qq voice/video/file: voice uses QQ's transcript, others become placeholders", async () => {
  await handleWebhook(
    c2cWith("v1", "", [
      { content_type: "voice", url: "//x/v.silk", asr_refer_text: "你好呀" },
      { content_type: "video/mp4", url: "//x/v.mp4" },
      { content_type: "file", url: "//x/f", filename: "报告.pdf" },
    ]),
    "qq",
  );
  await drain();
  const text: string = llmRequests()[0]!.body.input.at(-1).content;
  assert.match(text, /\n\[语音\] 你好呀\n\[视频\]\n\[文件：报告\.pdf\]$/);
});

await test("qq group image without @: sampled ambient run sees the pixels, history keeps [图片]", async () => {
  await handleWebhook(
    qqRequest({ op: 0, t: "GROUP_MESSAGE_CREATE", d: { id: "gi1", content: "", group_openid: "GROUP6", attachments: [{ content_type: "image/png", url: "https://multimedia.nt.qq.com.cn/c.png" }], author: { member_openid: "MZ" } } }),
    "qq",
  );
  await drain();
  assert.ok(calls.some((c) => c.url.endsWith("/c.png")), "downloaded");
  const users = llmRequests()[0]!.body.input.filter((i: any) => i.role === "user");
  assert.match(users.at(-1).content[0].text, /\n\[图片\]$/);
  assert.equal(users.at(-1).content[1].type, "input_image");
  assert.ok(users.slice(0, -1).every((u: any) => typeof u.content === "string"), "only the latest message has pixels");
});

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

    // Another chat sees the same memories, marked as not from here.
    const hits = JSON.parse(await runTool("recall", JSON.stringify({ query: "老王是做什么的", limit: 1 }), noCtx));
    assert.equal(hits.length, 1);
    assert.equal(hits[0].memory, "#3B6834 叫老王，是前端程序员");
    assert.equal(hits[0].scene, "群聊");
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

await test("workspace: read_file shows an image to the model; the sandbox stops after the run", async () => {
  process.env.SANDBOX_ENABLED = "1";
  try {
    const ws = fakeWorkspaces();
    ws.files.set("/workspace/out/plot.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const res = await httpCall("读图", "c-img");
    assert.equal(res.reply, "看到了");
    const second = llmRequests()[1]!.body.input;
    const output = second.find((i: any) => i.type === "function_call_output");
    assert.match(output.output, /image \/workspace\/out\/plot.png \(4 bytes\)/);
    const shown = second.at(-1);
    assert.equal(shown.role, "user");
    assert.deepEqual(shown.content[1], { type: "input_image", image_url: "data:image/png;base64,iVBORw==", detail: "auto" });
    assert.deepEqual(ws.opened, ["http:c-img"]);
    assert.equal(ws.closed(), 1, "sandbox stopped when the run ended");
    // The image isn't kept in history.
    await httpCall("1+1", "c-img");
    assert.ok(llmRequests().at(-1)!.body.input.every((i: any) => typeof i.content === "string" || i.type));
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
    assert.match(await runTool("bash", '{"command":"ls"}', at(40)), /\(limit 19s\)$|\(limit 20s\)$/); // 40 - 15 reply - 5 kill grace
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
    await handleWebhook(qqRequest({ op: 0, t: "C2C_MESSAGE_CREATE", d: { id: "f1", content: "发文件 report.pdf", author: { user_openid: "FILEUSER" } } }), "qq");
    await drain();
    await handleWebhook(qqRequest({ op: 0, t: "C2C_MESSAGE_CREATE", d: { id: "f2", content: "发文件 out/plot.png", author: { user_openid: "FILEUSER" } } }), "qq");
    await drain();
    const uploads = calls.filter((c) => c.url.endsWith("/v2/users/FILEUSER/files"));
    assert.deepEqual(uploads[0]!.body, { file_type: 4, file_name: "report.pdf", file_data: Buffer.from("%PDF-1").toString("base64"), srv_send_msg: false });
    assert.equal(uploads[1]!.body.file_type, 1);
    const sends = calls.filter((c) => c.url.endsWith("/v2/users/FILEUSER/messages"));
    assert.deepEqual(sends[0]!.body, { msg_type: 7, media: { file_info: "FILEINFO" }, msg_id: "f1", msg_seq: 1 });
    // send_file only delivers, so the turn ends there: one model call per message.
    assert.equal(llmRequests().length, 2);
  } finally {
    delete process.env.SANDBOX_ENABLED;
  }
});

await test("send_file: missing file, size limit, and channels that can't send files", async () => {
  process.env.SANDBOX_ENABLED = "1";
  try {
    const ws = fakeWorkspaces();
    ws.files.set("/workspace/big.bin", Buffer.alloc(5 * 1024 * 1024 + 1));
    assert.match(await runTool("send_file", '{"path":"nope.txt"}', noCtx), /^Error: \/workspace\/nope.txt not found/);
    assert.match(await runTool("send_file", '{"path":"big.bin"}', noCtx), /over the 5 MB limit/);
    ws.files.set("/workspace/a.txt", Buffer.from("hi"));
    // The send fails in the step that hangs up, so the turn goes on and the model sees the error.
    const res = await httpCall("发文件 a.txt", "c-file");
    assert.match(res.reply, /^结果：not ended: a message failed to send/);
    const outputs = llmRequests()[1]!.body.input.filter((i: any) => i.type === "function_call_output");
    assert.match(outputs.find((o: any) => o.call_id === "call_f").output, /^Error: the http channel can't send files/);
  } finally {
    delete process.env.SANDBOX_ENABLED;
  }
});

await test("end_turn: requests require a tool; talking alone doesn't end the turn, end_turn does", async () => {
  // "搜索" makes the fake model call web_search, then answer: without end_turn the loop keeps going.
  const res = await httpCall("搜索 天气", "c-end");
  assert.match(res.reply, /^答案是 /);
  assert.ok(llmRequests().every((r) => r.body.tool_choice === "required"));
  // "连发" sends two messages and hangs up in the same step: one model call.
  await httpCall("连发", "c-end2");
  assert.equal(llmRequests().length, 3);
});

await test("end_turn: position in the step doesn't matter; messages go out in order, other tools are skipped", async () => {
  const res = await httpCall("先挂", "c-order");
  assert.equal(res.reply, "第一条\n第二条");
  assert.equal(llmRequests().length, 1);
  assert.ok(!calls.some((c) => c.url.endsWith("/v1/tools/search")), "web_search skipped when hanging up");
});

await test("step limit: the last step gets a wrap-up note; only talk tools run in it", async () => {
  process.env.AGENT_MAX_STEPS = "3";
  try {
    const res = await httpCall("死循环", "c-steps");
    assert.equal(res.reply, "做到一半");
    const reqs = llmRequests();
    assert.equal(reqs.length, 3);
    const last = reqs[2]!.body;
    assert.equal(last.tool_choice, reqs[0]!.body.tool_choice, "the request itself is unchanged");
    assert.equal(last.tools.length, reqs[0]!.body.tools.length);
    assert.match(last.input.at(-1).content, /^（系统提示）步数用完了，这是最后一步.*send_message/);
    assert.equal(last.input.filter((i: any) => i.type === "function_call_output").length, 2);
    assert.ok(!reqs[1]!.body.input.some((i: any) => i.role === "developer"), "no note before the last step");
  } finally {
    delete process.env.AGENT_MAX_STEPS;
  }
});

await test("time limit: close to the function's deadline, the next step is the last", async () => {
  process.env.AGENT_MAX_DURATION_SECONDS = "60"; // < 90s reserve: the first step is already the last
  try {
    const res = await httpCall("死循环", "c-time");
    assert.equal(res.reply, "做到一半");
    assert.equal(llmRequests().length, 1);
    assert.match(llmRequests()[0]!.body.input.at(-1).content, /^（系统提示）时间快用完了/);
  } finally {
    delete process.env.AGENT_MAX_DURATION_SECONDS;
  }
});

await test("unknown channel → 404", async () => {
  assert.equal((await handleWebhook(new Request("http://x/api/webhook/nope", { method: "POST" }), "nope")).status, 404);
});

console.log(`\n${passed} tests passed`);
