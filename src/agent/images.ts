/**
 * Turn chat image attachments into Responses API `input_image` parts.
 *
 * Images are downloaded here and inlined as data URLs rather than passed by
 * URL: the model provider would have to fetch QQ's CDN from abroad, and QQ's
 * attachment links expire. `detail: "low"` keeps each image to a small, fixed
 * token cost, plenty for chat screenshots and memes.
 */

const MAX_IMAGES = 4;
const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

export interface ImagePart {
  type: "input_image";
  image_url: string;
  detail: "low";
}

export async function loadImageParts(images: Array<{ url: string; contentType: string }>): Promise<ImagePart[]> {
  const parts = await Promise.all(
    images.slice(0, MAX_IMAGES).map(async ({ url, contentType }): Promise<ImagePart | undefined> => {
      try {
        if (!url.startsWith("https://")) throw new Error("not https");
        const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const bytes = Buffer.from(await res.arrayBuffer());
        if (bytes.byteLength > MAX_BYTES) throw new Error(`too large (${bytes.byteLength} bytes)`);
        const header = res.headers.get("content-type")?.split(";")[0] ?? "";
        const type = header.startsWith("image/") ? header : contentType;
        return { type: "input_image", image_url: `data:${type};base64,${bytes.toString("base64")}`, detail: "low" };
      } catch (err) {
        console.warn(`[images] could not load ${url.slice(0, 80)}: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      }
    }),
  );
  return parts.filter((p): p is ImagePart => Boolean(p));
}
