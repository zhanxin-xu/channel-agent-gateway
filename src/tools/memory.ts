/**
 * Long-term memory on Upstash Vector (REST API), one store shared by every
 * chat. The index is created with a built-in embedding model, so we send raw
 * text (`/upsert-data`, `/query-data`) and need no embedding API of our own.
 *
 * Each memory keeps where it came from (chat, 私聊/群聊, who said it, when) as
 * metadata, so the model can tell a group fact from something said in private.
 */
import crypto from "node:crypto";
import { config } from "../config.js";
import type { Tool } from "./types.js";

const MAX_CHARS = 500;
const TIMEOUT_MS = 15_000;
/** Pronouns or placeholders that stay ambiguous even after the memory is recalled in a later turn. */
const VAGUE_REFERENCE = /^(?:他|她|它)|这(?:个)?人|那(?:个)?人|对方|某人|这(?:件|个)事|那(?:件|个)事/;
const HAS_SUBJECT = /#[0-9A-Za-z]{1,12}|这个群|本群|群里|全群/;

interface MemoryMetadata {
  at: string;
  chat: string;
  scene: string;
  by: string;
}

async function vectorApi<T>(path: string, body: unknown, method = "POST"): Promise<T> {
  const { url, token } = config.memory;
  const res = await fetch(`${url}/${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = (await res.json().catch(() => ({}))) as { result?: T; error?: string };
  if (!res.ok || data.error) throw new Error(`Upstash Vector ${path}: ${data.error ?? `HTTP ${res.status}`}`);
  return data.result as T;
}

const enabled = () => Boolean(config.memory.url && config.memory.token);

export const remember: Tool = {
  name: "remember",
  description:
    "Save one self-contained fact to your long-term memory, shared across every chat you're in. " +
    "Because memories are searched by text across all chats long after the conversation is gone, every memory MUST be a " +
    "complete, standalone archive entry that makes full sense on its own:\n" +
    '- Always write the subject\'s nickname and #ID explicitly (e.g. "老王 #3B6834", never bare pronouns like "他" / "她" / "我" / "这人").\n' +
    '- Turn relative time ("今天" / "下周" / "今年") into concrete dates or years from the message header (e.g. "2026年11月").\n' +
    '- Pack the whole fact into one rich sentence instead of saving fragments (Good: "老王 #3B6834 是前端程序员，养了只英短叫煤球，最怕被叫秃头"; Bad: "他是前端" or "他说考不上研就洗头").\n' +
    "- When updating something you already recalled, remember the merged fact and forget the old fragmented id.",
  parameters: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description:
          `One complete, standalone fact (at most ${MAX_CHARS} characters). Must name people by "昵称 #ID" with no ambiguous pronouns (他/她/你/我/这人).`,
      },
    },
    required: ["content"],
  },
  enabled,
  async run(args, ctx) {
    const content = String(args.content ?? "").trim();
    if (!content) throw new Error("content is empty");
    if (content.length > MAX_CHARS) throw new Error(`too long (${content.length} > ${MAX_CHARS} characters); shorten it`);
    if (!HAS_SUBJECT.test(content) || VAGUE_REFERENCE.test(content)) {
      throw new Error(
        'memory is missing a clear subject/#ID or uses vague references (他/她/这人/对方/这件事…), so it will be useless when recalled later; rewrite it as a standalone fact with the person\'s nickname and #ID (e.g. "老王 #3B6834 在 2026年11月立下 flag：考不上研就倒立洗头")',
      );
    }
    const id = `m_${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
    const metadata: MemoryMetadata = { at: new Date().toISOString(), chat: ctx.chat.key, scene: ctx.chat.scene, by: ctx.chat.sender };
    await vectorApi("upsert-data", { id, data: content, metadata });
    return `remembered (id ${id})`;
  },
};

export const recall: Tool = {
  name: "recall",
  description:
    "Search your long-term memory (shared across all chats) by meaning. Use it before answering about a person, " +
    'something from the past, or when someone asks "还记得…吗". Include the person\'s nickname and #ID in `query` when ' +
    "looking up a person. Returns the closest memories (score 0–1, higher is closer; the nearest hits can still be " +
    "unrelated, so judge by content), when and where each was saved, and same_chat=true when it came from this chat. " +
    "If you spot old memories that are fragmented, outdated, or missing a #ID, consolidate them with remember and delete the old ids with forget.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to look for, in natural language." },
      limit: { type: "integer", minimum: 1, maximum: 10, description: "How many results (default 5)." },
    },
    required: ["query"],
  },
  enabled,
  async run(args, ctx) {
    const query = String(args.query ?? "").trim();
    if (!query) throw new Error("query is empty");
    const topK = Math.min(Math.max(Number(args.limit) || 5, 1), 10);
    const hits = await vectorApi<Array<{ id: string; score: number; data?: string; metadata?: MemoryMetadata }>>(
      "query-data",
      { data: query, topK, includeMetadata: true, includeData: true },
    );
    if (!hits.length) return "no memories yet";
    return JSON.stringify(
      hits.map((h) => ({
        id: h.id,
        score: Math.round(h.score * 100) / 100,
        memory: h.data,
        saved: h.metadata?.at?.slice(0, 10),
        scene: h.metadata?.scene,
        by: h.metadata?.by,
        same_chat: h.metadata?.chat === ctx.chat.key,
      })),
    );
  },
};

export const forget: Tool = {
  name: "forget",
  description: "Delete memories by id (from recall), e.g. when a fact turned out wrong or someone asks you to forget it.",
  parameters: {
    type: "object",
    properties: { ids: { type: "array", items: { type: "string" }, description: "Memory ids to delete." } },
    required: ["ids"],
  },
  enabled,
  async run(args) {
    const ids = Array.isArray(args.ids) ? args.ids.map(String).filter(Boolean) : [];
    if (!ids.length) throw new Error("ids is empty");
    const result = await vectorApi<{ deleted: number }>("delete", { ids }, "DELETE");
    return `deleted ${result.deleted}`;
  },
};
