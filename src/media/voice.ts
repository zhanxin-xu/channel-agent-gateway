/**
 * Voice audio for send_voice: the speech API returns mono 16-bit PCM; QQ plays
 * SILK inline (encoded here with silk-wasm, no ffmpeg needed), other channels
 * get a plain WAV file.
 */
import { encode } from "silk-wasm";

/** Sample rates silk-wasm can encode from; anything else is resampled to 24 kHz first. */
const SILK_RATES = [8000, 12000, 16000, 24000, 32000, 44100, 48000];

/** A 44-byte RIFF header in front of the PCM samples. */
export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // bytes per second
  header.writeUInt16LE(2, 32); // bytes per frame
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, pcm]);
}

/** Linear resampling of mono 16-bit PCM (only for rates SILK can't take). */
function resample(pcm: Buffer, from: number, to: number): Buffer {
  // Copied: a Buffer's byteOffset may be odd, and Int16Array needs it aligned.
  const input = new Int16Array(new Uint8Array(pcm).buffer, 0, Math.floor(pcm.byteLength / 2));
  const out = new Int16Array(Math.floor((input.length * to) / from));
  for (let i = 0; i < out.length; i++) {
    const pos = (i * from) / to;
    const j = Math.floor(pos);
    const a = input[j] ?? 0;
    const b = input[j + 1] ?? a;
    out[i] = Math.round(a + (b - a) * (pos - j));
  }
  return Buffer.from(out.buffer);
}

/** Encode mono 16-bit PCM as SILK (QQ / WeChat voice). Returns the bytes and the duration in ms. */
export async function pcmToSilk(pcm: Buffer, sampleRate: number): Promise<{ data: Buffer; durationMs: number }> {
  let rate = sampleRate;
  let samples = pcm.byteLength % 2 ? pcm.subarray(0, pcm.byteLength - 1) : pcm;
  if (!SILK_RATES.includes(rate)) {
    samples = resample(samples, rate, 24000);
    rate = 24000;
  }
  const { data, duration } = await encode(samples, rate);
  return { data: Buffer.from(data), durationMs: duration };
}
