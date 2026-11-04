/**
 * One-time copy of every key from Upstash Redis to Supabase
 * (`POST /api/migrate`, signed like the worker hand-off). Strings and lists
 * keep their remaining TTL; run locks are skipped. Lists are replaced, so it
 * can be run again. Remove this file and api/migrate.ts once the move is done.
 */
import crypto from "node:crypto";
import { workerSignature } from "./agent/handle.js";
import { json } from "./channels/types.js";
import { config } from "./config.js";
import { SupabaseStore } from "./store/index.js";

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;
const CHUNK = 200;

async function redis(...command: (string | number)[]): Promise<unknown> {
  const res = await fetch(config.store.url.replace(/\/+$/, ""), {
    method: "POST",
    headers: { authorization: `Bearer ${config.store.token}`, "content-type": "application/json" },
    body: JSON.stringify(command.map(String)),
  });
  const data = (await res.json()) as { result?: unknown; error?: string };
  if (!res.ok || data.error) throw new Error(`Upstash ${command[0]}: ${data.error ?? res.status}`);
  return data.result;
}

export async function handleMigrate(request: Request): Promise<Response> {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  const body = await request.text();
  const signature = Buffer.from(request.headers.get("x-worker-signature") ?? "");
  const expected = Buffer.from(workerSignature(body));
  if (signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected)) {
    return json({ error: "bad signature" }, 401);
  }
  if (!config.store.url || !config.store.token || !config.store.supabaseUrl || !config.store.supabaseKey) {
    return json({ error: "needs both Upstash and Supabase credentials" }, 400);
  }
  const target = new SupabaseStore(config.store.supabaseUrl, config.store.supabaseKey);

  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = (await redis("SCAN", cursor, "COUNT", 1000)) as [string, string[]];
    keys.push(...batch);
    cursor = next;
  } while (cursor !== "0");

  const copied = { strings: 0, lists: 0, listItems: 0, skipped: 0 };
  const errors: string[] = [];
  for (const key of keys) {
    try {
      if (key.startsWith("ev:lock:")) {
        copied.skipped++;
        continue;
      }
      const type = (await redis("TYPE", key)) as string;
      const pttl = Number(await redis("PTTL", key));
      if (pttl === -2) continue; // expired meanwhile
      const ttlMs = pttl > 0 ? pttl : DEFAULT_TTL_SECONDS * 1000;
      if (type === "string") {
        const value = (await redis("GET", key)) as string | null;
        if (value === null) continue;
        await target.set(key, value, ttlMs);
        copied.strings++;
      } else if (type === "list") {
        const items = (await redis("LRANGE", key, 0, -1)) as string[];
        await target.del(key);
        for (let i = 0; i < items.length; i += CHUNK) {
          await target.rpush(key, items.slice(i, i + CHUNK), Math.ceil(ttlMs / 1000));
        }
        copied.lists++;
        copied.listItems += items.length;
      } else {
        copied.skipped++;
        errors.push(`${key}: unsupported type ${type}`);
      }
    } catch (err) {
      errors.push(`${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`[migrate] ${keys.length} keys: ${JSON.stringify(copied)}, ${errors.length} errors`);
  return json({ keys: keys.length, ...copied, errors });
}
