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
  /** Delete the chat's log, its images and reply state before appending `event`. */
  reset: boolean;
  /**
   * Appended instead of `event` when this delivery was seen before without
   * `direct` and now has it (the same message pushed again as an @).
   * Without it such a repeat is a plain duplicate.
   */
  upgrade?: NewStoredEvent;
  /** False for events that never wake the agent. */
  wake: boolean;
  /** Ordinary messages wake the agent at most once per this many seconds (0: never). */
  ambientIntervalSeconds: number;
  /** Who takes the run lock if the agent is woken. */
  lockOwner: string;
  lockTtlMs: number;
}

/** A write by a run that no longer holds the chat's lock (it expired and another run took it). */
export class LockLostError extends Error {
  constructor(chat: string) {
    super(`lock lost: ${chat}`);
    this.name = "LockLostError";
  }
}

export type IngestStatus = "duplicate" | "recorded" | "busy" | "acquired";
export type LockMode = "acquire" | "renew" | "release";

export interface ChatStore {
  /**
   * One webhook delivery, atomically: de-duplicate, create/update the session,
   * optionally reset it, append the event (or `upgrade`, see IngestInput), and
   * if it should wake the agent, try the run lock. The store doesn't look at
   * event types.
   */
  ingest(input: IngestInput): Promise<{ status: IngestStatus; seq?: number }>;
  /** The session and its events after `afterSeq`, oldest first. */
  open(chat: string, afterSeq: number): Promise<{ session: SessionState | null; events: StoredEvent[] }>;
  // The lock holder's writes: each throws LockLostError unless `owner` holds the chat's lock,
  // so a run that lost its lock can't interleave with the run that took it.
  /** Append in order; returns the first seq given. */
  append(chat: string, owner: string, events: NewStoredEvent[]): Promise<number>;
  /** Delete events before `seq`, and the images they reference. */
  trim(chat: string, owner: string, seq: number): Promise<void>;
  lock(chat: string, owner: string, ttlMs: number, mode: LockMode): Promise<boolean>;
  claimAmbient(chat: string, intervalSeconds: number): Promise<boolean>;
  /** Increments the turn counter; returns the new turn number. */
  beginTurn(chat: string, owner: string): Promise<number>;
  setCursor(chat: string, owner: string, seq: number): Promise<void>;
  getReply(chat: string, eventId: string): Promise<Record<string, string> | null>;
  putReply(chat: string, eventId: string, context: Record<string, string>): Promise<void>;
  putImage(chat: string, key: string, dataUrl: string): Promise<void>;
  /** The data URLs of the keys that exist. */
  getImages(keys: string[]): Promise<Record<string, string>>;
}
