/** A user message normalized from any channel. */
/** Someone in a chat: their platform id, and their display name when known. */
export interface Person {
  userId: string;
  name?: string;
}

export interface InboundMessage {
  channel: string;
  /** Unique per delivery; used to drop webhook retries. */
  eventId: string;
  /** Conversation key: a DM peer, a group, a chat… History is stored per conversation. */
  conversationId: string;
  chatType: "private" | "group";
  /**
   * "direct" (default): addressed to the bot (DM or @), always answered.
   * "ambient": an ordinary group message; logged, and wakes the agent at most
   * once per sampling interval (it may stay silent).
   */
  mode?: "direct" | "ambient";
  userId: string;
  /** Display name when the platform provides one. */
  senderName?: string;
  /** Other people this message @-mentions (the text shows them as "@昵称 #ID"). */
  mentions?: Person[];
  /** Message text. Voice/video/file attachments appear here as "[语音] …", "[视频]", "[文件：…]". */
  text: string;
  /** Images attached to the message (stored with it and shown to the model). */
  images?: Array<{ url: string; contentType: string }>;
  /**
   * Every attachment's original (images included), so the agent can save it to
   * its workspace later (save_attachment). Platform links expire.
   */
  attachments?: Attachment[];
  /**
   * Channel-specific data the adapter needs to reply (msg_id, chat_id, …). Kept
   * with the message in the event log; adapters may update it while replying
   * (QQ's msg_seq) and the update is saved for the next reply.
   */
  replyContext: Record<string, string>;
}

export type ReceiveResult =
  /** Nothing for the agent (handshake, unsupported event, bad signature…). */
  | { kind: "respond"; response: Response }
  /** A message for the agent. `ack` is returned to the platform immediately. */
  | { kind: "message"; message: InboundMessage; ack?: Response };

/** An attachment as the platform delivered it: a download link to the original. */
export interface Attachment {
  name: string;
  url: string;
  contentType: string;
}

/** A file the agent sends from its workspace. */
export interface OutgoingFile {
  name: string;
  data: Buffer;
}

/** A voice message (send_voice): mono 16-bit little-endian PCM, and the words it says. */
export interface OutgoingVoice {
  pcm: Buffer;
  sampleRate: number;
  text: string;
}

export interface ChannelAdapter {
  readonly name: string;
  /** Extra instructions appended to the system prompt, e.g. formatting limits. */
  readonly promptHint?: string;
  /** How many replies one inbound message can take on this platform. Unset: the gateway's default (5). */
  readonly maxRepliesPerMessage?: number;
  isConfigured(): boolean;
  /** Verify and parse a webhook request. `rawBody` is the exact request body. */
  receive(req: Request, rawBody: string): Promise<ReceiveResult>;
  /**
   * Deliver the agent's reply. Adapters without `send` reply synchronously:
   * the route waits for the agent and returns the text in the HTTP response.
   */
  send?(message: InboundMessage, text: string): Promise<void>;
  /** Send an image by public URL (stickers). Adapters without it get a text fallback. */
  sendImage?(message: InboundMessage, url: string): Promise<void>;
  /** Upload and send a file's bytes (send_file). Adapters without it can't send files. */
  sendFile?(message: InboundMessage, file: OutgoingFile): Promise<void>;
  /**
   * Send a voice message the platform plays inline. Adapters without it get a
   * WAV file through sendFile, or the words as text when they can't send files.
   */
  sendVoice?(message: InboundMessage, voice: OutgoingVoice): Promise<void>;
  /**
   * The markup that @-mentions a person in a group message's text. The agent
   * writes "@#3B6834" and the gateway swaps in this tag; without it the text
   * stays as written.
   */
  mentionTag?(userId: string): string;
  /** Optional "typing…" indicator shown while the agent runs. */
  typing?(message: InboundMessage): Promise<void>;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Split text into chunks of at most `max` characters, preferring line breaks. */
export function chunkText(text: string, max: number): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
