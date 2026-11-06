/**
 * The admin API's plumbing: a request wrapper, a tiny router and JSON errors.
 * Routes return plain data (sent as JSON) or a Response.
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Per-field messages for forms. */
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface AdminRequest {
  request: Request;
  method: string;
  /** The path after /api/admin/, e.g. "chats/qq%3Agroup%3Aabc/events" split and decoded. */
  segments: string[];
  query: URLSearchParams;
  /** The public origin the browser used (behind Vercel's proxy). */
  origin: string;
  ip: string;
  /** The parsed JSON body ({} when empty). */
  json<T = Record<string, unknown>>(): Promise<T>;
}

export type Handler = (req: AdminRequest, params: Record<string, string>) => Promise<unknown> | unknown;

export interface Route {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Segments; ":name" matches one and passes it in params. */
  path: string;
  handler: Handler;
  /** Reachable without logging in. */
  public?: boolean;
}

export function matchRoute(routes: Route[], method: string, segments: string[]): { route: Route; params: Record<string, string> } | undefined {
  for (const route of routes) {
    if (route.method !== method) continue;
    const parts = route.path.split("/").filter(Boolean);
    if (parts.length !== segments.length) continue;
    const params: Record<string, string> = {};
    if (parts.every((p, i) => (p.startsWith(":") ? ((params[p.slice(1)] = segments[i]!), true) : p === segments[i]))) return { route, params };
  }
  return undefined;
}

export function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data ?? null), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) return jsonResponse({ error: err.message, ...(err.fields ? { fields: err.fields } : {}) }, err.status);
  console.error("[admin] request failed", err);
  return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
}

/** A required string field of a JSON body. */
export function field(body: Record<string, unknown>, name: string, opts: { max?: number; optional?: boolean } = {}): string {
  const value = body[name];
  if (value === undefined || value === null || value === "") {
    if (opts.optional) return "";
    throw new HttpError(400, `缺少 ${name}`);
  }
  if (typeof value !== "string") throw new HttpError(400, `${name} 要是字符串`);
  if (opts.max && value.length > opts.max) throw new HttpError(400, `${name} 太长了（最多 ${opts.max} 字）`);
  return value;
}
