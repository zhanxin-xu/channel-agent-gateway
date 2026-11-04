/** What a run needs to reply in a chat; the session row keeps it for runs started by the worker. */
export interface ChatMeta {
  channel: string;
  conversationId: string;
  chatType: "private" | "group";
  /** Public origin of this deployment, for the worker hand-off. */
  origin?: string;
}
