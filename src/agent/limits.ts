/** QQ allows 5 replies per inbound message (bot-docs send.md); apply the same cap on every channel. */
export const MAX_MESSAGES_PER_TURN = 5;

/** Shared `reply_to` parameter of the tools that talk (send_message, send_sticker, send_file). */
export const REPLY_TO = {
  type: "integer",
  description:
    "Which message this replies to: the N of its 第N条 label. Default: the turn's main message, named in the system note. " +
    `Each message takes at most ${MAX_MESSAGES_PER_TURN} replies.`,
};

export const replyTo = (args: Record<string, unknown>): number | undefined =>
  args.reply_to === undefined || args.reply_to === null || args.reply_to === "" ? undefined : Number(args.reply_to);
