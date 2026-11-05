/** How an inbound message is shown to the model (its context line). */
import { config } from "../config.js";
import type { InboundMessage } from "./types.js";

/** How the model knows a person: "#" + the last 6 characters of their platform id, e.g. "#3B6834". */
export const shortId = (userId: string) => `#${userId.slice(-6).toUpperCase() || "?"}`;
/** A person as the model reads them: "老王 #3B6834", or just the short id. */
export const personLabel = (userId: string, name?: string) => (name ? `${name} ${shortId(userId)}` : shortId(userId));
export const senderLabel = (m: InboundMessage) => personLabel(m.userId, m.senderName);

/**
 * The context line of a message, kept in the log; the model sees it as
 *   [第12条｜2026/11/03周二 20:43 Asia/Shanghai｜群聊｜发送人 老王 #3B6834｜@你]
 * (the 第N条 number is the event's seq). The sender is a stable short id (QQ
 * only exposes per-bot openids), plus the nickname when the platform sends one.
 */
export function messageHeader(m: InboundMessage, now = new Date()): string {
  const timeZone = config.agent.timezone;
  const time = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
  const scene = m.chatType === "group" ? "群聊" : "私聊";
  const mention = m.chatType === "group" && m.mode !== "ambient" ? "｜@你" : "";
  return `${time} ${timeZone}｜${scene}｜发送人 ${senderLabel(m)}${mention}`;
}
