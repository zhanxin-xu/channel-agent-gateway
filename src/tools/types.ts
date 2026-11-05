import type { Attachment, OutgoingFile, OutgoingVoice } from "../channels/types.js";
import type { ImagePart } from "../media/images.js";

/** Something a tool delivers to the chat. */
export type Outgoing =
  | { kind: "text"; text: string }
  /** An image by public URL. `label` stands in for it in `sent`, and (with the URL) on channels that can't send images. */
  | { kind: "image"; url: string; label: string }
  | { kind: "file"; file: OutgoingFile }
  | { kind: "voice"; voice: OutgoingVoice };

/** Per-run context handed to tools (one agent run may hold several turns). */
export interface ToolContext {
  /** What was delivered this turn: texts, image labels, files as "[文件：name]". */
  sent: string[];
  /**
   * Deliver one message now as a reply to message `replyTo` (its 第N条 number;
   * default: the turn's main message). Returns a status line for the model.
   * Throws when that message can't take more replies, or the channel can't
   * deliver this kind of message (files).
   */
  send(message: Outgoing, replyTo?: number): Promise<string>;
  /** When the function will be killed (epoch ms). */
  deadline: number;
  /**
   * How long a call started now may take (ms): until the run's hand-off margin
   * before the deadline (agent/budget.ts). Every tool that waits on something
   * slow caps its timeout with this.
   */
  callBudgetMs(): number;
  /** The chat this run belongs to: memory metadata and the per-chat workspace. */
  chat: { key: string; scene: "群聊" | "私聊"; sender: string };
  /** Images a tool wants the model to see; the loop shows them after the step's tool outputs. */
  images: ImagePart[];
  /** Run `fn` when the agent run ends, e.g. to stop a sandbox the tool started. */
  onRunEnd(fn: () => Promise<void> | void): void;
  /** The attachments of message `seq` (its 第N条 number): [] when it has none, undefined when there's no such message. */
  attachments(seq: number): Attachment[] | undefined;
}

/**
 * How the agent loop treats a tool, so the loop never needs tool names:
 *   - "say": delivers to the chat; the last step of a turn forces a call to it.
 *   - "talk": also delivers to the chat. If a "say"/"talk" call fails in the
 *     step that hangs up, the turn goes on so the model can react.
 *   - "hangup": ends the turn; the loop handles the call instead of running it.
 */
export type ToolRole = "say" | "talk" | "hangup";

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  role?: ToolRole;
  /** Hide the tool from the model when its backing service isn't configured. */
  enabled?(): boolean;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> | string;
}
