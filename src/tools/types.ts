import type { OutgoingFile } from "../channels/types.js";
import type { ImagePart } from "../media/images.js";
import type { StickerName } from "./stickers.js";

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
