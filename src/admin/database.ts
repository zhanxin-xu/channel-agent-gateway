/**
 * Creating or upgrading the database from the console: run
 * supabase/schema.sql (safe to run again) over a direct Postgres connection.
 * Vercel's Supabase integration provides the connection string; without one
 * the console shows the SQL to run by hand.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

const URL_VARS = ["POSTGRES_URL_NON_POOLING", "DATABASE_URL", "POSTGRES_URL"];
const SCHEMA_FILE = "supabase/schema.sql";

/** The name of the variable holding a direct connection string, if any. */
export function connectionVar(): string | undefined {
  return URL_VARS.find((name) => process.env[name]?.trim());
}

export function readSchema(): Promise<string> {
  return readFile(path.resolve(process.cwd(), SCHEMA_FILE), "utf8");
}

/** Run schema.sql. Throws with Postgres' message when it fails. */
export async function applySchema(): Promise<void> {
  const name = connectionVar();
  if (!name) throw new Error(`没有数据库直连地址（${URL_VARS.join(" / ")}）`);
  const url = new URL(process.env[name]!.trim());
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  // Supabase's certificate chain isn't in Node's store; encryption still applies.
  url.searchParams.delete("sslmode");
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url.toString(), ssl: local ? undefined : { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query("set client_min_messages = warning");
    await client.query(await readSchema());
  } finally {
    await client.end();
  }
}
