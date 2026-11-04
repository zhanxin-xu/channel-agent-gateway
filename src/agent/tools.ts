/**
 * Tools the agent can call. Add one by appending to `tools`: a JSON-schema
 * definition the model sees, and a `run` function that returns a string.
 */
import { llmKeyLimit, searchBalance } from "./account-tools.js";
import type { OutgoingFile } from "../channels/types.js";
import type { ImagePart } from "./images.js";
import { MAX_MESSAGES_PER_TURN, REPLY_TO, replyTo } from "./limits.js";
import { forget, recall, remember } from "./memory.js";
import { bash, readFile, sendFile, writeFile } from "./sandbox.js";
import { isStickerName, STICKER_NAMES, STICKERS, type StickerName } from "./stickers.js";
import { webFetch, webSearch } from "./web-tools.js";

/** Per-run context handed to tools (one agent run may hold several turns). */
export interface ToolContext {
  /** Messages delivered this turn (stickers as "[表情包：name]", files as "[文件：name]"). */
  sent: string[];
  /**
   * Deliver one message now as a reply to message `replyTo` (its 第N条 number;
   * default: the turn's main message). Returns a status line for the model.
   * Throws when that message can't take more replies (QQ: 5 each).
   */
  send(text: string, replyTo?: number): Promise<string>;
  sendSticker(name: StickerName, replyTo?: number): Promise<string>;
  /** Throws when the channel can't send files. */
  sendFile(file: OutgoingFile, replyTo?: number): Promise<string>;
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
    "so call it several times to send a few short messages in a row. " +
    "Sending doesn't end your turn: when you're done, call end_turn, ideally in the same step as your last message.",
  parameters: {
    type: "object",
    properties: { text: { type: "string", description: "The message text (plain text)." }, reply_to: REPLY_TO },
    required: ["text"],
  },
  async run(args, ctx) {
    const text = String(args.text ?? "").trim();
    if (!text) throw new Error("text is empty");
    return `${await ctx.send(text, replyTo(args))}. If you're done, call end_turn (in the same step as your last message).`;
  },
};

const sendSticker: Tool = {
  name: "send_sticker",
  description:
    "Send one 大肥鱼 sticker (an image) right now, as its own message (it counts as a reply like send_message). Pick by mood:\n" +
    STICKER_NAMES.map((n) => `- ${n}：${STICKERS[n].when}`).join("\n"),
  parameters: {
    type: "object",
    properties: { name: { type: "string", enum: STICKER_NAMES, description: "Sticker name." }, reply_to: REPLY_TO },
    required: ["name"],
  },
  async run(args, ctx) {
    const name = String(args.name ?? "");
    if (!isStickerName(name)) throw new Error(`unknown sticker "${name}"`);
    return `${await ctx.sendSticker(name, replyTo(args))}. If you're done, call end_turn (in the same step as your last message).`;
  },
};

/** The model's way to hang up; the loop ends the turn when it sees this call (see runAgent). */
export const END_TURN = "end_turn";

const endTurn: Tool = {
  name: END_TURN,
  description:
    "Hang up: end this turn. Call it once you've said everything, in the same step as your last " +
    "send_message so no extra round is needed. Don't call it while you still need to look something up " +
    "or run something whose result you need to see: tools called in the same step still run, but you won't see their results.",
  parameters: { type: "object", properties: {} },
  run: () => "turn ended",
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
  endTurn,
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
