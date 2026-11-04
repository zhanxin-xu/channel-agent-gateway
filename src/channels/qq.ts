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
import { ChannelUnreachableError, platformFetch } from "./net.js";
import { chunkText, json, type Attachment, type ChannelAdapter, type InboundMessage, type OutgoingFile, type ReceiveResult } from "./types.js";

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

let cachedToken: { value: string; expiresAt: number } | undefined;

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 5 * 60_000) return cachedToken.value;
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
  cachedToken = { value: data.access_token, expiresAt: Date.now() + Number(data.expires_in ?? 7200) * 1000 };
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
  /** Present on some group payloads; `is_you` marks a mention of this bot. */
  mentions?: Array<{ is_you?: boolean }>;
  /** Images, voice (with QQ's own transcript), video, files. URLs may start with "//". */
  attachments?: Array<{ content_type?: string; url?: string; filename?: string; asr_refer_text?: string }>;
  group_openid?: string;
  channel_id?: string;
  guild_id?: string;
}

/** Same signals as the official SDK: `mentions[].is_you`, or a `<@!AppID>` marker in the text. */
function mentionsBot(d: QQMessageEvent): boolean {
  if (d.mentions?.some((m) => m?.is_you === true)) return true;
  const appId = config.qq.appId;
  return Boolean(appId) && new RegExp(`<@!?${appId}>`).test(d.content ?? "");
}

/** Strip channel-style mentions (`<@!123>`) and surrounding whitespace. */
function cleanContent(content: string | undefined): string {
  return (content ?? "").replace(/<@!?\w+>/g, "").trim();
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
  if (images.length) message.images = images;
  if (attachments.length) message.attachments = attachments;
  if (notes.length) message.text = [message.text, ...notes].filter(Boolean).join("\n");
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
  const base = { channel: "qq", eventId: d.id, text: cleanContent(d.content) };
  switch (t) {
    case "C2C_MESSAGE_CREATE": {
      const openid = d.author?.user_openid ?? "";
      return {
        ...base,
        conversationId: `c2c:${openid}`,
        chatType: "private",
        userId: openid,
        replyContext: { scope: "c2c", target: openid, msgId: d.id },
      };
    }
    // GROUP_AT_MESSAGE_CREATE: someone @-ed the bot. GROUP_MESSAGE_CREATE: every
    // group message, delivered only when the group owner lets the bot receive
    // all messages; it may also cover @ messages, so check for a mention.
    case "GROUP_AT_MESSAGE_CREATE":
    case "GROUP_MESSAGE_CREATE": {
      if (d.author?.bot) return undefined; // never react to other bots
      const group = d.group_openid ?? "";
      const mentioned = t === "GROUP_AT_MESSAGE_CREATE" || mentionsBot(d);
      return {
        ...base,
        conversationId: `group:${group}`,
        chatType: "group",
        mode: mentioned ? "direct" : "ambient",
        userId: d.author?.member_openid ?? "",
        senderName: d.author?.username || undefined,
        replyContext: { scope: "group", target: group, msgId: d.id },
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
  promptHint: "This is QQ: reply in plain text, no Markdown syntax. Keep replies under 1500 characters.",
  /** Passive replies: 5 per inbound message (bot-docs send.md). */
  maxRepliesPerMessage: 5,

  isConfigured() {
    return Boolean(config.qq.appId && config.qq.appSecret);
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
    for (const content of chunkText(text, MAX_CHUNK)) {
      const seq = nextSeq(ctx);
      switch (scope) {
        case "c2c":
        case "group":
          await qqApi(`${v2Base(scope, target!)}/messages`, { content, msg_type: 0, msg_id: msgId, msg_seq: seq });
          break;
        case "channel":
          await qqApi(`/channels/${target}/messages`, { content, msg_id: msgId });
          break;
        case "dm":
          await qqApi(`/dms/${target}/messages`, { content, msg_id: msgId });
          break;
      }
    }
  },

  async sendImage(message, url) {
    const ctx = message.replyContext;
    const { scope, target, msgId } = ctx;
    switch (scope) {
      case "c2c":
      case "group": {
        const base = v2Base(scope, target!);
        const fileInfo = await uploadImage(base, url);
        await qqApi(`${base}/messages`, { msg_type: 7, media: { file_info: fileInfo }, msg_id: msgId, msg_seq: nextSeq(ctx) });
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
  const ctx = message.replyContext;
  const base = filesTarget(message);
  const res = await qqApi<{ file_info?: string }>(`${base}/files`, {
    file_type: qqFileType(file.name),
    file_name: file.name,
    file_data: file.data.toString("base64"),
    srv_send_msg: false,
  });
  if (!res.file_info) throw new Error(`QQ upload ${base}/files returned no file_info`);
  await qqApi(`${base}/messages`, { msg_type: 7, media: { file_info: res.file_info }, msg_id: ctx.msgId, msg_seq: nextSeq(ctx) });
}

function v2Base(scope: string, target: string): string {
  return scope === "c2c" ? `/v2/users/${target}` : `/v2/groups/${target}`;
}
