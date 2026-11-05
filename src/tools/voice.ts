/**
 * send_voice: text → speech (POST {TTS_BASE_URL}/audio/speech, OpenAI-compatible,
 * OpenRouter by default) → a voice message. The voice is cloned from a short
 * reference clip on every request (Fish Audio Drama 3 takes it as
 * `input_references`), so it stays the same voice without an account-side voice.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { REPLY_TO, replyTo } from "./chat.js";
import type { Tool } from "./types.js";

/** Long text makes a long, slow message; chat voice should be short. */
const MAX_TEXT_CHARS = 500;
/** Leave this much of the function's time for the model to reply. */
const REPLY_RESERVE_MS = 15_000;
/**
 * sing: true. Drama 3 has no singing mode; these cues (a direction before the
 * lyrics, a whole-message instruction, a closing ♪) get the closest to it.
 */
const SING_DIRECTION = "[唱歌]";
const SING_INSTRUCTIONS = "这是一段歌唱：按旋律和节奏唱出来，音高起伏明显，长音拖住，不要念白";
const DEFAULT_SING_STYLE = "欢快的儿歌旋律";

/** When the API doesn't say (it normally does: "audio/pcm;rate=44100;channels=1"). */
const DEFAULT_SAMPLE_RATE = 44_100;
const AUDIO_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
};

type ReferencePart = { type: "input_audio"; input_audio: { data?: string; url?: string } } | { type: "text"; text: string };

/** The reference clip as a data URL, read once per instance. */
const clipCache = new Map<string, Promise<string>>();

function clipDataUrl(file: string): Promise<string> {
  let hit = clipCache.get(file);
  if (!hit) {
    hit = readFile(path.resolve(process.cwd(), file)).then(
      (bytes) => `data:${AUDIO_TYPES[path.extname(file).toLowerCase()] ?? "audio/mpeg"};base64,${bytes.toString("base64")}`,
    );
    hit.catch(() => clipCache.delete(file));
    clipCache.set(file, hit);
  }
  return hit;
}

/** `input_references` for the configured voice clip, or undefined when cloning is off. */
async function voiceReferences(): Promise<ReferencePart[] | undefined> {
  const { referenceAudio, referenceText } = config.tts;
  if (!referenceAudio) return undefined;
  let audio: ReferencePart;
  if (/^https?:\/\//i.test(referenceAudio)) {
    audio = { type: "input_audio", input_audio: { url: referenceAudio } };
  } else {
    try {
      audio = { type: "input_audio", input_audio: { data: await clipDataUrl(referenceAudio) } };
    } catch (err) {
      throw new Error(`can't read TTS_REFERENCE_AUDIO ${referenceAudio}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return referenceText ? [audio, { type: "text", text: referenceText }] : [audio];
}

/** "audio/pcm;rate=44100;channels=1" → 44100. */
function sampleRateOf(contentType: string): number {
  const rate = Number(/(?:^|;)\s*rate=(\d+)/i.exec(contentType)?.[1]);
  return Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_SAMPLE_RATE;
}

export const sendVoice: Tool = {
  name: "send_voice",
  role: "talk",
  description:
    "Say something out loud: `text` is turned into speech in your own voice and sent right now as a voice message " +
    "(it counts as a reply like send_message). Use it when a voice fits: they ask to hear you, a greeting, a joke, " +
    "a cheer, a short story. Not for every reply, and not for links, code, lists or long explanations " +
    "(send those as text). Keep it short, one to four sentences. Write it the way it should be spoken: numbers, units " +
    "and symbols as words, no emoji or markdown.\n" +
    "You can direct the delivery inside `text` (the speech model is Fish Audio Drama 3; directions aren't read out):\n" +
    "- [方括号] before the words it applies to: how to say them, in plain words, Chinese or English, like briefing a voice actor: " +
    "[得意地] 本鱼早就算到了！ / [小声嘀咕] 才不是因为想你呢。 / [像发现宝藏一样兴奋] 快看快看！ It lasts until the next direction.\n" +
    "- [方括号] where a sound or a pause happens: 好吧 [叹气] 我输了。 / [轻笑] / [吸一口气] / [短暂停顿].\n" +
    "- Paired tags change only the words inside: <whisper>…</whisper>, <emphasis>…</emphasis>, <soft>…</soft>, <fast>…</fast>, " +
    "<slow>…</slow>, <stress>…</stress>, <forceful>…</forceful>. E.g. 这个秘密<whisper>只告诉你一个人</whisper>。\n" +
    "- A phrase in another language: <english>…</english>, <japanese>…</japanese>, <korean>…</korean> (experimental).\n" +
    "- A tricky reading (多音字, names): one pinyin syllable with its tone number per tag, " +
    "e.g. <|phoneme_start|>chong2<|phoneme_end|><|phoneme_start|>qing4<|phoneme_end|> for 重庆.\n" +
    "Use directions sparingly: a few per message, at most about three per sentence; the voice is already cute and lively without them.\n" +
    "Singing: set `sing: true` and put lyrics in `text`, and the style in `instructions` if you like (\"温柔的摇篮曲\", \"摇滚，很有劲\"). " +
    "It's your voice singing a cappella, with a melody the model makes up, no accompaniment: good for a few lines, not a whole song. " +
    "Write short lines, mark held notes with ～ (小鲸鱼～游呀游～), and leave out directions. " +
    "Sing lyrics you make up or that the person wrote; for a well-known song, write your own playful words instead of its lyrics.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: `What to say (at most ${MAX_TEXT_CHARS} characters), with optional [directions] and tags.` },
      instructions: {
        type: "string",
        description:
          "Optional direction for the whole message, e.g. \"困得迷迷糊糊\" or \"像在讲睡前故事\". Prefer [brackets] in the text for single lines. " +
          "With sing: the singing style, e.g. \"温柔的摇篮曲\".",
      },
      sing: { type: "boolean", description: "Sing `text` as lyrics instead of saying it. Default false." },
      reply_to: REPLY_TO,
    },
    required: ["text"],
  },
  enabled: () => Boolean(config.tts.apiKey),
  async run(args, ctx) {
    const text = String(args.text ?? "").trim();
    if (!text) throw new Error("text is empty");
    if (text.length > MAX_TEXT_CHARS) throw new Error(`text is ${text.length} characters; keep a voice message under ${MAX_TEXT_CHARS}, send the rest as text`);
    const left = ctx.deadline - Date.now() - REPLY_RESERVE_MS;
    if (left < 10_000) throw new Error("not enough time left in this turn to make a voice message; reply in text");

    const { apiKey, baseUrl, model, voice, instructions: standing, extraBody, timeoutMs } = config.tts;
    const sing = args.sing === true;
    const style = String(args.instructions ?? "").trim();
    const instructions = (sing ? [standing, SING_INSTRUCTIONS, style || DEFAULT_SING_STYLE] : [standing, style]).filter(Boolean).join("；");
    const input = sing ? `${SING_DIRECTION} ${text}${text.endsWith("♪") ? "" : " ♪"}` : text;
    const references = await voiceReferences();
    const body = {
      model,
      ...extraBody,
      input,
      response_format: "pcm",
      ...(voice ? { voice } : {}),
      ...(instructions ? { instructions } : {}),
      ...(references ? { input_references: references } : {}),
    };
    const res = await fetch(`${baseUrl}/audio/speech`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.min(timeoutMs, left)),
    });
    if (!res.ok) throw new Error(`speech API HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType && !/pcm|octet-stream/i.test(contentType)) throw new Error(`speech API returned ${contentType}, expected raw PCM`);
    const pcm = Buffer.from(await res.arrayBuffer());
    if (pcm.byteLength < 2) throw new Error("speech API returned no audio");
    const sampleRate = sampleRateOf(contentType);
    const seconds = (pcm.byteLength / 2 / sampleRate).toFixed(1);

    const status = await ctx.send({ kind: "voice", voice: { pcm, sampleRate, text } }, replyTo(args));
    return `${status} (${sing ? "sung" : "voice message"}, ${seconds}s). If you're done, call end_turn (in the same step as your last message).`;
  },
};
