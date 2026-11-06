/** Chats: the list, one chat's history and events, its settings, and acting in it. */
import { waitUntil } from "@vercel/functions";
import { channels } from "../../channels/index.js";
import { daysBefore, utcDay } from "../../chats/day.js";
import { historyFromEvents } from "../../chats/history.js";
import type { SessionEvent } from "../../conversation/events.js";
import { ambientInterval, parseProfile, replyMode, saveChatProfile, validateProfile } from "../../chats/profile.js";
import { config } from "../../config.js";
import { getStore, type ChatSummary } from "../../store/index.js";
import { replyWindow, resetChat, say, unlockChat, whisper } from "../chat-actions.js";
import { field, HttpError, type AdminRequest, type Route } from "../http.js";

const PAGE = 100;

function chatParam(req: AdminRequest): string {
  const chat = req.query.get("chat");
  if (!chat) throw new HttpError(400, "缺少 chat");
  return chat;
}

function limitParam(req: AdminRequest): number {
  const n = Number(req.query.get("limit") ?? PAGE);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 500) : PAGE;
}

/** A chat as the console lists it: what's stored, plus the settings in effect. */
function view(c: ChatSummary) {
  const profile = parseProfile(c.profile ?? {});
  const channel = c.channel ?? c.chat.split(":")[0]!;
  return {
    ...c,
    channel,
    profile,
    mode: replyMode(profile),
    ambientIntervalSeconds: ambientInterval(profile),
    canSend: Boolean(channels.get(channel)?.send),
  };
}

export const chatRoutes: Route[] = [
  {
    method: "GET",
    path: "chats",
    handler: async () => (await getStore().chats(utcDay())).map(view),
  },
  {
    method: "GET",
    path: "chat",
    async handler(req) {
      const chat = chatParam(req);
      const store = getStore();
      const today = utcDay();
      const [summary, usage, window] = await Promise.all([
        store.chats(today).then((all) => all.find((c) => c.chat === chat)),
        store.usage(chat, daysBefore(today, 6), today),
        replyWindow(chat),
      ]);
      if (!summary) throw new HttpError(404, "没有这个聊天");
      return {
        ...view(summary),
        usageByDay: usage,
        replyWindow: window,
        defaults: { mode: config.console.defaultMode, ambientIntervalSeconds: config.agent.ambientIntervalSeconds },
      };
    },
  },
  {
    method: "GET",
    // Who said what, rendered from the event log: up to `limit` lines before event `before`, newest first.
    path: "chat/history",
    async handler(req) {
      const before = Number(req.query.get("before")) || Number.MAX_SAFE_INTEGER;
      const { events } = await getStore().open(chatParam(req), -1);
      return historyFromEvents(events as SessionEvent[])
        .filter((line) => line.seq < before)
        .reverse()
        .slice(0, limitParam(req));
    },
  },
  {
    method: "GET",
    path: "chat/events",
    handler: (req) => getStore().recentEvents(chatParam(req), Number(req.query.get("before")) || Number.MAX_SAFE_INTEGER, limitParam(req)),
  },
  { method: "GET", path: "chat/reply-window", handler: (req) => replyWindow(chatParam(req)) },
  {
    method: "PUT",
    path: "chat/profile",
    async handler(req) {
      const body = await req.json();
      const chat = field(body, "chat");
      const checked = validateProfile(body.profile);
      if ("errors" in checked) throw new HttpError(400, "有设置没填对", checked.errors);
      await saveChatProfile(chat, checked.profile);
      await getStore().log("profile", chat, { profile: checked.profile });
      return checked.profile;
    },
  },
  {
    method: "POST",
    path: "chat/say",
    async handler(req) {
      const body = await req.json();
      return say(field(body, "chat"), field(body, "text"));
    },
  },
  {
    method: "POST",
    path: "chat/whisper",
    async handler(req) {
      const body = await req.json();
      return whisper(field(body, "chat"), field(body, "text"), req.origin, waitUntil);
    },
  },
  {
    method: "POST",
    path: "chat/reset",
    async handler(req) {
      await resetChat(field(await req.json(), "chat"));
      return { ok: true };
    },
  },
  {
    method: "POST",
    path: "chat/unlock",
    handler: async (req) => ({ released: await unlockChat(field(await req.json(), "chat")) }),
  },
];
