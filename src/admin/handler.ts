/**
 * The admin console: the page at /admin and its API at /api/admin/*, served
 * by one function (api/admin.ts; vercel.json rewrites both paths to it).
 *
 * Every API route needs a login (auth.ts) except the session routes.
 */
import { refreshSettings } from "../settings/service.js";
import { publicOrigin } from "../webhook.js";
import { checkSameOrigin, isLoggedIn } from "./auth.js";
import { errorResponse, HttpError, jsonResponse, matchRoute, type AdminRequest, type Route } from "./http.js";
import { chatRoutes } from "./routes/chats.js";
import { overviewRoutes } from "./routes/overview.js";
import { sessionRoutes } from "./routes/session.js";
import { settingsRoutes } from "./routes/settings.js";
import { setupRoutes } from "./routes/setup.js";
import { serveUi } from "./ui.js";

const routes: Route[] = [...sessionRoutes, ...setupRoutes, ...settingsRoutes, ...chatRoutes, ...overviewRoutes];

/** What a request is for: Vercel's rewrites pass the original path in __api / __ui; the dev server passes it as is. */
function target(url: URL): { api: string[] } | { ui: string } | undefined {
  const split = (p: string) => p.split("/").filter(Boolean).map(decodeURIComponent);
  const api = url.searchParams.get("__api");
  if (api !== null) return { api: split(api) };
  const ui = url.searchParams.get("__ui");
  if (ui !== null) return { ui };
  if (url.pathname === "/api/admin" || url.pathname.startsWith("/api/admin/")) return { api: split(url.pathname.slice("/api/admin".length)) };
  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return { ui: url.pathname.slice("/admin".length).replace(/^\/+/, "") };
  return undefined;
}

function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}

export async function handleAdmin(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const to = target(url);
  if (!to) return new Response("not found", { status: 404 });
  if ("ui" in to) return serveUi(to.ui, request);

  try {
    await refreshSettings();
    let body: Promise<unknown> | undefined;
    const req: AdminRequest = {
      request,
      method: request.method,
      segments: to.api,
      query: url.searchParams,
      origin: publicOrigin(request),
      ip: clientIp(request),
      json<T>() {
        body ??= request.text().then((text) => {
          if (!text) return {};
          try {
            return JSON.parse(text) as unknown;
          } catch {
            throw new HttpError(400, "请求体不是合法的 JSON");
          }
        });
        return body as Promise<T>;
      },
    };
    const match = matchRoute(routes, request.method, to.api);
    if (!match) throw new HttpError(404, `没有这个接口：${request.method} /api/admin/${to.api.join("/")}`);
    checkSameOrigin(req);
    if (!match.route.public && !isLoggedIn(request)) throw new HttpError(401, "请先登录");
    const result = await match.route.handler(req, match.params);
    return result instanceof Response ? result : jsonResponse(result);
  } catch (err) {
    return errorResponse(err);
  }
}
