/**
 * transcode.ts — the browser half of greeting transcoding (Web Audio). Turns
 * a recording or any audio file the browser can decode into the one WAV the
 * API accepts: PCM16, mono, 16 kHz, ≤ 120 s, ≤ 5 MB (see wav.ts).
 *
 *   record → PcmClip (device rate, mono) ─┐
 *                                          ├→ resample (OfflineAudioContext) → encode → limits → GreetingAudio
 *   file  → decodeAudioData → downmix ────┘
 *
 * Resampling uses the browser's own resampler by rendering through an
 * OfflineAudioContext at 16 kHz; engines without one fall back to the pure
 * resampler in wav.ts. Nothing here touches the network or storage — the
 * audio stays in memory until the user saves it.
 */
import {
  GREETING_MAX_SECONDS,
  GREETING_SAMPLE_RATE,
  downmixToMono,
  encodeWavPcm16,
  greetingProblem,
  resampleFallback,
  resampledLength,
} from './wav';

/** Mono float samples at a known rate. */
export interface PcmClip {
  samples: Float32Array;
  sampleRate: number;
}

/** A greeting ready to preview and upload. */
export interface GreetingAudio {
  wav: Blob;
  durationSec: number;
  bytes: number;
  sampleRate: number;
}

/** A problem the user can act on (shown verbatim). */
export class GreetingAudioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GreetingAudioError';
  }
}

/** Largest source file we try to decode (decoding is done fully in memory). */
export const MAX_SOURCE_FILE_BYTES = 50 * 1024 * 1024;

type OfflineCtor = new (channels: number, length: number, sampleRate: number) => OfflineAudioContext;

function offlineAudioContextCtor(): OfflineCtor | null {
  const w = window as Window & { webkitOfflineAudioContext?: OfflineCtor };
  return (typeof OfflineAudioContext !== 'undefined' ? OfflineAudioContext : w.webkitOfflineAudioContext) ?? null;
}

/** Resamples a mono clip to `toRate` with the browser's resampler (fallback: wav.ts). */
export async function resampleClip(clip: PcmClip, toRate: number): Promise<Float32Array> {
  if (clip.sampleRate === toRate || clip.samples.length === 0) return clip.samples;
  const Ctor = offlineAudioContextCtor();
  if (Ctor) {
    try {
      const length = Math.max(1, resampledLength(clip.samples.length, clip.sampleRate, toRate));
      const ctx = new Ctor(1, length, toRate);
      const source = ctx.createBuffer(1, clip.samples.length, clip.sampleRate);
      source.copyToChannel(new Float32Array(clip.samples), 0);
      const node = ctx.createBufferSource();
      node.buffer = source;
      node.connect(ctx.destination);
      node.start(0);
      const rendered = await ctx.startRendering();
      return rendered.getChannelData(0).slice(0, length);
    } catch {
      // Unsupported source rate on this engine, or rendering refused —
      // the pure resampler below always works.
    }
  }
  return resampleFallback(clip.samples, clip.sampleRate, toRate);
}

/** Encodes a mono clip as the API's greeting WAV, enforcing the limits. */
export async function buildGreetingWav(clip: PcmClip): Promise<GreetingAudio> {
  const samples = await resampleClip(clip, GREETING_SAMPLE_RATE);
  const durationSec = samples.length / GREETING_SAMPLE_RATE;
  const buffer = encodeWavPcm16(samples, GREETING_SAMPLE_RATE);
  const problem = greetingProblem({ durationSec, bytes: buffer.byteLength });
  if (problem) throw new GreetingAudioError(problem);
  return {
    wav: new Blob([buffer], { type: 'audio/wav' }),
    durationSec,
    bytes: buffer.byteLength,
    sampleRate: GREETING_SAMPLE_RATE,
  };
}

/**
 * Decodes any audio file the browser understands (WAV, MP3, M4A/AAC, OGG,
 * FLAC, WebM…) into a mono clip. Decoding through a 16 kHz context makes
 * conforming engines resample during decode; buildGreetingWav resamples
 * again only if the engine returned another rate.
 */
export async function decodeAudioFile(file: Blob): Promise<PcmClip> {
  if (file.size === 0) throw new GreetingAudioError('That file is empty.');
  if (file.size > MAX_SOURCE_FILE_BYTES) {
    throw new GreetingAudioError('That file is over 50 MB. Pick a shorter clip (greetings can be up to 2:00).');
  }
  const Ctor = offlineAudioContextCtor();
  if (!Ctor) throw new GreetingAudioError('This browser can’t convert audio. Try a current version of Chrome, Edge, Firefox or Safari.');

  const bytes = await file.arrayBuffer();
  const ctx = new Ctor(1, 1, GREETING_SAMPLE_RATE);
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(bytes);
  } catch {
    throw new GreetingAudioError('That file couldn’t be read as audio. Try a WAV, MP3 or M4A file.');
  }
  // Reject absurd lengths before doing any more work.
  if (decoded.duration > GREETING_MAX_SECONDS + 0.05) {
    const problem = greetingProblem({ durationSec: decoded.duration, bytes: 0 });
    throw new GreetingAudioError(problem ?? 'That clip is too long.');
  }
  const channels: Float32Array[] = [];
  for (let c = 0; c < decoded.numberOfChannels; c++) channels.push(decoded.getChannelData(c));
  return { samples: downmixToMono(channels), sampleRate: decoded.sampleRate };
}
