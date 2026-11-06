/** The console's page and its scripts (src/admin/ui, bundled via vercel.json includeFiles). */
import { readFile } from "node:fs/promises";
import path from "node:path";

const DIR = "src/admin/ui";
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

/** Only the page's own files; no external scripts, no framing. */
const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
};

/** `file` is the path after /admin/: "" for the page, else one of its files. */
export async function serveUi(file: string): Promise<Response> {
  const name = file === "" ? "index.html" : file;
  const type = TYPES[path.extname(name)];
  // Flat names only: nothing outside the directory can be asked for.
  if (!type || !/^[a-z0-9-]+(\.[a-z0-9]+)+$/.test(name)) return new Response("not found", { status: 404 });
  try {
    const body = await readFile(path.resolve(process.cwd(), DIR, name));
    return new Response(body, { headers: { "content-type": type, "cache-control": "no-cache", ...SECURITY_HEADERS } });
  } catch {
    return new Response("not found", { status: 404 });
  }
}
