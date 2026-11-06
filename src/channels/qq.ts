/**
 * QQ Bot (QQ 开放平台 Bot API v2) over HTTP webhook.
 *
 * Inbound:  QQ POSTs `{ op, id, d, s, t }` to the callback URL, signed with
 *           Ed25519 (seed derived from AppSecret). op:13 = URL validation,
 *           op:0 = event dispatch, answered with `{ op: 12, d: 0 }` ACK.
 * Outbound: REST on api.sgroup.qq.com with `Authorization: QQBot {access_token}`,
 *           replying passively (msg_id + msg_seq) to the inbound message.
 */
import crypto from "node:crypto";
import { config } from "../config.js";
import { pcmToSilk } from "../media/voice.js";
import { ChannelUnreachableError, platformFetch, unreachableReason } from "./net.js";
import { partsToText, personLabel } from "./format.js";
import {
  chunkText,
  json,
  type Attachment,
  type ChannelAdapter,
  type InboundMessage,
  type OutgoingFile,
  type Person,
  type ReceiveResult,
} from "./types.js";

const API_BASE = "https://api.sgroup.qq.com";
const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const OP_DISPATCH = 0;
const OP_HTTP_CALLBACK_ACK = 12;
const OP_VALIDATION = 13;
/**
 * Passive-reply rules (bot-docs send.md): each inbound message can be replied
 * to at most 5 times, within 60 minutes in C2C and 5 minutes in groups (guild
 * channels: 5 minutes too). The window starts at the message's own timestamp.
 */
export const MAX_PASSIVE_REPLIES = 5;
const REPLY_WINDOW_MS: Record<string, number> = {
  c2c: 60 * 60_000,
  group: 5 * 60_000,
  channel: 5 * 60_000,
};
const MAX_CHUNK = 1800;

// ── Ed25519 (QQ spec: repeat secret until >= 32 chars, take first 32 bytes as seed) ──

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function keyPair(secret: string) {
  let seed = secret;
  while (seed.length < 32) seed += seed;
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed.slice(0, 32), "utf8")]),
    format: "der",
    type: "pkcs8",
  });
  return { privateKey, publicKey: crypto.createPublicKey(privateKey) };
}

export function qqSign(secret: string, message: string): string {
  return crypto.sign(null, Buffer.from(message, "utf8"), keyPair(secret).privateKey).toString("hex");
}

export function qqVerify(secret: string, timestamp: string, body: string, signatureHex: string): boolean {
  try {
    const msg = Buffer.from(timestamp + body, "utf8");
    return crypto.verify(null, msg, keyPair(secret).publicKey, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

// ── Access token (cached per warm instance; valid ~7200s) ──

/** Keyed by the credentials it was issued for: they can change in the admin console. */
let cachedToken: { credentials: string; value: string; expiresAt: number } | undefined;

async function getAccessToken(): Promise<string> {
  const credentials = `${config.qq.appId}\n${config.qq.appSecret}`;
  if (cachedToken?.credentials === credentials && Date.now() < cachedToken.expiresAt - 5 * 60_000) return cachedToken.value;
  const res = await platformFetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appId: config.qq.appId, clientSecret: config.qq.appSecret }),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number | string };
  if (!res.ok || !data.access_token) {
    const Err = res.status >= 500 ? ChannelUnreachableError : Error;
    throw new Err(`QQ getAppAccessToken failed: HTTP ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
  }
  cachedToken = { credentials, value: data.access_token, expiresAt: Date.now() + Number(data.expires_in ?? 7200) * 1000 };
  return cachedToken.value;
}

async function qqApi<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await platformFetch(API_BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `QQBot ${await getAccessToken()}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    const Err = res.status >= 500 ? ChannelUnreachableError : Error;
    throw new Err(`QQ POST ${path} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/**
 * Rich media is two steps: upload by URL (QQ fetches it) to get a file_info,
 * then send it as msg_type 7. file_info is reusable per target until its ttl
 * runs out, so cache it per warm instance.
 */
const uploadCache = new Map<string, { fileInfo: string; expiresAt: number }>();

async function uploadImage(base: string, url: string): Promise<string> {
  const key = `${base}|${url}`;
  const hit = uploadCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.fileInfo;
  const res = await qqApi<{ file_info?: string; ttl?: number }>(`${base}/files`, {
    file_type: 1, // image
    url,
    srv_send_msg: false,
  });
  if (!res.file_info) throw new Error(`QQ upload ${base}/files returned no file_info`);
  if (res.ttl && res.ttl > 60) uploadCache.set(key, { fileInfo: res.file_info, expiresAt: Date.now() + (res.ttl - 60) * 1000 });
  return res.file_info;
}

/** QQ media types for /files: 1 image (png/jpg), 2 video (mp4), 3 voice (silk/mp3/wav), 4 any file. */
function qqFileType(name: string): number {
  if (/\.(png|jpe?g|gif)$/i.test(name)) return 1;
  if (/\.mp4$/i.test(name)) return 2;
  if (/\.(silk|mp3|wav)$/i.test(name)) return 3;
  return 4;
}

/**
 * Claim the next passive-reply slot for this inbound message and return its
 * msg_seq. Fails fast (before calling QQ) when the reply window has passed or
 * all slots are used; the error reaches the model as a tool error.
 */
function nextSeq(replyContext: Record<string, string>): number {
  const expiresAt = Number(replyContext.expiresAt ?? Infinity);
  if (Date.now() > expiresAt) {
    const minutes = Math.round((REPLY_WINDOW_MS[replyContext.scope!] ?? 0) / 60_000);
    throw new Error(`reply window closed: QQ only accepts replies within ${minutes} minutes of the message`);
  }
  const seq = Number(replyContext.seq ?? 0) + 1;
  if (seq > MAX_PASSIVE_REPLIES) {
    throw new Error(`QQ allows at most ${MAX_PASSIVE_REPLIES} replies per message`);
  }
  replyContext.seq = String(seq);
  return seq;
}

// ── Payload types (only the fields we use) ──

interface QQPayload {
  op: number;
  id?: string;
  t?: string;
  d?: Record<string, unknown>;
}

interface QQMessageEvent {
  id: string;
  content?: string;
  /** When the user sent it, e.g. "2026-11-03T20:43:00+08:00". */
  timestamp?: string;
  author?: { id?: string; user_openid?: string; member_openid?: string; username?: string; bot?: boolean };
  /** Who the message @-mentions: `is_you` marks this bot; scope "all" is @全体成员. */
  mentions?: QQMention[];
  /** Images, voice (with QQ's own transcript), video, files. URLs may start with "//". */
  attachments?: Array<{ content_type?: string; url?: string; filename?: string; asr_refer_text?: string }>;
  group_openid?: string;
  channel_id?: string;
  guild_id?: string;
  /**
   * Undocumented, but what QQ sends (and what NoneBot / nanobot read): a reply
   * to an earlier message has message_type 103, `message_scene.ext` holds
   * "ref_msg_idx=X", and the quoted message is the `msg_elements` entry whose
   * `msg_idx` is X.
   */
  message_type?: number;
  message_scene?: { ext?: unknown };
  msg_elements?: QQQuotedElement[];
}

interface QQMention {
  scope?: string;
  id?: string;
  member_openid?: string;
  user_openid?: string;
  username?: string;
  bot?: boolean;
  is_you?: boolean;
}

interface QQQuotedElement {
  msg_idx?: string;
  content?: string;
  attachments?: QQMessageEvent["attachments"];
  author?: { bot?: boolean; username?: string; member_openid?: string; user_openid?: string; id?: string };
}

/** Longest quoted text shown to the model. */
const MAX_QUOTE_CHARS = 500;

/** A "key=value" entry of `message_scene.ext` (e.g. msg_idx, ref_msg_idx). */
function sceneExt(d: QQMessageEvent, key: string): string | undefined {
  const ext = Array.isArray(d.message_scene?.ext) ? d.message_scene.ext : [];
  return ext.find((v): v is string => typeof v === "string" && v.startsWith(`${key}=`))?.slice(key.length + 1) || undefined;
}

/** The message this one quotes (a reply in QQ's UI), if any. */
function quotedElement(d: QQMessageEvent): QQQuotedElement | undefined {
  const ref = sceneExt(d, "ref_msg_idx");
  if (!ref || !Array.isArray(d.msg_elements)) return undefined;
  return d.msg_elements.find((e) => e?.msg_idx === ref);
}

/** Who wrote the quoted message, as the model knows people: 你 for the bot, else nickname + short id. */
function quotedAuthor(a: QQQuotedElement["author"]): string {
  if (a?.bot) return "你";
  const openid = a?.member_openid ?? a?.user_openid ?? a?.id ?? "";
  return openid ? personLabel(openid, a?.username) : a?.username || "某人";
}

/**
 * The quoted message as a line before the text, e.g. "[引用 你 的消息：好呀\n[图片]]";
 * its images and files join this message's, so the model sees them and
 * save_attachment can fetch them (after the message's own).
 */
function quoteOf(d: QQMessageEvent) {
  const q = quotedElement(d);
  if (!q) {
    // The format is undocumented: say so when QQ marks a reply but it isn't where we look.
    if (d.message_type === 103) {
      console.warn(`[qq] ${d.id}: a reply, but no quoted message found (ext=${JSON.stringify(d.message_scene?.ext)}, elements=${d.msg_elements?.length ?? 0})`);
    }
    return undefined;
  }
  const parsed = parseAttachments(q.attachments);
  let text = renderMentions(q.content).text;
  if (text.length > MAX_QUOTE_CHARS) text = `${text.slice(0, MAX_QUOTE_CHARS)}…`;
  const body = [text, ...parsed.images.map(() => "[图片]"), ...parsed.notes].filter(Boolean).join("\n") || "（内容没收到）";
  console.log(`[qq] ${d.id}: quotes ${q.author?.bot ? "the bot" : "a member"} (${text.length} chars, ${parsed.attachments.length} attachment(s))`);
  return { line: `[引用 ${quotedAuthor(q.author)} 的消息：${body}]`, ...parsed };
}

/**
 * Whether the message @-s this bot by name: a `mentions` entry marked
 * `is_you`, or a `<@!AppID>` marker in the text. @全体成员 doesn't count,
 * though QQ marks it `is_you` too (scope "all").
 */
function mentionsBot(d: QQMessageEvent): boolean {
  if (d.mentions?.some((m) => m?.is_you === true && m.scope !== "all")) return true;
  const appId = config.qq.appId;
  return Boolean(appId) && new RegExp(`<@!?${appId}>`).test(d.content ?? "");
}

/** A mention in the text: `<qqbot-at-user id="…" />`, or the older `<@…>` / `<@!…>`. */
const MENTION_TAG = /<qqbot-at-user id="(\w+)"\s*\/>|<@!?(\w+)>/g;
const EVERYONE_TAG = /<qqbot-at-everyone\s*\/>/g;
/** A QQ face (emoji, sticker, dice…): `<faceType=1,faceId="13",ext="base64 of {"text":"吃瓜"}">`. */
const FACE_TAG = /<faceType=(\d+),faceId="(\d+)",ext="([^"]*)">/g;

/**
 * A face as the model reads it: "[表情：吃瓜]". Fields of `ext` besides its
 * name are kept as they are ("[表情：骰子 resultId=3]"): what QQ puts there
 * for dice and the like isn't documented, and the model can read it.
 */
function renderFace(faceType: string, faceId: string, ext: string): string {
  let info: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(Buffer.from(ext, "base64").toString("utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) info = parsed as Record<string, unknown>;
  } catch {
    // Not base64 JSON: the face is still a face.
  }
  const { text, ...rest } = info;
  const name = typeof text === "string" ? text.replace(/^\[|\]$/g, "").trim() : "";
  const extra = Object.entries(rest)
    .filter(([, v]) => v !== "" && v !== null && typeof v !== "object")
    .map(([k, v]) => `${k}=${String(v)}`);
  // Logged whole while the format is unknown: what a dice roll carries shows up here.
  console.log(`[qq] face type=${faceType} id=${faceId} ext=${JSON.stringify(info).slice(0, 300)}`);
  return `[表情：${[name || "未知", ...extra].join(" ")}]`;
}

/**
 * Mentions as the model reads people: "@昵称 #3B6834" (names from the
 * `mentions` list), "@全体成员". Mentions of this bot are dropped: the message
 * header already says "@你". Also returns the people mentioned.
 */
function renderMentions(content: string | undefined, mentions: QQMention[] = []): { text: string; people: Person[] } {
  const byId = new Map<string, QQMention>();
  for (const m of mentions) for (const id of [m.id, m.member_openid, m.user_openid]) if (id) byId.set(id, m);
  const people: Person[] = [];
  const text = (content ?? "")
    .replace(MENTION_TAG, (_tag, tagged: string | undefined, legacy: string | undefined) => {
      const id = (tagged ?? legacy)!;
      const m = byId.get(id);
      if (m?.is_you || id === config.qq.appId) return "";
      if (m?.bot) return `@${m.username || "机器人"}`;
      const userId = m?.member_openid ?? m?.user_openid ?? id;
      people.push({ userId, ...(m?.username ? { name: m.username } : {}) });
      return `@${personLabel(userId, m?.username)}`;
    })
    .replace(EVERYONE_TAG, "@全体成员")
    .replace(FACE_TAG, (_tag, faceType: string, faceId: string, ext: string) => renderFace(faceType, faceId, ext))
    .trim();
  return { text, people };
}

/**
 * Split attachments into images (for the model to look at) and text notes:
 * voice becomes QQ's own transcript ("[语音] …"), video and files a placeholder.
 * Every attachment with a link is also kept as-is, so its original can be saved later.
 */
function parseAttachments(list: QQMessageEvent["attachments"] = []) {
  const images: Array<{ url: string; contentType: string }> = [];
  const notes: string[] = [];
  const attachments: Attachment[] = [];
  for (const a of list) {
    const type = a.content_type ?? "";
    const url = a.url?.startsWith("//") ? `https:${a.url}` : (a.url ?? "");
    if (url.startsWith("https://")) attachments.push({ name: a.filename ?? "", url, contentType: type });
    if (type.startsWith("image/") && url.startsWith("https://")) images.push({ url, contentType: type });
    else if (type === "voice" || type.startsWith("audio/")) notes.push(a.asr_refer_text ? `[语音] ${a.asr_refer_text}` : "[语音]");
    else if (type.startsWith("video/")) notes.push("[视频]");
    else notes.push(`[文件${a.filename ? `：${a.filename}` : ""}]`);
  }
  return { images, notes, attachments };
}

function toInbound(t: string, d: QQMessageEvent): InboundMessage | undefined {
  const message = parseEvent(t, d);
  if (!message) return undefined;
  const { images, notes, attachments } = parseAttachments(d.attachments);
  const quote = quoteOf(d);
  if (quote) {
    images.push(...quote.images);
    attachments.push(...quote.attachments);
  }
  if (images.length) message.images = images;
  if (attachments.length) message.attachments = attachments;
  message.text = [quote?.line, message.text, ...notes].filter(Boolean).join("\n");
  // A bare "@大肥鱼" has no text once the mention is stripped, but it's still someone calling the bot.
  if (message.mode !== "ambient" && !message.text && !images.length) message.text = "（只 @ 了你，没说话）";
  const window = REPLY_WINDOW_MS[message.replyContext.scope!];
  if (window) {
    // Prefer the message's own time; fall back to now. Never trust a time in the future.
    const sentAt = Math.min(Date.parse(d.timestamp ?? "") || Date.now(), Date.now());
    message.replyContext.expiresAt = String(sentAt + window);
  }
  return message;
}

function parseEvent(t: string, d: QQMessageEvent): InboundMessage | undefined {
  const { text, people } = renderMentions(d.content, d.mentions);
  const base = { channel: "qq", eventId: d.id, text, ...(people.length ? { mentions: people } : {}) };
  // What a reply quoting this message points at (see replyV2).
  const refIdx = sceneExt(d, "msg_idx");
  const quotable: Record<string, string> = refIdx ? { refIdx } : {};
  switch (t) {
    case "C2C_MESSAGE_CREATE": {
      const openid = d.author?.user_openid ?? "";
      return {
        ...base,
        conversationId: `c2c:${openid}`,
        chatType: "private",
        userId: openid,
        replyContext: { scope: "c2c", target: openid, msgId: d.id, ...quotable },
      };
    }
    // GROUP_AT_MESSAGE_CREATE: someone @-ed the bot. GROUP_MESSAGE_CREATE: every
    // group message, delivered only when the group owner lets the bot receive
    // all messages; it may also cover @ messages, so check for a mention.
    case "GROUP_AT_MESSAGE_CREATE":
    case "GROUP_MESSAGE_CREATE": {
      if (d.author?.bot) return undefined; // never react to other bots
      const group = d.group_openid ?? "";
      // An @全体成员 may come as GROUP_AT_MESSAGE_CREATE too: only an @ of the bot itself wakes it.
      const everyone = d.mentions?.some((m) => m?.scope === "all") ?? false;
      const mentioned = mentionsBot(d) || (t === "GROUP_AT_MESSAGE_CREATE" && !everyone);
      return {
        ...base,
        conversationId: `group:${group}`,
        chatType: "group",
        mode: mentioned ? "direct" : "ambient",
        userId: d.author?.member_openid ?? "",
        senderName: d.author?.username || undefined,
        replyContext: { scope: "group", target: group, msgId: d.id, ...quotable },
      };
    }
    case "AT_MESSAGE_CREATE": {
      const channelId = d.channel_id ?? "";
      return {
        ...base,
        conversationId: `channel:${channelId}`,
        chatType: "group",
        userId: d.author?.id ?? "",
        replyContext: { scope: "channel", target: channelId, msgId: d.id },
      };
    }
    case "DIRECT_MESSAGE_CREATE": {
      const guildId = d.guild_id ?? "";
      return {
        ...base,
        conversationId: `dm:${guildId}`,
        chatType: "private",
        userId: d.author?.id ?? "",
        replyContext: { scope: "dm", target: guildId, msgId: d.id },
      };
    }
    default:
      return undefined;
  }
}

const ACK = () => json({ op: OP_HTTP_CALLBACK_ACK, d: 0 });

export const qqAdapter: ChannelAdapter = {
  name: "qq",
  label: "QQ",
  replyRule: "QQ 只能回复最近的消息：群里 5 分钟内、私聊 60 分钟内要有人说话，每条消息最多回 5 次",
  promptHint: "This is QQ: reply in plain text, no Markdown syntax. Keep replies under 1500 characters.",
  /** Passive replies: 5 per inbound message (bot-docs send.md). */
  maxRepliesPerMessage: 5,

  isConfigured() {
    return Boolean(config.qq.appId && config.qq.appSecret);
  },

  async verify() {
    await getAccessToken();
    return `AppID ${config.qq.appId} 拿到了 access token`;
  },

  async receive(req, rawBody): Promise<ReceiveResult> {
    let payload: QQPayload;
    try {
      payload = JSON.parse(rawBody) as QQPayload;
    } catch {
      return { kind: "respond", response: json({ error: "invalid json" }, 400) };
    }

    // Callback URL validation: sign event_ts + plain_token.
    if (payload.op === OP_VALIDATION) {
      const plainToken = String(payload.d?.plain_token ?? "");
      const eventTs = String(payload.d?.event_ts ?? "");
      // The platform rejects the URL if AppSecret is stale; the AppID header shows which bot is asking.
      const botAppId = req.headers.get("x-bot-appid") ?? "";
      console.log(`[qq] callback validation from appid=${botAppId || "?"} (configured ${config.qq.appId}, match=${botAppId === config.qq.appId})`);
      if (!plainToken || !eventTs) return { kind: "respond", response: json({ error: "invalid validation" }, 400) };
      return {
        kind: "respond",
        response: json({ plain_token: plainToken, signature: qqSign(config.qq.appSecret, eventTs + plainToken) }),
      };
    }

    const timestamp = req.headers.get("x-signature-timestamp") ?? "";
    const signature = req.headers.get("x-signature-ed25519") ?? "";
    if (!timestamp || !signature || !qqVerify(config.qq.appSecret, timestamp, rawBody, signature)) {
      console.warn(`[qq] rejected event: bad signature (appid=${req.headers.get("x-bot-appid") ?? "?"}); is QQ_APP_SECRET current?`);
      return { kind: "respond", response: json({ error: "invalid signature" }, 401) };
    }

    if (payload.op !== OP_DISPATCH || !payload.t || !payload.d) return { kind: "respond", response: ACK() };

    const message = toInbound(payload.t, payload.d as unknown as QQMessageEvent);
    if (!message || (!message.text && !message.images?.length)) return { kind: "respond", response: ACK() };
    return { kind: "message", message, ack: ACK() };
  },

  // Called once per outgoing message; several calls may answer the same inbound
  // msg_id, so msg_seq keeps counting across calls via replyContext.seq.
  async send(message, text) {
    const ctx = message.replyContext;
    const { scope, target, msgId } = ctx;
    for (const [i, content] of chunkText(text, MAX_CHUNK).entries()) {
      switch (scope) {
        case "c2c":
        case "group":
          // Only the first piece of a long text quotes.
          await replyV2(i === 0 ? message : { ...message, quote: false }, { content, msg_type: 0 });
          break;
        case "channel":
          nextSeq(ctx);
          await qqApi(`/channels/${target}/messages`, { content, msg_id: msgId });
          break;
        case "dm":
          nextSeq(ctx);
          await qqApi(`/dms/${target}/messages`, { content, msg_id: msgId });
          break;
      }
    }
  },

  /**
   * Groups only take @-mentions in Markdown messages (bot-docs text-chain:
   * <qqbot-at-user id="member_openid" />, msg_type 2; open to every bot since
   * 2026-04-23). If QQ refuses the Markdown, the text goes out plain with
   * "@昵称" instead, so the message still arrives.
   */
  async sendMentions(message, parts) {
    const plain = partsToText(parts);
    if (message.replyContext.scope !== "group" || plain.length > MAX_CHUNK) return qqAdapter.send!(message, plain);
    const content = parts.map((p) => (typeof p === "string" ? escapeMarkdown(p) : `<qqbot-at-user id="${p.mention.userId}" />`)).join("");
    try {
      await replyV2(message, { msg_type: 2, markdown: { content } });
    } catch (err) {
      // QQ unreachable: the outbox stops the run; a retry here could post the message twice.
      if (unreachableReason(err)) throw err;
      console.warn(`[qq] markdown with mentions refused, sending plain text: ${err instanceof Error ? err.message : String(err)}`);
      await qqAdapter.send!(message, plain);
    }
  },

  async sendImage(message, url) {
    const ctx = message.replyContext;
    const { scope, target, msgId } = ctx;
    switch (scope) {
      case "c2c":
      case "group": {
        const fileInfo = await uploadImage(v2Base(scope, target!), url);
        await replyV2(message, { msg_type: 7, media: { file_info: fileInfo } });
        break;
      }
      // Guild channels take the image URL directly.
      case "channel":
        nextSeq(ctx);
        await qqApi(`/channels/${target}/messages`, { image: url, msg_id: msgId });
        break;
      case "dm":
        nextSeq(ctx);
        await qqApi(`/dms/${target}/messages`, { image: url, msg_id: msgId });
        break;
    }
  },

  sendFile: uploadAndSend,

  // QQ plays SILK inline as a voice message (file_type 3).
  async sendVoice(message, voice) {
    filesTarget(message);
    const { data } = await pcmToSilk(voice.pcm, voice.sampleRate);
    await uploadAndSend(message, { name: "voice.silk", data });
  },
};

/** Where c2c / group files go; guild channels can't take files from bots. */
function filesTarget(message: InboundMessage): string {
  const { scope, target } = message.replyContext;
  if (scope !== "c2c" && scope !== "group") throw new Error("QQ guild channels can't receive files from bots");
  return v2Base(scope, target!);
}

/** Upload the bytes directly (file_data, base64, up to 5 MB), then send them as msg_type 7. */
async function uploadAndSend(message: InboundMessage, file: OutgoingFile): Promise<void> {
  const base = filesTarget(message);
  const res = await qqApi<{ file_info?: string }>(`${base}/files`, {
    file_type: qqFileType(file.name),
    file_name: file.name,
    file_data: file.data.toString("base64"),
    srv_send_msg: false,
  });
  if (!res.file_info) throw new Error(`QQ upload ${base}/files returned no file_info`);
  await replyV2(message, { msg_type: 7, media: { file_info: res.file_info } });
}

/**
 * Chat text inside a Markdown message stays literal: escape what Markdown reads
 * as formatting (emphasis, code, links) and line starts that make headings,
 * quotes or lists.
 */
function escapeMarkdown(text: string): string {
  return text
    .replace(/[\\`*_~[\]]/g, "\\$&")
    .replace(/^(\s*)([#>+-])/gm, "$1\\$2")
    .replace(/^(\s*\d+)\./gm, "$1\\.");
}

/**
 * A passive reply in a v2 chat (c2c or group): the message's msg_id and the
 * next msg_seq, plus, when the agent asked to quote (message.quote), a
 * message_reference to the message's msg_idx, which QQ shows as a 回复 box.
 * The quote isn't in QQ's docs (NoneBot sends it the same way), so if QQ
 * refuses a quoted reply, it goes again without the quote.
 */
async function replyV2(message: InboundMessage, body: Record<string, unknown>): Promise<void> {
  const ctx = message.replyContext;
  const path = `${v2Base(ctx.scope!, ctx.target!)}/messages`;
  const post = (quote: boolean) =>
    qqApi(path, { ...body, msg_id: ctx.msgId, msg_seq: nextSeq(ctx), ...(quote ? { message_reference: { message_id: ctx.refIdx } } : {}) });
  if (!message.quote || !ctx.refIdx) {
    await post(false);
    return;
  }
  try {
    await post(true);
  } catch (err) {
    // QQ unreachable: the outbox stops the run; resending could post the message twice.
    if (unreachableReason(err)) throw err;
    console.warn(`[qq] quoted reply refused, sending it without the quote: ${err instanceof Error ? err.message : String(err)}`);
    await post(false);
  }
}

function v2Base(scope: string, target: string): string {
  return scope === "c2c" ? `/v2/users/${target}` : `/v2/groups/${target}`;
}
