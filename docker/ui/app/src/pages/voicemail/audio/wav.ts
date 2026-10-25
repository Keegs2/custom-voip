/**
 * wav.ts — the PURE half of greeting transcoding: no DOM, no Web Audio, no
 * React. Everything the browser-only code (transcode.ts, recorder.ts) needs
 * that can be checked by a plain `node` run lives here and is covered by
 * wav.assert.ts.
 *
 * The API accepts exactly one greeting shape (contract §4.3 + design change
 * 6): RIFF/WAVE, PCM s16le, mono, 8000 or 16000 Hz, ≤ 120 s, ≤ 5 MB. It
 * validates strictly and never transcodes, so the browser must produce that
 * shape byte-for-byte. We always emit 16 kHz (wideband — G.722 callers hear
 * the difference; 8 kHz callers are downsampled by FreeSWITCH anyway).
 *
 * Sizes: 16 kHz × 2 bytes = 32,000 B/s, so 120 s = 3,840,044 B including the
 * 44-byte header — the 5 MB cap can never bind for a valid-length greeting,
 * but it is still checked so a future rate change can't silently exceed it.
 */

/** Rate every greeting is encoded at. */
export const GREETING_SAMPLE_RATE = 16_000;
/** Longest greeting the API accepts. */
export const GREETING_MAX_SECONDS = 120;
/** Shortest greeting worth saving (a stray click is not a greeting). */
export const GREETING_MIN_SECONDS = 1;
/**
 * Upload cap. The contract says "5 MB"; we use the decimal reading (the
 * smaller of 5 MB / 5 MiB) so the browser never sends something the server
 * could count as over.
 */
export const GREETING_MAX_BYTES = 5_000_000;
/** Canonical RIFF/WAVE header length for PCM (no extra chunks). */
export const WAV_HEADER_BYTES = 44;

/* ─── Channel + rate conversion ───────────────────────────── */

/**
 * Averages any number of equal-length channels into one. A single channel is
 * returned as-is (no copy). Unequal lengths use the shortest.
 *
 *   downmixToMono([L, R])[i] === (L[i] + R[i]) / 2
 */
export function downmixToMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0];
  const length = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(length);
  const scale = 1 / channels.length;
  for (const channel of channels) {
    for (let i = 0; i < length; i++) out[i] += channel[i] * scale;
  }
  return out;
}

/** Output length for a resample: round(n × to / from). */
export function resampledLength(inputLength: number, fromRate: number, toRate: number): number {
  return Math.max(0, Math.round((inputLength * toRate) / fromRate));
}

/**
 * Dependency-free resampler — the FALLBACK for engines without a usable
 * OfflineAudioContext (transcode.ts prefers the browser's own resampler).
 * Downsampling box-averages every source sample that falls in each output
 * slot (a crude but real anti-alias filter, fine for speech); upsampling
 * interpolates linearly.
 */
export function resampleFallback(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (!(fromRate > 0) || !(toRate > 0)) throw new RangeError('sample rates must be positive');
  if (fromRate === toRate) return input;
  const outLength = resampledLength(input.length, fromRate, toRate);
  const out = new Float32Array(outLength);
  const ratio = fromRate / toRate;

  if (ratio > 1) {
    for (let i = 0; i < outLength; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let j = start; j < end; j++) sum += input[j];
      out[i] = end > start ? sum / (end - start) : 0;
    }
    return out;
  }

  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(left + 1, input.length - 1);
    const frac = pos - left;
    out[i] = (input[left] ?? 0) * (1 - frac) + (input[right] ?? 0) * frac;
  }
  return out;
}

/** Highest absolute sample value (0..1 for in-range audio). */
export function peakLevel(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > peak) peak = v;
  }
  return peak;
}

/** Joins captured chunks into one buffer, keeping at most `maxSamples`. */
export function concatSamples(chunks: readonly Float32Array[], maxSamples = Number.POSITIVE_INFINITY): Float32Array {
  const total = Math.min(
    maxSamples,
    chunks.reduce((n, c) => n + c.length, 0),
  );
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= total) break;
    const take = Math.min(chunk.length, total - offset);
    out.set(take === chunk.length ? chunk : chunk.subarray(0, take), offset);
    offset += take;
  }
  return out;
}

/* ─── Encoding ────────────────────────────────────────────── */

/** Byte size of a PCM16 mono WAV holding `sampleCount` samples. */
export function wavByteLength(sampleCount: number): number {
  return WAV_HEADER_BYTES + sampleCount * 2;
}

/** Float sample (-1..1, clipped) → signed 16-bit integer. */
export function floatToPcm16(sample: number): number {
  const s = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
  return s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/**
 * Encodes mono float samples as a canonical 44-byte-header RIFF/WAVE file:
 * PCM (format 1), 1 channel, 16 bits, little-endian.
 */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): ArrayBuffer {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new RangeError('sampleRate must be a positive integer');
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = WAV_HEADER_BYTES;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    view.setInt16(offset, floatToPcm16(samples[i]), true);
  }
  return buffer;
}

/* ─── Parsing (validation before upload, and for the self-test) ─── */

export interface WavInfo {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  /** Byte offset of the first sample. */
  dataOffset: number;
  dataBytes: number;
  durationSec: number;
}

export class WavFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WavFormatError';
  }
}

function readAscii(view: DataView, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

/**
 * Walks the RIFF chunks (skipping LIST/fact/etc., honouring the pad byte)
 * and returns the fmt/data facts. Throws WavFormatError for anything that is
 * not a RIFF/WAVE file with both chunks.
 */
export function parseWav(buffer: ArrayBuffer): WavInfo {
  const view = new DataView(buffer);
  if (buffer.byteLength < 12 || readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') {
    throw new WavFormatError('Not a RIFF/WAVE file');
  }
  let offset = 12;
  let fmt: Omit<WavInfo, 'dataOffset' | 'dataBytes' | 'durationSec'> | null = null;
  while (offset + 8 <= buffer.byteLength) {
    const id = readAscii(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > buffer.byteLength) throw new WavFormatError('Truncated fmt chunk');
      fmt = {
        audioFormat: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (!fmt) throw new WavFormatError('data chunk before fmt chunk');
      const dataBytes = Math.min(size, buffer.byteLength - body);
      const bytesPerSecond = fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8);
      return {
        ...fmt,
        dataOffset: body,
        dataBytes,
        durationSec: bytesPerSecond > 0 ? dataBytes / bytesPerSecond : 0,
      };
    }
    offset = body + size + (size % 2);
  }
  throw new WavFormatError(fmt ? 'No data chunk' : 'No fmt chunk');
}

/* ─── Greeting limits ─────────────────────────────────────── */

/** Human-readable reason the clip can't be a greeting, or null when it can. */
export function greetingProblem(
  { durationSec, bytes }: { durationSec: number; bytes: number },
  /** What the clip is called in the message ("greeting"; IVR prompts say "message"). */
  noun = 'greeting',
): string | null {
  if (!(durationSec >= GREETING_MIN_SECONDS)) {
    return `That recording is too short — a ${noun} needs at least a second of audio.`;
  }
  if (durationSec > GREETING_MAX_SECONDS + 0.05) {
    const m = Math.floor(durationSec / 60);
    const s = Math.round(durationSec % 60);
    return `That clip is ${m}:${String(s).padStart(2, '0')} long — ${noun}s can be up to 2:00. Trim it and try again.`;
  }
  if (bytes > GREETING_MAX_BYTES) {
    return `That ${noun} is larger than 5 MB once converted. Try a shorter clip.`;
  }
  return null;
}

/** True when a parsed WAV is exactly the shape the API accepts. */
export function isApiGreetingFormat(info: WavInfo): boolean {
  return (
    info.audioFormat === 1 &&
    info.channels === 1 &&
    info.bitsPerSample === 16 &&
    (info.sampleRate === 8000 || info.sampleRate === 16000)
  );
}
