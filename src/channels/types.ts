/** A user message normalized from any channel. */
export interface InboundMessage {
  channel: string;
  /** Unique per delivery; used to drop webhook retries. */
  eventId: string;
  /** Conversation key: a DM peer, a group, a chat… History is stored per conversation. */
  conversationId: string;
  chatType: "private" | "group";
  userId: string;
  /** Display name when the platform provides one (QQ v2 events don't). */
  senderName?: string;
  text: string;
  /** Channel-specific data the adapter needs to reply (msg_id, chat_id, …). */
  replyContext: Record<string, string>;
  /** Public origin of this deployment (set by the webhook route), for URLs to our static files. */
  origin?: string;
}

export type ReceiveResult =
  /** Nothing for the agent (handshake, unsupported event, bad signature…). */
  | { kind: "respond"; response: Response }
  /** A message for the agent. `ack` is returned to the platform immediately. */
  | { kind: "message"; message: InboundMessage; ack?: Response };

export interface ChannelAdapter {
  readonly name: string;
  /** Extra instructions appended to the system prompt, e.g. formatting limits. */
  readonly promptHint?: string;
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
