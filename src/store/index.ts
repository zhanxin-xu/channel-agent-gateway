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

export interface Store {
  /** All items of a list, oldest first. */
  list(key: string): Promise<string[]>;
  /**
   * Append items to a list, keep only the newest `keep`, refresh the TTL.
   * Appending (rather than read-modify-write) means two messages handled at
   * the same time can't overwrite each other's turns.
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

  async list(key: string) {
    return [...(this.live(key)?.value ?? [])];
  }

  async append(key: string, items: string[], keep: number, ttlSeconds: number) {
    const value = [...(this.live(key)?.value ?? []), ...items].slice(-keep);
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

  async list(key: string) {
    return ((await this.command("LRANGE", key, 0, -1)) as string[] | null) ?? [];
  }

  async append(key: string, items: string[], keep: number, ttlSeconds: number) {
    if (!items.length) return;
    await this.pipeline(["RPUSH", key, ...items], ["LTRIM", key, -keep, -1], ["EXPIRE", key, ttlSeconds]);
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
