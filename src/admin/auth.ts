/**
 * Logging in to the console: one password, ADMIN_PASSWORD (environment only).
 * A login sets an HttpOnly, SameSite=Strict cookie holding an expiry and its
 * HMAC under a key derived from the password, so changing the password ends
 * every session. Failed attempts are counted per IP in the database.
 */
import crypto from "node:crypto";
import { config } from "../config.js";
import type { ConsoleStore } from "../store/index.js";
import { HttpError, type AdminRequest } from "./http.js";

const COOKIE = "sag_admin";
const SESSION_MS = 7 * 24 * 3600_000;
const FAILURE_WINDOW_S = 15 * 60;
const MAX_FAILURES = 10;

const sha256 = (data: string) => crypto.createHash("sha256").update(data).digest();

function sign(expires: number, password: string): string {
  return crypto.createHmac("sha256", sha256(`admin-session:${password}`)).update(String(expires)).digest("base64url");
}

function cookieOf(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

export function isLoggedIn(request: Request): boolean {
  const password = config.admin.password;
  const [expires, signature] = (cookieOf(request, COOKIE) ?? "").split(".");
  if (!password || !expires || !signature || Number(expires) < Date.now()) return false;
  const expected = Buffer.from(sign(Number(expires), password));
  const actual = Buffer.from(signature);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function cookie(value: string, maxAgeS: number, secure: boolean): string {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${secure ? "; Secure" : ""}`;
}

/** Check the password; returns the Set-Cookie header for a new session. */
export async function login(req: AdminRequest, password: string, store: ConsoleStore): Promise<string> {
  const expected = config.admin.password;
  if (!expected) throw new HttpError(503, "还没有设置 ADMIN_PASSWORD");
  if ((await store.loginFailures(req.ip, false, FAILURE_WINDOW_S)) >= MAX_FAILURES) {
    throw new HttpError(429, "密码错太多次了，15 分钟后再试");
  }
  if (!crypto.timingSafeEqual(sha256(password), sha256(expected))) {
    await store.loginFailures(req.ip, true, FAILURE_WINDOW_S);
    throw new HttpError(401, "密码不对");
  }
  const expires = Date.now() + SESSION_MS;
  return cookie(`${expires}.${sign(expires, expected)}`, SESSION_MS / 1000, req.origin.startsWith("https:"));
}

export function logoutCookie(req: AdminRequest): string {
  return cookie("", 0, req.origin.startsWith("https:"));
}

/**
 * Requests that change something must come from the console's own page: a
 * JSON body (a cross-site form can't send one without a preflight) and, when
 * the browser says where it came from, our own origin.
 */
export function checkSameOrigin(req: AdminRequest): void {
  if (req.method === "GET") return;
  const origin = req.request.headers.get("origin");
  if (origin && origin !== req.origin) throw new HttpError(403, "跨站请求被拒绝");
  if (!(req.request.headers.get("content-type") ?? "").includes("application/json")) throw new HttpError(415, "要用 JSON");
}
