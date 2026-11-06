/**
 * The console's page and its scripts (src/admin/ui, bundled via vercel.json
 * includeFiles).
 *
 * Served by the function, but cached: Vercel's CDN keeps each file
 * (Vercel-CDN-Cache-Control), so a page load doesn't run the function a dozen
 * times, and browsers revalidate every time against an ETag of the content,
 * so they never keep a file from an older deployment.
 */
import crypto from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
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

/**
 * The page with a modulepreload link for every script, so the browser fetches
 * them all at once instead of discovering the imports one level at a time.
 */
async function withPreloads(page: Buffer): Promise<Buffer> {
  // A speed-up only: if the directory can't be listed, the page works without it.
  const scripts = (await readdir(path.resolve(process.cwd(), DIR)).catch(() => [] as string[])).filter((f) => f.endsWith(".js")).sort();
  const links = scripts.map((f) => `  <link rel="modulepreload" href="/admin/${f}">`).join("\n");
  return Buffer.from(page.toString("utf8").replace("</head>", `${links}\n</head>`));
}

/** Files never change within a deployment: each is read and hashed once per instance. */
const files = new Map<string, Promise<{ body: Buffer; etag: string }>>();

function load(name: string) {
  let hit = files.get(name);
  if (!hit) {
    hit = readFile(path.resolve(process.cwd(), DIR, name))
      .then((body) => (name === "index.html" ? withPreloads(body) : body))
      .then((body) => ({
        body,
        etag: `"${crypto.createHash("sha256").update(body).digest("base64url").slice(0, 22)}"`,
      }));
    hit.catch(() => files.delete(name));
    files.set(name, hit);
  }
  return hit;
}

/** `file` is the path after /admin/: "" for the page, else one of its files. */
export async function serveUi(file: string, request: Request): Promise<Response> {
  const name = file === "" ? "index.html" : file;
  const type = TYPES[path.extname(name)];
  // Flat names only: nothing outside the directory can be asked for.
  if (!type || !/^[a-z0-9-]+(\.[a-z0-9]+)+$/.test(name)) return new Response("not found", { status: 404 });
  let found: { body: Buffer; etag: string };
  try {
    found = await load(name);
  } catch {
    return new Response("not found", { status: 404 });
  }
  const headers = {
    "content-type": type,
    etag: found.etag,
    // Browsers ask every time (a 304 when unchanged); the CDN answers for a day.
    "cache-control": "no-cache",
    "vercel-cdn-cache-control": "max-age=86400",
    ...SECURITY_HEADERS,
  };
  if (request.headers.get("if-none-match") === found.etag) return new Response(null, { status: 304, headers });
  return new Response(found.body, { headers });
}
