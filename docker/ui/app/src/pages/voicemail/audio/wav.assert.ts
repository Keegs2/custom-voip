import {
  GREETING_MAX_BYTES,
  GREETING_MAX_SECONDS,
  GREETING_SAMPLE_RATE,
  WAV_HEADER_BYTES,
  WavFormatError,
  concatSamples,
  downmixToMono,
  encodeWavPcm16,
  floatToPcm16,
  greetingProblem,
  isApiGreetingFormat,
  parseWav,
  peakLevel,
  resampleFallback,
  resampledLength,
  wavByteLength,
} from './wav.ts';

// ═════════════════════════════════════════════════════════════════════════════
// wav.assert.ts — self-test for the pure greeting transcoder (wav.ts).
//
// Same pattern as pages/calls/quality.assert.ts: there is no JS test runner,
// so executing this module IS the test suite — it throws on the first
// failure. It imports only wav.ts (with the .ts extension, which tsconfig's
// allowImportingTsExtensions permits), so Node's built-in type stripping runs
// it directly, no bundler:
//
//   node src/pages/voicemail/audio/wav.assert.ts
//
// Never imported by the app, so it never ships.
// ═════════════════════════════════════════════════════════════════════════════

let passed = 0;

function check(what: string, expected: unknown, actual: unknown): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(
      `[wav self-test] ${what}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    );
  }
  passed += 1;
}

function near(what: string, expected: number, actual: number, tolerance: number): void {
  if (!(Math.abs(expected - actual) <= tolerance)) {
    throw new Error(`[wav self-test] ${what}\n  expected ≈ ${expected} ± ${tolerance}\n  actual:   ${actual}`);
  }
  passed += 1;
}

function throws(what: string, fn: () => unknown, type: new (...args: never[]) => Error): void {
  try {
    fn();
  } catch (err) {
    if (err instanceof type) {
      passed += 1;
      return;
    }
    throw new Error(`[wav self-test] ${what}: threw the wrong error: ${String(err)}`);
  }
  throw new Error(`[wav self-test] ${what}: did not throw`);
}

function sine(freq: number, rate: number, seconds: number, amp = 0.5): Float32Array {
  const n = Math.round(rate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (const v of samples) sum += v * v;
  return Math.sqrt(sum / Math.max(1, samples.length));
}

/* ─── PCM conversion ─── */
check('pcm16 0', 0, floatToPcm16(0));
check('pcm16 +1', 32767, floatToPcm16(1));
check('pcm16 -1', -32768, floatToPcm16(-1));
check('pcm16 clips above 1', 32767, floatToPcm16(1.7));
check('pcm16 clips below -1', -32768, floatToPcm16(-3));
check('pcm16 NaN → 0', 0, floatToPcm16(Number.NaN));
check('pcm16 0.5', 16384, floatToPcm16(0.5));

/* ─── Downmix ─── */
check('downmix none', 0, downmixToMono([]).length);
const mono = new Float32Array([0.25, -0.5]);
check('downmix mono passthrough (same object)', true, downmixToMono([mono]) === mono);
check(
  'downmix stereo averages',
  [0.5, 0, -0.25],
  Array.from(downmixToMono([new Float32Array([1, 0.5, -0.5]), new Float32Array([0, -0.5, 0])])),
);
check(
  'downmix unequal lengths uses shortest',
  2,
  downmixToMono([new Float32Array([1, 1, 1]), new Float32Array([1, 1])]).length,
);

/* ─── Resample ─── */
check('resampledLength 48k→16k', 16000, resampledLength(48000, 48000, 16000));
check('resampledLength 44.1k→16k (1 s)', 16000, resampledLength(44100, 44100, 16000));
check('resampledLength 8k→16k', 32000, resampledLength(16000, 8000, 16000));
const tone48 = sine(440, 48000, 1);
const tone16 = resampleFallback(tone48, 48000, 16000);
check('fallback 48k→16k length', 16000, tone16.length);
near('fallback 48k→16k keeps a 440 Hz tone\'s energy', rms(tone48), rms(tone16), 0.01);
check('fallback same rate returns input', true, resampleFallback(tone48, 48000, 48000) === tone48);
const up = resampleFallback(new Float32Array([0, 1]), 8000, 16000);
check('fallback upsample interpolates', [0, 0.5, 1, 1], Array.from(up));
throws('fallback rejects rate 0', () => resampleFallback(tone48, 0, 16000), RangeError);

/* ─── concat / peak ─── */
check(
  'concat joins in order',
  [1, 2, 3, 4, 5],
  Array.from(concatSamples([new Float32Array([1, 2]), new Float32Array([3, 4, 5])])),
);
check(
  'concat truncates to maxSamples',
  [1, 2, 3],
  Array.from(concatSamples([new Float32Array([1, 2]), new Float32Array([3, 4, 5])], 3)),
);
near('peak', 0.75, peakLevel(new Float32Array([0.1, -0.75, 0.5])), 1e-6);

/* ─── Encode → parse round trip ─── */
const clip = sine(300, GREETING_SAMPLE_RATE, 2.5, 0.8);
const wav = encodeWavPcm16(clip, GREETING_SAMPLE_RATE);
check('wav byte length', wavByteLength(clip.length), wav.byteLength);
check('wav header size', 44, WAV_HEADER_BYTES);
const info = parseWav(wav);
check('parsed format', { audioFormat: 1, channels: 1, sampleRate: 16000, bitsPerSample: 16, dataOffset: 44 }, {
  audioFormat: info.audioFormat,
  channels: info.channels,
  sampleRate: info.sampleRate,
  bitsPerSample: info.bitsPerSample,
  dataOffset: info.dataOffset,
});
near('parsed duration', 2.5, info.durationSec, 1e-9);
check('api greeting format', true, isApiGreetingFormat(info));
const view = new DataView(wav);
check('RIFF size field', wav.byteLength - 8, view.getUint32(4, true));
check('first sample is 0', 0, view.getInt16(44, true));
near('sample 10 round-trips', clip[10], view.getInt16(44 + 20, true) / 32767, 1 / 16384);
check('8 kHz is an accepted rate', true, isApiGreetingFormat(parseWav(encodeWavPcm16(new Float32Array(8000), 8000))));
check('22.05 kHz is not', false, isApiGreetingFormat(parseWav(encodeWavPcm16(new Float32Array(10), 22050))));
throws('encode rejects fractional rate', () => encodeWavPcm16(clip, 16000.5), RangeError);

/* ─── Parser robustness ─── */
throws('parse rejects junk', () => parseWav(new TextEncoder().encode('ID3 not a wav at all').buffer), WavFormatError);
throws('parse rejects empty', () => parseWav(new ArrayBuffer(0)), WavFormatError);
// A LIST chunk (odd size → pad byte) between fmt and data must be skipped.
{
  const samples = new Float32Array([0.5, -0.5, 0.25]);
  const plain = new Uint8Array(encodeWavPcm16(samples, 16000));
  const list = new Uint8Array([0x4c, 0x49, 0x53, 0x54, 3, 0, 0, 0, 0x61, 0x62, 0x63, 0]); // "LIST", size 3, "abc", pad
  const merged = new Uint8Array(plain.length + list.length);
  merged.set(plain.subarray(0, 36), 0);
  merged.set(list, 36);
  merged.set(plain.subarray(36), 36 + list.length);
  const parsed = parseWav(merged.buffer);
  check('parse skips LIST chunk with pad byte', { dataOffset: 56, dataBytes: 6 }, {
    dataOffset: parsed.dataOffset,
    dataBytes: parsed.dataBytes,
  });
}

/* ─── Greeting limits ─── */
check('ok greeting', null, greetingProblem({ durationSec: 12, bytes: wavByteLength(12 * 16000) }));
check('exactly 120 s is ok', null, greetingProblem({ durationSec: GREETING_MAX_SECONDS, bytes: wavByteLength(120 * 16000) }));
check('120 s at 16 kHz fits under 5 MB', true, wavByteLength(GREETING_MAX_SECONDS * GREETING_SAMPLE_RATE) < GREETING_MAX_BYTES);
check('too short', true, typeof greetingProblem({ durationSec: 0.4, bytes: 1000 }) === 'string');
check('NaN duration is a problem', true, typeof greetingProblem({ durationSec: Number.NaN, bytes: 1000 }) === 'string');
check(
  'too long names the length',
  true,
  (greetingProblem({ durationSec: 192, bytes: 1000 }) ?? '').includes('3:12'),
);
check('too big', true, typeof greetingProblem({ durationSec: 60, bytes: GREETING_MAX_BYTES + 1 }) === 'string');

console.log(`wav self-test: ${passed} checks passed`);
