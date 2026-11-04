/**
 * A small key-value store: the per-chat event logs, locks, cursors and
 * de-duplication keys all live here. The interface is Redis-shaped (strings
 * with TTLs, and lists).
 *
 * Serverless instances are ephemeral and run in parallel (and a deploy swaps
 * them out), so production needs a shared store, reached over HTTP with
 * plain fetch (no SDK):
 *   - Supabase: Postgres tables plus functions called over the Data API
 *     (supabase/schema.sql). No per-request quota on the free plan.
 *   - Upstash Redis over its REST API (every command counts toward the quota).
 * Without either it falls back to per-instance memory, which is fine for
 * local development and tests but shares nothing between instances.
 */
import { config } from "../config.js";

export interface Store {
  /** Append to a list and refresh its TTL (skipped when `ttlSeconds` <= 0). Returns the new length. */
  rpush(key: string, values: string[], ttlSeconds: number): Promise<number>;
  /** Items `start`..`stop` (inclusive, negative counts from the end). */
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  /** Drop the first `count` items of a list. */
  lpop(key: string, count: number): Promise<void>;
  get(key: string): Promise<string | null>;
  /** Set a value with a TTL. With `nx`, only if absent; returns whether it was set. */
  set(key: string, value: string, ttlMs: number, opts?: { nx?: boolean }): Promise<boolean>;
  incrby(key: string, by: number, ttlSeconds: number): Promise<number>;
  del(...keys: string[]): Promise<void>;
  /** Set only if absent, for de-duplication. Returns true when this call created the key. */
  claim(key: string, ttlSeconds: number): Promise<boolean>;
}

export class MemoryStore implements Store {
  private data = new Map<string, { value: string | string[]; expiresAt: number }>();

  private live(key: string) {
    const hit = this.data.get(key);
    if (hit && hit.expiresAt <= Date.now()) {
      this.data.delete(key);
      return undefined;
    }
    return hit;
  }

  private list(key: string): string[] {
    const value = this.live(key)?.value;
    return Array.isArray(value) ? value : [];
  }

  async rpush(key: string, values: string[], ttlSeconds: number) {
    const value = [...this.list(key), ...values];
    const expiresAt = ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : (this.live(key)?.expiresAt ?? Infinity);
    this.data.set(key, { value, expiresAt });
    return value.length;
  }


  async lrange(key: string, start: number, stop: number) {
    const list = this.list(key);
    const at = (i: number) => (i < 0 ? list.length + i : i);
    return list.slice(at(start), at(stop) + 1);
  }

  async lpop(key: string, count: number) {
    const hit = this.live(key);
    if (hit && Array.isArray(hit.value)) hit.value = hit.value.slice(count);
  }

  async get(key: string) {
    const value = this.live(key)?.value;
    return typeof value === "string" ? value : null;
  }

  async set(key: string, value: string, ttlMs: number, opts: { nx?: boolean } = {}) {
    if (opts.nx && this.live(key)) return false;
    this.data.set(key, { value, expiresAt: Date.now() + ttlMs });
    return true;
  }

  async incrby(key: string, by: number, ttlSeconds: number) {
    const next = Number((await this.get(key)) ?? 0) + by;
    this.data.set(key, { value: String(next), expiresAt: Date.now() + ttlSeconds * 1000 });
    return next;
  }

  async del(...keys: string[]) {
    for (const key of keys) this.data.delete(key);
  }

  async claim(key: string, ttlSeconds: number) {
    return this.set(key, "1", ttlSeconds * 1000, { nx: true });
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

  async rpush(key: string, values: string[], ttlSeconds: number) {
    if (ttlSeconds <= 0) return Number(await this.command("RPUSH", key, ...values));
    const [length] = await this.pipeline(["RPUSH", key, ...values], ["EXPIRE", key, ttlSeconds]);
    return Number(length);
  }


  async lrange(key: string, start: number, stop: number) {
    return ((await this.command("LRANGE", key, start, stop)) as string[] | null) ?? [];
  }

  async lpop(key: string, count: number) {
    if (count > 0) await this.command("LTRIM", key, count, -1);
  }

  async get(key: string) {
    return ((await this.command("GET", key)) as string | null) ?? null;
  }

  async set(key: string, value: string, ttlMs: number, opts: { nx?: boolean } = {}) {
    const result = await this.command("SET", key, value, "PX", Math.max(1, Math.round(ttlMs)), ...(opts.nx ? ["NX"] : []));
    return result === "OK";
  }

  async incrby(key: string, by: number, ttlSeconds: number) {
    const [value] = await this.pipeline(["INCRBY", key, by], ["EXPIRE", key, ttlSeconds]);
    return Number(value);
  }

  async del(...keys: string[]) {
    if (keys.length) await this.command("DEL", ...keys);
  }

  async claim(key: string, ttlSeconds: number) {
    return this.set(key, "1", ttlSeconds * 1000, { nx: true });
  }
}

/**
 * Supabase: each operation is one call to a function from supabase/schema.sql
 * (POST /rest/v1/rpc/<name>) with the server key. New secret keys (sb_secret_…)
 * go in the `apikey` header; a legacy service-role JWT also as the bearer token.
 */
export class SupabaseStore implements Store {
  constructor(
    private url: string,
    private key: string,
  ) {}

  private async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const headers: Record<string, string> = { apikey: this.key, "content-type": "application/json" };
    if (this.key.startsWith("eyJ")) headers.authorization = `Bearer ${this.key}`;
    const res = await fetch(`${this.url.replace(/\/+$/, "")}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers,
      body: JSON.stringify(args),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Supabase ${fn} HTTP ${res.status}: ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  async rpush(key: string, values: string[], ttlSeconds: number) {
    return Number(await this.rpc("list_rpush", { p_key: key, p_values: values, p_ttl_s: ttlSeconds }));
  }

  async lrange(key: string, start: number, stop: number) {
    return (await this.rpc<string[] | null>("list_range", { p_key: key, p_start: start, p_stop: stop })) ?? [];
  }

  async lpop(key: string, count: number) {
    if (count > 0) await this.rpc("list_lpop", { p_key: key, p_count: count });
  }

  async get(key: string) {
    return (await this.rpc<string | null>("kv_get", { p_key: key })) ?? null;
  }

  async set(key: string, value: string, ttlMs: number, opts: { nx?: boolean } = {}) {
    return Boolean(
      await this.rpc("kv_set", { p_key: key, p_value: value, p_ttl_ms: Math.max(1, Math.round(ttlMs)), p_nx: Boolean(opts.nx) }),
    );
  }

  async incrby(key: string, by: number, ttlSeconds: number) {
    return Number(await this.rpc("kv_incrby", { p_key: key, p_by: by, p_ttl_s: ttlSeconds }));
  }

  async del(...keys: string[]) {
    if (keys.length) await this.rpc("store_del", { p_keys: keys });
  }

  async claim(key: string, ttlSeconds: number) {
    return this.set(key, "1", ttlSeconds * 1000, { nx: true });
  }
}

let instance: Store | undefined;

/** Which backend getStore() uses (see config.store.backend). */
export function storeBackend(): "supabase" | "upstash" | "memory" {
  const { backend, supabaseUrl, supabaseKey, url, token } = config.store;
  if (backend === "supabase" || backend === "upstash" || backend === "memory") return backend;
  if (supabaseUrl && supabaseKey) return "supabase";
  if (url && token) return "upstash";
  return "memory";
}

export function getStore(): Store {
  if (!instance) {
    const backend = storeBackend();
    instance =
      backend === "supabase"
        ? new SupabaseStore(config.store.supabaseUrl, config.store.supabaseKey)
        : backend === "upstash"
          ? new UpstashStore(config.store.url, config.store.token)
          : new MemoryStore();
  }
  return instance;
}

/** Tests swap stores between cases. */
export function resetStore(store?: Store) {
  instance = store;
}
