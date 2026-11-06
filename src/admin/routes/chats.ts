/** Chats: the list, one chat's history and events, its settings, and acting in it. */
import { waitUntil } from "@vercel/functions";
import { channels } from "../../channels/index.js";
import { daysBefore, utcDay } from "../../chats/day.js";
import { historyAfter, historyBefore } from "../../chats/history.js";
import { ambientInterval, parseProfile, PROFILE_CHOICES, replyMode, saveChatProfile, validateProfile } from "../../chats/profile.js";
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

/** A seq from the query string, or undefined. */
function seqParam(req: AdminRequest, name: string): number | undefined {
  const value = req.query.get(name);
  return value !== null && /^-?\d+$/.test(value) ? Number(value) : undefined;
}

function limitParam(req: AdminRequest): number {
  const n = Number(req.query.get("limit") ?? PAGE);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 500) : PAGE;
}

/** A chat as the console lists it: what's stored, plus the settings in effect. */
function view(c: ChatSummary) {
  const profile = parseProfile(c.profile ?? {});
  const channel = c.channel ?? c.chat.split(":")[0]!;
  const adapter = channels.get(channel);
  const mode = replyMode(profile);
  return {
    ...c,
    channel,
    channelLabel: adapter?.label ?? channel,
    profile,
    mode,
    modeLabel: PROFILE_CHOICES.modes.find((o) => o.value === mode)?.label ?? mode,
    ambientIntervalSeconds: ambientInterval(profile),
    canSend: Boolean(adapter?.send),
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
        store.chat(chat, today),
        store.usage(chat, daysBefore(today, 6), today),
        replyWindow(chat),
      ]);
      if (!summary) throw new HttpError(404, "没有这个聊天");
      return {
        ...view(summary),
        usageByDay: usage,
        replyWindow: window,
        defaults: { mode: replyMode({}), ambientIntervalSeconds: config.agent.ambientIntervalSeconds },
        choices: PROFILE_CHOICES,
      };
    },
  },
  {
    method: "GET",
    // Who said what, rendered from the event log: what's new after event `after`, else a page before event `before`.
    path: "chat/history",
    handler(req) {
      const chat = chatParam(req);
      const after = seqParam(req, "after");
      if (after !== undefined) return historyAfter(getStore(), chat, after);
      return historyBefore(getStore(), chat, seqParam(req, "before") ?? Number.MAX_SAFE_INTEGER, limitParam(req));
    },
  },
  {
    method: "GET",
    // The raw log: new events after `after` (polling), else a page before `before`, newest first.
    path: "chat/events",
    handler(req) {
      const chat = chatParam(req);
      const after = seqParam(req, "after");
      if (after !== undefined) return getStore().open(chat, after);
      return getStore().recentEvents(chat, seqParam(req, "before") ?? Number.MAX_SAFE_INTEGER, limitParam(req));
    },
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
