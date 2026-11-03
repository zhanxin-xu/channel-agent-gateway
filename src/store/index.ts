/**
 * Tiny store for conversation history and webhook de-duplication.
 *
 * Serverless instances are ephemeral and run in parallel (and a deploy swaps
 * them out), so production needs a shared store: Upstash Redis over its REST
 * API (no SDK, just fetch). Without credentials it falls back to per-instance
 * memory, which is fine for local development but means history and de-dup
 * are not shared between instances.
 */
import { config } from "../config.js";

/**
 * Lists may grow to this multiple of `keep` before being trimmed back to `keep`.
 * Trimming in batches keeps the oldest entries (the start of the model's input)
 * stable between messages, so the model provider's prompt cache keeps hitting;
 * it also skips the LTRIM on most writes.
 */
export const TRIM_SLACK = 1.25;

export interface Store {
  /** The newest `last` items of a list (all when omitted), oldest first. */
  list(key: string, last?: number): Promise<string[]>;
  /**
   * Append items to a list and refresh its TTL; once it exceeds `keep` ×
   * TRIM_SLACK, trim it back to the newest `keep`. Appending (rather than
   * read-modify-write) means concurrent handlers can't overwrite each other.
   */
  append(key: string, items: string[], keep: number, ttlSeconds: number): Promise<void>;
  /** Set only if absent. Returns true when this call created the key. */
  claim(key: string, ttlSeconds: number): Promise<boolean>;
  del(key: string): Promise<void>;
}

export class MemoryStore implements Store {
  private data = new Map<string, { value: string[]; expiresAt: number }>();

  private live(key: string) {
    const hit = this.data.get(key);
    if (hit && hit.expiresAt <= Date.now()) {
      this.data.delete(key);
      return undefined;
    }
    return hit;
  }

  async list(key: string, last?: number) {
    const value = this.live(key)?.value ?? [];
    return last ? value.slice(-last) : [...value];
  }

  async append(key: string, items: string[], keep: number, ttlSeconds: number) {
    let value = [...(this.live(key)?.value ?? []), ...items];
    if (value.length > Math.floor(keep * TRIM_SLACK)) value = value.slice(-keep);
    this.data.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async claim(key: string, ttlSeconds: number) {
    if (this.live(key)) return false;
    this.data.set(key, { value: [], expiresAt: Date.now() + ttlSeconds * 1000 });
    return true;
  }

  async del(key: string) {
    this.data.delete(key);
  }
}

type Command = (string | number)[];

export class UpstashStore implements Store {
  constructor(
    private url: string,
    private token: string,
  ) {}

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(this.url.replace(/\/+$/, "") + path, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as unknown;
    if (!res.ok) throw new Error(`Upstash ${path || "/"} HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
    return data;
  }

  private async command(...args: Command): Promise<unknown> {
    const data = (await this.post("", args.map(String))) as { result?: unknown; error?: string };
    if (data.error) throw new Error(`Upstash ${args[0]} failed: ${data.error}`);
    return data.result;
  }

  /** Several commands in one round trip. */
  private async pipeline(...commands: Command[]): Promise<unknown[]> {
    const data = (await this.post("/pipeline", commands.map((c) => c.map(String)))) as Array<{ result?: unknown; error?: string }>;
    const failed = data.find((d) => d.error);
    if (failed) throw new Error(`Upstash pipeline failed: ${failed.error}`);
    return data.map((d) => d.result);
  }

  async list(key: string, last?: number) {
    return ((await this.command("LRANGE", key, last ? -last : 0, -1)) as string[] | null) ?? [];
  }

  async append(key: string, items: string[], keep: number, ttlSeconds: number) {
    if (!items.length) return;
    const [length] = await this.pipeline(["RPUSH", key, ...items], ["EXPIRE", key, ttlSeconds]);
    if (Number(length) > Math.floor(keep * TRIM_SLACK)) await this.command("LTRIM", key, -keep, -1);
  }

  async claim(key: string, ttlSeconds: number) {
    return (await this.command("SET", key, "1", "NX", "EX", ttlSeconds)) === "OK";
  }

  async del(key: string) {
    await this.command("DEL", key);
  }
}

let instance: Store | undefined;

export function getStore(): Store {
  instance ??=
    config.store.url && config.store.token ? new UpstashStore(config.store.url, config.store.token) : new MemoryStore();
  return instance;
}
