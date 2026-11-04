/**
 * Images in the event log. Each image is shrunk to what the model looks at
 * (longest side 512px for chat images, `detail: "low"`; 1024px for files the
 * agent opens) and stored once under its own key as a data URL (table
 * gateway.images); events hold only the keys. Every request then replays the exact same image, so the
 * prompt cache stays valid, and the bot can still look at earlier pictures.
 *
 * Images are downloaded here rather than passed to the model by URL: the
 * provider would have to fetch QQ's CDN from abroad, and attachment links expire.
 */
import sharp from "sharp";
import type { ChatStore } from "../store/index.js";

const MAX_IMAGES = 4;
const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;
/** Stored as-is when sharp can't decode it (kept small enough for one stored value). */
const MAX_RAW_BYTES = 1024 * 1024;
/** Per attempt. QQ's CDN is sometimes slow from abroad; this runs after the webhook is acknowledged. */
const TIMEOUT_MS = 15_000;
const ATTEMPTS = 2;

/** Download an image, trying again once after a timeout, a network error or a 5xx (not after a 4xx: the link is gone). */
async function fetchImage(url: string): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) return res;
      if (res.status < 500 || attempt >= ATTEMPTS) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if ((err instanceof Error && /^HTTP 4/.test(err.message)) || attempt >= ATTEMPTS) throw err;
    }
    console.warn(`[images] retrying ${url.slice(0, 80)} (attempt ${attempt} failed)`);
  }
}

export interface ImagePart {
  type: "input_image";
  image_url: string;
  /** "low" for chat images (small fixed cost); files the agent opens on purpose use "auto". */
  detail: "low" | "auto";
}

/** Shrink to a JPEG data URL (first frame of an animation); falls back to the original bytes. */
export async function toDataUrl(bytes: Buffer, contentType: string, maxSide: number): Promise<string> {
  try {
    const jpeg = await sharp(bytes)
      .rotate()
      .resize(maxSide, maxSide, { fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 80 })
      .toBuffer();
    return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  } catch (err) {
    if (bytes.byteLength > MAX_RAW_BYTES) throw err;
    return `data:${contentType || "image/png"};base64,${bytes.toString("base64")}`;
  }
}

/** Key prefix of a chat's images: `ev:img:{chat}:{message event id or t{turn}s{step}}`, then `:{i}`. */
export const imagePrefix = (chat: string, id: string) => `ev:img:${chat}:${id}`;

/**
 * Download a message's images and store them under `{prefix}:{i}`. Returns the
 * keys of the ones stored and how many failed.
 */
export async function storeChatImages(
  store: ChatStore,
  chat: string,
  prefix: string,
  images: Array<{ url: string; contentType: string }>,
): Promise<{ keys: string[]; failed: number }> {
  const results = await Promise.all(
    images.slice(0, MAX_IMAGES).map(async ({ url, contentType }, i) => {
      try {
        if (!url.startsWith("https://")) throw new Error("not https");
        const res = await fetchImage(url);
        const bytes = Buffer.from(await res.arrayBuffer());
        if (bytes.byteLength > MAX_DOWNLOAD_BYTES) throw new Error(`too large (${bytes.byteLength} bytes)`);
        const header = res.headers.get("content-type")?.split(";")[0] ?? "";
        const key = `${prefix}:${i}`;
        await store.putImage(chat, key, await toDataUrl(bytes, header.startsWith("image/") ? header : contentType, 512));
        return key;
      } catch (err) {
        console.warn(`[images] could not load ${url.slice(0, 80)}: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      }
    }),
  );
  const keys = results.filter((k): k is string => Boolean(k));
  return { keys, failed: Math.min(images.length, MAX_IMAGES) - keys.length };
}

/** Store images a tool produced (data URLs) under `{prefix}:{i}`, shrunk to 1024px. */
export async function storeToolImages(store: ChatStore, chat: string, prefix: string, parts: ImagePart[]): Promise<string[]> {
  return Promise.all(
    parts.map(async (part, i) => {
      const [, type = "image/png", data = ""] = /^data:([^;]+);base64,(.*)$/s.exec(part.image_url) ?? [];
      const key = `${prefix}:${i}`;
      await store.putImage(chat, key, await toDataUrl(Buffer.from(data, "base64"), type, 1024));
      return key;
    }),
  );
}
