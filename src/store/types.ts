/** The store's contract; see index.ts. */
export interface StoredEvent {
  seq: number;
  type: string;
  /** Unix epoch milliseconds. */
  time: number;
  data: unknown;
}

export interface NewStoredEvent {
  type: string;
  data: unknown;
}

/** The session row: the log's header and the run state. */
export interface SessionState {
  chat: string;
  channel: string;
  conversationId: string;
  chatType: "private" | "group";
  origin?: string | null;
  formatVersion: number;
  /** When the session row was created (epoch ms); a chat that expired and came back is a new session. */
  createdAt: number;
  /** Seq the next event will get. */
  nextSeq: number;
  /** Seq of the oldest event still kept (= nextSeq when there are none). */
  minSeq: number;
  /** Seq of the last user message a turn has handled. */
  cursor: number;
  turn: number;
}

export interface IngestInput {
  chat: string;
  channel: string;
  conversationId: string;
  chatType: "private" | "group";
  origin?: string;
  /** The platform's id of this delivery, for de-duplication. */
  eventId: string;
  /** A DM or an @: wakes the agent every time. */
  direct: boolean;
  event: NewStoredEvent;
  /** False for events that never wake the agent (session/reset). */
  wake: boolean;
  /** Ordinary messages wake the agent at most once per this many seconds (0: never). */
  ambientIntervalSeconds: number;
  /** Who takes the run lock if the agent is woken. */
  lockOwner: string;
  lockTtlMs: number;
}

export type IngestStatus = "duplicate" | "recorded" | "busy" | "acquired";
export type LockMode = "acquire" | "renew" | "release";

export interface ChatStore {
  /**
   * One webhook delivery, atomically: de-duplicate, create/update the session,
   * append the event (a user/mentioned mark when a seen message comes back as
   * an @), and if it should wake the agent, try the run lock. session/reset
   * deletes everything logged before it.
   */
  ingest(input: IngestInput): Promise<{ status: IngestStatus; seq?: number }>;
  /** The session and its events after `afterSeq`, oldest first. */
  open(chat: string, afterSeq: number): Promise<{ session: SessionState | null; events: StoredEvent[] }>;
  /** Append in order; returns the first seq given. */
  append(chat: string, events: NewStoredEvent[]): Promise<number>;
  /** Delete events before `seq`, and the images they reference. */
  trim(chat: string, seq: number): Promise<void>;
  lock(chat: string, owner: string, ttlMs: number, mode: LockMode): Promise<boolean>;
  claimAmbient(chat: string, intervalSeconds: number): Promise<boolean>;
  /** Increments the turn counter; returns the new turn number. */
  beginTurn(chat: string): Promise<number>;
  setCursor(chat: string, seq: number): Promise<void>;
  getReply(chat: string, eventId: string): Promise<Record<string, string> | null>;
  putReply(chat: string, eventId: string, context: Record<string, string>): Promise<void>;
  putImage(chat: string, key: string, dataUrl: string): Promise<void>;
  /** The data URLs of the keys that exist. */
  getImages(keys: string[]): Promise<Record<string, string>>;
}
