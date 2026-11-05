/**
 * send_voice: text → speech (POST {TTS_BASE_URL}/audio/speech, OpenAI-compatible,
 * OpenRouter by default) → a voice message. The voice is cloned from a short
 * reference clip on every request (`input_references`), so it stays the same
 * voice without an account-side voice.
 *
 * The speech model is set by TTS_MODEL; the agent picks the reference voice,
 * speaking or singing, and the speed. The description teaches that model's
 * syntax and its singing recipe.
 */
import { config } from "../config.js";
import { bundledDataUrl } from "../media/assets.js";
import { REPLY_TO, replyTo } from "./chat.js";
import type { Tool } from "./types.js";

/** Long text makes a long, slow message; chat voice should be short. */
const MAX_TEXT_CHARS = 500;
/** When the API doesn't say (it normally does: "audio/pcm;rate=44100;channels=1"). */
const DEFAULT_SAMPLE_RATE = 44_100;
const MIN_SPEED = 0.5;
const MAX_SPEED = 2;

/** What each model family understands, and how it is asked to sing. */
interface ModelKind {
  /** For the description: who it is and what it's good at. */
  about: string;
  /** For the description: how to write `text` and `instructions` for it. */
  syntax: string;
  /** Singing: what goes around the lyrics and into `instructions`. */
  sing: { input(text: string): string; instructions: string; defaultStyle: string };
  /** Whether it honors `speed`. */
  speed: boolean;
}

const FISH: ModelKind = {
  about: "Fish Audio Drama 3. Singing comes out closer to a lilting recitation than a real melody.",
  syntax:
    "Directions inside `text` (not read out):\n" +
    "  - [方括号] before the words it applies to: how to say them, in plain words, Chinese or English, like briefing a voice actor: " +
    "[得意地] 本鱼早就算到了！ / [小声嘀咕] 才不是因为想你呢。 / [像发现宝藏一样兴奋] 快看快看！ It lasts until the next direction.\n" +
    "  - [方括号] where a sound or a pause happens: 好吧 [叹气] 我输了。 / [轻笑] / [吸一口气] / [短暂停顿].\n" +
    "  - Paired tags change only the words inside: <whisper>…</whisper>, <emphasis>…</emphasis>, <soft>…</soft>, <fast>…</fast>, " +
    "<slow>…</slow>, <stress>…</stress>, <forceful>…</forceful>. E.g. 这个秘密<whisper>只告诉你一个人</whisper>。\n" +
    "  - A phrase in another language: <english>…</english>, <japanese>…</japanese>, <korean>…</korean> (experimental).\n" +
    "  - A tricky reading (多音字, names): one pinyin syllable with its tone number per tag, " +
    "e.g. <|phoneme_start|>chong2<|phoneme_end|><|phoneme_start|>qing4<|phoneme_end|> for 重庆.\n" +
    "  - A few directions per message, at most about three per sentence; the voice is already lively without them.\n" +
    "  `instructions` sets the mood of the whole message. `speed` works.",
  sing: {
    input: (text) => `[唱歌] ${text}${text.endsWith("♪") ? "" : " ♪"}`,
    instructions: "这是一段歌唱：按旋律和节奏唱出来，音高起伏明显，长音拖住，不要念白",
    defaultStyle: "欢快的儿歌旋律",
  },
  speed: true,
};

const SEED: ModelKind = {
  about: "ByteDance Seed Audio 1.0: freer, more varied delivery; the clone is a little looser.",
  syntax:
    "Write `text` as plain words to be spoken or sung, no [brackets] or <tags> (they may be read out). " +
    "Put all direction in `instructions`, as a description of the performance: " +
    "\"用撒娇的语气，越说越委屈\", \"像深夜电台主持人一样慢慢讲\". `speed` is ignored.",
  sing: {
    input: (text) => text,
    instructions: "用参考音频里的声音唱歌：按旋律和节奏唱，有明确的音高起伏，长音拖住，是唱歌不是说话",
    defaultStyle: "欢快可爱的儿歌",
  },
  speed: false,
};

/** Any other model: no inline syntax assumed. */
const GENERIC: ModelKind = {
  about: "An OpenAI-compatible speech model.",
  syntax: "Write `text` as plain words; put direction in `instructions`.",
  sing: { input: (text) => text, instructions: "唱出来，有旋律和节奏，不要念白", defaultStyle: "欢快的旋律" },
  speed: true,
};

function kindOf(model: string): ModelKind {
  if (model.startsWith("fish-audio/")) return FISH;
  if (model.startsWith("bytedance-seed/")) return SEED;
  return GENERIC;
}

/** The voices the model can pick: the clone, its singing clip when configured, or none. */
function voiceChoices(): string[] {
  const { referenceAudio, singReferenceAudio } = config.tts;
  return [...(referenceAudio ? ["dafeiyu"] : []), ...(singReferenceAudio ? ["dafeiyu_sing"] : []), "none"];
}

type ReferencePart = { type: "input_audio"; input_audio: { data?: string; url?: string } } | { type: "text"; text: string };

/** `input_references` for a clip (and what it says), or undefined for no clip. */
async function references(clip: string, transcript: string, setting: string): Promise<ReferencePart[] | undefined> {
  if (!clip) return undefined;
  let audio: ReferencePart;
  if (/^https?:\/\//i.test(clip)) {
    audio = { type: "input_audio", input_audio: { url: clip } };
  } else {
    try {
      audio = { type: "input_audio", input_audio: { data: await bundledDataUrl(clip) } };
    } catch (err) {
      throw new Error(`can't read ${setting} ${clip}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return transcript ? [audio, { type: "text", text: transcript }] : [audio];
}

/** "audio/pcm;rate=44100;channels=1" → 44100 (and 1). */
function pcmFormat(contentType: string): { sampleRate: number; channels: number } {
  const field = (name: string) => Number(new RegExp(`(?:^|;)\\s*${name}=(\\d+)`, "i").exec(contentType)?.[1]);
  const rate = field("rate");
  const channels = field("channels");
  return {
    sampleRate: Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_SAMPLE_RATE,
    channels: Number.isInteger(channels) && channels > 1 ? channels : 1,
  };
}

/** Interleaved 16-bit PCM → mono (Seed sends stereo; voice messages are mono). */
function toMono(pcm: Buffer, channels: number): Buffer {
  if (channels === 1) return pcm;
  const frames = Math.floor(pcm.byteLength / 2 / channels);
  const out = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += pcm.readInt16LE((i * channels + c) * 2);
    out.writeInt16LE(Math.round(sum / channels), i * 2);
  }
  return out;
}

function description(): string {
  const kind = kindOf(config.tts.model);
  const voices = voiceChoices();
  const voiceLines = [
    voices.includes("dafeiyu") ? '"dafeiyu" (default): your own voice, cloned from a short clip of you talking.' : "",
    voices.includes("dafeiyu_sing") ? '"dafeiyu_sing": the same voice cloned from a clip of you singing; try it when singing.' : "",
    '"none": no clone; describe the voice in `instructions` ("低沉沙哑的大叔", "奶声奶气的小男孩") to play another character, ' +
      "then go back to your own voice.",
  ].filter(Boolean);
  return (
    "Say or sing something out loud: `text` becomes audio and is sent right now as a voice message " +
    "(it counts as a reply like send_message). Use it when a voice fits: they ask to hear you, a greeting, a joke, " +
    "a cheer, a short story, a few lines of a song. Not for every reply, and not for links, code, lists or long explanations " +
    "(send those as text). Keep it short. Write it the way it should sound: numbers, units and symbols as words, no emoji or markdown.\n\n" +
    `The speech model is ${kind.about}\n${kind.syntax}\n\n` +
    "Voices (`voice`):\n" +
    voiceLines.map((l) => `- ${l}`).join("\n") +
    "\n\nSinging: `mode: \"sing\"`, lyrics in `text`, the style in `instructions` (\"温柔的摇篮曲\", \"摇滚，很有劲\"). " +
    "The tool adds each model's singing cues for you. It's a cappella with a melody the model makes up: a few lines, not a whole song. " +
    "Short lines, held notes marked with ～ (小鲸鱼～游呀游～). A public-domain tune can anchor the melody (\"用《小星星》的旋律\"). " +
    "Sing words you make up or that they wrote; for a well-known song, write your own playful words instead of its lyrics.\n\n" +
    "When it doesn't land (they say it sounds off, or like reading), try another voice or wording instead of resending the same thing; " +
    "if a combination works well for someone, remember it."
  );
}

export const sendVoice: Tool = {
  name: "send_voice",
  role: "talk",
  get description() {
    return description();
  },
  get parameters() {
    return {
      type: "object",
      properties: {
        text: { type: "string", description: `What to say or sing (at most ${MAX_TEXT_CHARS} characters), in the chosen model's syntax.` },
        instructions: {
          type: "string",
          description: "Optional: the delivery of the whole message (\"困得迷迷糊糊\"), the singing style, or with voice \"none\" the character's voice.",
        },
        mode: { type: "string", enum: ["speak", "sing"], description: "speak (default) or sing `text` as lyrics." },
        voice: { type: "string", enum: voiceChoices(), description: `Whose voice. Default ${voiceChoices()[0]}.` },
        speed: { type: "number", minimum: MIN_SPEED, maximum: MAX_SPEED, description: "Optional speaking rate, 1 = normal (not every model honors it)." },
        reply_to: REPLY_TO,
      },
      required: ["text"],
    };
  },
  enabled: () => Boolean(config.tts.apiKey),
  async run(args, ctx) {
    const text = String(args.text ?? "").trim();
    if (!text) throw new Error("text is empty");
    if (text.length > MAX_TEXT_CHARS) throw new Error(`text is ${text.length} characters; keep a voice message under ${MAX_TEXT_CHARS}, send the rest as text`);

    const { apiKey, baseUrl, model, voice: providerVoice, instructions: standing, extraBody, timeoutMs } = config.tts;
    const voices = voiceChoices();
    const voice = args.voice === undefined || args.voice === null || args.voice === "" ? voices[0]! : String(args.voice);
    if (!voices.includes(voice)) throw new Error(`voice is one of ${voices.join(", ")}`);
    const mode = args.mode === undefined || args.mode === null || args.mode === "" ? "speak" : String(args.mode);
    if (mode !== "speak" && mode !== "sing") throw new Error('mode is "speak" or "sing"');
    let speed: number | undefined;
    if (args.speed !== undefined && args.speed !== null) {
      speed = Number(args.speed);
      if (!(speed >= MIN_SPEED && speed <= MAX_SPEED)) throw new Error(`speed is ${MIN_SPEED} to ${MAX_SPEED}`);
    }
    const left = ctx.callBudgetMs();
    if (left < 10_000) throw new Error("not enough time left in this function to make a voice message; the turn continues in a fresh function, try again there");

    const kind = kindOf(model);
    const sing = mode === "sing";
    const style = String(args.instructions ?? "").trim();
    // With no clone the standing direction (it describes your voice) would fight the character's.
    const standingPart = voice === "none" ? "" : standing;
    const instructions = (sing ? [standingPart, kind.sing.instructions, style || kind.sing.defaultStyle] : [standingPart, style])
      .filter(Boolean)
      .join("；");
    const refs =
      voice === "dafeiyu"
        ? await references(config.tts.referenceAudio, config.tts.referenceText, "TTS_REFERENCE_AUDIO")
        : voice === "dafeiyu_sing"
          ? await references(config.tts.singReferenceAudio, config.tts.singReferenceText, "TTS_SING_REFERENCE_AUDIO")
          : undefined;
    const body = {
      model,
      ...extraBody,
      input: sing ? kind.sing.input(text) : text,
      response_format: "pcm",
      ...(voice === "none" && providerVoice ? { voice: providerVoice } : {}),
      ...(instructions ? { instructions } : {}),
      ...(speed !== undefined && kind.speed ? { speed } : {}),
      ...(refs ? { input_references: refs } : {}),
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
    const { sampleRate, channels } = pcmFormat(contentType);
    const pcm = toMono(Buffer.from(await res.arrayBuffer()), channels);
    if (pcm.byteLength < 2) throw new Error("speech API returned no audio");
    const seconds = (pcm.byteLength / 2 / sampleRate).toFixed(1);

    const status = await ctx.send({ kind: "voice", voice: { pcm, sampleRate, text } }, replyTo(args));
    const how = [sing ? "sung" : "spoken", `model=${model}`, `voice=${voice}`, ...(speed !== undefined ? [`speed=${speed}`] : []), `${seconds}s`];
    return `${status} (voice message: ${how.join(", ")}). If you're done, call end_turn (in the same step as your last message).`;
  },
};
