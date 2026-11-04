/**
 * generate_image: OpenRouter's Image API (POST {IMAGE_BASE_URL}/images).
 * Results are saved to the workspace (so send_file can deliver them) and shown
 * to the model. Reference images are workspace paths, turned into data URLs here.
 */
import path from "node:path";
import sharp from "sharp";
import { config } from "../config.js";
import type { ImagePart } from "../media/images.js";
import { WORKDIR, workspaceFor } from "./sandbox/workspace.js";
import type { Tool, ToolContext } from "./types.js";

/** Where generated images go. */
const OUTDIR = `${WORKDIR}/images`;
/** Results larger than 1080p (either orientation) are scaled down to fit. */
const MAX_LONG = 1920;
const MAX_SHORT = 1080;
/** Leave this much of the function's time for the model to reply. */
const REPLY_RESERVE_MS = 15_000;
/** What the model is shown of a result (it is saved at full size). */
const PREVIEW_SIDE = 1024;

const ASPECT_RATIOS = ["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"];
const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
const EXTENSIONS: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };

interface ImagesResponse {
  data?: Array<{ b64_json?: string; media_type?: string }>;
  usage?: { cost?: number };
}

/** A reference for `input_references`: an http(s) URL as-is, or a workspace file as a data URL. */
async function reference(ctx: ToolContext, ref: string): Promise<{ type: "image_url"; image_url: { url: string } }> {
  if (/^https?:\/\//i.test(ref)) return { type: "image_url", image_url: { url: ref } };
  const file = path.posix.resolve(WORKDIR, ref);
  const bytes = await (await workspaceFor(ctx)).read(file);
  if (!bytes) throw new Error(`reference ${file} not found`);
  let type = MEDIA_TYPES[path.posix.extname(file).toLowerCase()];
  if (!type) {
    const format = (await sharp(bytes).metadata().catch(() => undefined))?.format;
    if (!format) throw new Error(`reference ${file} isn't an image`);
    type = `image/${format}`;
  }
  return { type: "image_url", image_url: { url: `data:${type};base64,${bytes.toString("base64")}` } };
}

/** Scale down to fit 1080p when larger; returns the bytes to save and the final size. */
async function capTo1080p(bytes: Buffer): Promise<{ bytes: Buffer; width?: number; height?: number }> {
  const { width, height } = await sharp(bytes).metadata();
  if (!width || !height) return { bytes };
  const landscape = width >= height;
  const scale = Math.min(1, MAX_LONG / (landscape ? width : height), MAX_SHORT / (landscape ? height : width));
  if (scale >= 1) return { bytes, width, height };
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  return { bytes: await sharp(bytes).resize(w, h).toBuffer(), width: w, height: h };
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

export const generateImage: Tool = {
  name: "generate_image",
  description:
    "Generate or edit images with an image model. With input_references (images in your workspace, e.g. a photo saved with " +
    "save_attachment) it edits / restyles them; without, it draws from the prompt alone. Results are saved under " +
    `${OUTDIR}/ and shown to you; check them, then send with send_file. Each call costs money: make one good prompt ` +
    "(describe subject, style, lighting, composition; say what to keep when editing) rather than many tries.",
  parameters: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "What to draw, or how to change the reference images." },
      input_references: {
        type: "array",
        items: { type: "string" },
        maxItems: 16,
        description: `Reference images: workspace paths (relative paths are under ${WORKDIR}, e.g. "inbox/632-photo.jpg") or https URLs.`,
      },
      aspect_ratio: { type: "string", enum: ASPECT_RATIOS, description: "Default: auto (follows the reference, or square)." },
      background: { type: "string", enum: ["auto", "transparent", "opaque"] },
      n: { type: "integer", minimum: 1, maximum: 10, description: "How many images. Default 1." },
    },
    required: ["prompt"],
  },
  enabled: () => Boolean(config.image.apiKey) && config.sandbox.enabled,
  async run(args, ctx) {
    const prompt = String(args.prompt ?? "").trim();
    if (!prompt) throw new Error("prompt is empty");
    const refs = Array.isArray(args.input_references) ? args.input_references.map(String) : [];
    if (refs.length > 16) throw new Error("at most 16 input_references");
    const n = args.n === undefined || args.n === null ? undefined : Number(args.n);
    if (n !== undefined && !(Number.isInteger(n) && n >= 1 && n <= 10)) throw new Error("n is 1 to 10");
    if (args.aspect_ratio !== undefined && !ASPECT_RATIOS.includes(String(args.aspect_ratio))) {
      throw new Error(`aspect_ratio is one of ${ASPECT_RATIOS.join(", ")}`);
    }

    const left = ctx.deadline - Date.now() - REPLY_RESERVE_MS;
    if (left < 20_000) throw new Error("not enough time left in this turn to generate an image; reply first");

    const { apiKey, baseUrl, model, quality, resolution, extraBody, timeoutMs } = config.image;
    const body = {
      model,
      quality,
      resolution,
      ...extraBody,
      prompt,
      ...(refs.length ? { input_references: await Promise.all(refs.map((r) => reference(ctx, r))) } : {}),
      ...(args.aspect_ratio !== undefined ? { aspect_ratio: String(args.aspect_ratio) } : {}),
      ...(args.background !== undefined ? { background: String(args.background) } : {}),
      ...(n !== undefined ? { n } : {}),
    };
    const res = await fetch(`${baseUrl}/images`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.min(timeoutMs, left)),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`image API HTTP ${res.status}: ${text.slice(0, 500)}`);
    const result = JSON.parse(text) as ImagesResponse;
    const images = (result.data ?? []).filter((d) => d.b64_json);
    if (!images.length) throw new Error(`the image API returned no image: ${text.slice(0, 300)}`);

    const ws = await workspaceFor(ctx);
    const base = stamp();
    const lines: string[] = [];
    for (const [i, image] of images.entries()) {
      const { bytes, width, height } = await capTo1080p(Buffer.from(image.b64_json!, "base64"));
      const type = image.media_type ?? "image/png";
      const file = `${OUTDIR}/${base}-${i + 1}${EXTENSIONS[type] ?? ".png"}`;
      await ws.write(file, bytes);
      const preview = await sharp(bytes).resize(PREVIEW_SIDE, PREVIEW_SIDE, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
      const part: ImagePart = { type: "input_image", image_url: `data:image/jpeg;base64,${preview.toString("base64")}`, detail: "auto" };
      ctx.images.push(part);
      lines.push(`${file} (${width && height ? `${width}x${height}, ` : ""}${bytes.byteLength} bytes)`);
    }
    const cost = typeof result.usage?.cost === "number" ? `, cost $${result.usage.cost}` : "";
    return (
      `generated ${images.length} image(s)${cost}; saved and shown to you right after this:\n${lines.join("\n")}\n` +
      "If one looks right, send it with send_file."
    );
  },
};
