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
import type { Tool } from "./tools.js";

const MAX_CHARS = 500;
const TIMEOUT_MS = 15_000;

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
    "Save one fact to your long-term memory, shared across every chat you're in. Use it for things worth knowing " +
    "next time: who someone is (their #ID and what they told you about themselves), preferences, running jokes, " +
    "promises, what a group is about. One self-contained fact per call, written so it makes sense out of context " +
    '(e.g. "#3B6834 叫老王，是前端程序员，最怕被叫秃头"). Don\'t save trivia or one-off chatter.',
  parameters: {
    type: "object",
    properties: { content: { type: "string", description: `The fact, at most ${MAX_CHARS} characters.` } },
    required: ["content"],
  },
  enabled,
  async run(args, ctx) {
    const content = String(args.content ?? "").trim();
    if (!content) throw new Error("content is empty");
    if (content.length > MAX_CHARS) throw new Error(`too long (${content.length} > ${MAX_CHARS} characters); shorten it`);
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
    "something from the past, or when someone asks \"还记得…吗\". Returns the closest memories (score 0–1, higher " +
    "is closer; the nearest hits can still be unrelated, so judge by content), when and where each was saved, and " +
    "same_chat=true when it came from this chat.",
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
