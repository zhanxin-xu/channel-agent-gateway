/**
 * Tools the agent can call. Add one by appending to `tools`: a JSON-schema
 * definition the model sees, and a `run` function that returns a string.
 */
import { llmKeyLimit, searchBalance } from "./account-tools.js";
import type { OutgoingFile } from "../channels/types.js";
import type { ImagePart } from "./images.js";
import { MAX_MESSAGES_PER_TURN } from "./limits.js";
import { forget, recall, remember } from "./memory.js";
import { bash, readFile, sendFile, writeFile } from "./sandbox.js";
import { isStickerName, STICKER_NAMES, STICKERS, type StickerName } from "./stickers.js";
import { webFetch, webSearch } from "./web-tools.js";

/** Per-message context handed to tools. */
export interface ToolContext {
  /** Messages already delivered to the chat this turn (stickers as "[表情包：name]"). */
  sent: string[];
  /** Deliver one chat message now (and record it in `sent`). */
  send(text: string): Promise<void>;
  /** Deliver one sticker now (and record it in `sent`). */
  sendSticker(name: StickerName): Promise<void>;
  /** Deliver one file now (and record it in `sent`); throws when the channel can't send files. */
  sendFile(file: OutgoingFile): Promise<void>;
  /** When the function will be killed (epoch ms). Long-running tools stop early enough for a reply. */
  deadline: number;
  /** The chat this run belongs to: memory metadata and the per-chat workspace. */
  chat: { key: string; scene: "群聊" | "私聊"; sender: string };
  /** Images a tool wants the model to see; the loop shows them after the step's tool outputs. */
  images: ImagePart[];
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Hide the tool from the model when its backing service isn't configured. */
  enabled?(): boolean;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> | string;
}

export { MAX_MESSAGES_PER_TURN };

const sendMessage: Tool = {
  name: "send_message",
  description:
    "Send one chat message right now. This is how your words reach the chat: each call is a separate message, " +
    `so call it several times to send a few short messages in a row (max ${MAX_MESSAGES_PER_TURN} per turn). ` +
    "When you're done talking, end your turn without writing any other text.",
  parameters: {
    type: "object",
    properties: { text: { type: "string", description: "The message text (plain text)." } },
    required: ["text"],
  },
  async run(args, ctx) {
    const text = String(args.text ?? "").trim();
    if (!text) throw new Error("text is empty");
    if (ctx.sent.length >= MAX_MESSAGES_PER_TURN) {
      throw new Error(`already sent ${MAX_MESSAGES_PER_TURN} messages this turn, the limit; end your turn now`);
    }
    await ctx.send(text);
    return `sent (${ctx.sent.length}/${MAX_MESSAGES_PER_TURN}). If you're done, end your turn without writing any text.`;
  },
};

const sendSticker: Tool = {
  name: "send_sticker",
  description:
    "Send one 大肥鱼 sticker (an image) right now, as its own message. It counts toward the same " +
    `${MAX_MESSAGES_PER_TURN}-messages-per-turn limit as send_message. Pick by mood:\n` +
    STICKER_NAMES.map((n) => `- ${n}：${STICKERS[n].when}`).join("\n"),
  parameters: {
    type: "object",
    properties: { name: { type: "string", enum: STICKER_NAMES, description: "Sticker name." } },
    required: ["name"],
  },
  async run(args, ctx) {
    const name = String(args.name ?? "");
    if (!isStickerName(name)) throw new Error(`unknown sticker "${name}"`);
    if (ctx.sent.length >= MAX_MESSAGES_PER_TURN) {
      throw new Error(`already sent ${MAX_MESSAGES_PER_TURN} messages this turn, the limit; end your turn now`);
    }
    await ctx.sendSticker(name);
    return `sticker sent (${ctx.sent.length}/${MAX_MESSAGES_PER_TURN}). If you're done, end your turn without writing any text.`;
  },
};

const getCurrentTime: Tool = {
  name: "get_current_time",
  description: "Get the current date and time, optionally in a given IANA time zone.",
  parameters: {
    type: "object",
    properties: {
      timezone: { type: "string", description: 'IANA time zone, e.g. "Asia/Shanghai". Defaults to UTC.' },
    },
  },
  run(args) {
    const timeZone = typeof args.timezone === "string" && args.timezone ? args.timezone : "UTC";
    const formatted = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      dateStyle: "full",
      timeStyle: "long",
    }).format(new Date());
    return JSON.stringify({ timezone: timeZone, now: formatted, iso: new Date().toISOString() });
  },
};

const calculate: Tool = {
  name: "calculate",
  description: "Evaluate an arithmetic expression with + - * / % ^ and parentheses. Use it for any non-trivial math.",
  parameters: {
    type: "object",
    properties: { expression: { type: "string", description: 'e.g. "(1.5 + 2) * 3 ^ 2"' } },
    required: ["expression"],
  },
  run(args) {
    return String(evaluate(String(args.expression ?? "")));
  },
};

const tools: Tool[] = [
  sendMessage,
  sendSticker,
  getCurrentTime,
  calculate,
  webSearch,
  webFetch,
  searchBalance,
  llmKeyLimit,
  remember,
  recall,
  forget,
  bash,
  readFile,
  writeFile,
  sendFile,
];

export function activeTools(): Tool[] {
  return tools.filter((t) => t.enabled?.() ?? true);
}

export async function runTool(name: string, rawArgs: string, ctx: ToolContext): Promise<string> {
  const tool = activeTools().find((t) => t.name === name);
  if (!tool) return `Error: unknown tool "${name}"`;
  try {
    const args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
    return await tool.run(args, ctx);
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Recursive-descent arithmetic evaluator (no eval). */
export function evaluate(expression: string): number {
  const src = expression.replace(/\s+/g, "");
  let pos = 0;

  const peek = () => src[pos];
  const expect = (ch: string) => {
    if (src[pos] !== ch) throw new Error(`expected "${ch}" at position ${pos}`);
    pos++;
  };

  function primary(): number {
    if (peek() === "(") {
      pos++;
      const v = sum();
      expect(")");
      return v;
    }
    if (peek() === "-") {
      pos++;
      return -power();
    }
    if (peek() === "+") {
      pos++;
      return power();
    }
    const m = /^\d+(\.\d+)?|^\.\d+/.exec(src.slice(pos));
    if (!m) throw new Error(`unexpected "${peek() ?? "end of input"}" at position ${pos}`);
    pos += m[0].length;
    return Number(m[0]);
  }

  function power(): number {
    const base = primary();
    if (peek() === "^") {
      pos++;
      return base ** power(); // right-associative
    }
    return base;
  }

  function product(): number {
    let v = power();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = src[pos++];
      const rhs = power();
      v = op === "*" ? v * rhs : op === "/" ? v / rhs : v % rhs;
    }
    return v;
  }

  function sum(): number {
    let v = product();
    while (peek() === "+" || peek() === "-") {
      const op = src[pos++];
      const rhs = product();
      v = op === "+" ? v + rhs : v - rhs;
    }
    return v;
  }

  if (!src) throw new Error("empty expression");
  const result = sum();
  if (pos !== src.length) throw new Error(`unexpected "${src[pos]}" at position ${pos}`);
  return result;
}
