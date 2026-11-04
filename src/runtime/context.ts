/** The ToolContext of one run: how tools reach the chat (send, stickers, files). */
import type { ChannelAdapter, OutgoingFile } from "../channels/types.js";
import { config } from "../config.js";
import { DEFAULT_STICKER_BASE_URL, stickerUrl } from "../tools/stickers.js";
import type { ToolContext } from "../tools/types.js";
import type { Outbox } from "./outbox.js";
import type { ChatMeta } from "./types.js";

export function makeToolContext(
  adapter: ChannelAdapter,
  meta: ChatMeta,
  chatKey: string,
  deadline: number,
  outbox: Outbox,
  turnState: { main: number },
  collect: string[] | undefined,
): ToolContext {
  return {
    sent: [],
    deadline,
    chat: { key: chatKey, scene: meta.chatType === "group" ? "群聊" : "私聊", sender: "?" },
    images: [],
    async send(text, replyTo) {
      const status = await outbox.deliver(replyTo ?? turnState.main, (msg) =>
        collect ? Promise.resolve(void collect.push(text)) : adapter.send!(msg, text),
      );
      this.sent.push(text);
      return status;
    },
    async sendSticker(name, replyTo) {
      const url = stickerUrl(config.stickerBaseUrl || DEFAULT_STICKER_BASE_URL, name);
      const fallback = `[表情包：${name}] ${url}`;
      const status = await outbox.deliver(replyTo ?? turnState.main, (msg) =>
        collect
          ? Promise.resolve(void collect.push(fallback))
          : adapter.sendImage
            ? adapter.sendImage(msg, url)
            : adapter.send!(msg, fallback),
      );
      this.sent.push(`[表情包：${name}]`);
      return status;
    },
    async sendFile(file: OutgoingFile, replyTo) {
      const sendFile = adapter.sendFile;
      if (collect || !sendFile) throw new Error(`the ${adapter.name} channel can't send files`);
      const status = await outbox.deliver(replyTo ?? turnState.main, (msg) => sendFile.call(adapter, msg, file));
      this.sent.push(`[文件：${file.name}]`);
      return status;
    },
  };
}
