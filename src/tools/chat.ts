/** Talking and hanging up: send_message, send_sticker, end_turn, and the reply rules they share. */
import { config } from "../config.js";
import { DEFAULT_STICKER_BASE_URL, isStickerName, STICKER_NAMES, STICKERS, stickerUrl } from "./stickers.js";
import type { Tool } from "./types.js";

/** Shared `reply_to` parameter of the tools that talk (send_message, send_sticker, send_file). */
export const REPLY_TO = {
  type: "integer",
  description:
    "Which message this replies to: the N of its 第N条 label. Default: the turn's main message, named in the system note. " +
    "Each message takes a limited number of replies; every send reports how many are used.",
};

export const replyTo = (args: Record<string, unknown>): number | undefined =>
  args.reply_to === undefined || args.reply_to === null || args.reply_to === "" ? undefined : Number(args.reply_to);

export const sendMessage: Tool = {
  name: "send_message",
  role: "say",
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
    return `${await ctx.send({ kind: "text", text }, replyTo(args))}. If you're done, call end_turn (in the same step as your last message).`;
  },
};

export const sendSticker: Tool = {
  name: "send_sticker",
  role: "talk",
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
    return `${await ctx.send({ kind: "image", url: stickerUrl(config.stickerBaseUrl || DEFAULT_STICKER_BASE_URL, name), label: `[表情包：${name}]` }, replyTo(args))}. If you're done, call end_turn (in the same step as your last message).`;
  },
};

/** The model's way to hang up; the loop ends the turn when it sees this call (see agent/loop.ts). */
export const END_TURN = "end_turn";

export const endTurn: Tool = {
  name: END_TURN,
  role: "hangup",
  description:
    "Hang up: end this turn. Call it once you've said everything, in the same step as your last " +
    "send_message so no extra round is needed. Don't call it while you still need to look something up " +
    "or run something whose result you need to see: tools called in the same step still run, but you won't see their results.",
  parameters: { type: "object", properties: {} },
  run: () => "turn ended",
};
