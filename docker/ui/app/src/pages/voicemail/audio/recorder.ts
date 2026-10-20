/**
 * recorder.ts — captures raw PCM from the microphone for a greeting.
 *
 * MediaRecorder is deliberately NOT used: it produces Opus/WebM (or AAC on
 * Safari) that we would have to decode again. Instead the mic stream runs
 * through Web Audio and we copy the float samples ourselves:
 *
 *   getUserMedia → MediaStreamSource → [AudioWorkletNode 'vm-capture'] → muted gain → destination
 *                                     (fallback: ScriptProcessorNode)
 *
 * Both capture nodes take ONE input channel with channelCountMode
 * 'explicit', so the browser down-mixes a stereo mic to mono for us. The
 * muted gain keeps the graph pulled without echoing the caller back.
 *
 * Capture stops by itself at `maxSeconds` (onLimit fires once). Nothing is
 * written anywhere: samples live in this module's memory until stop().
 */
import { concatSamples, peakLevel } from './wav';
import type { PcmClip } from './transcode';

export class RecorderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecorderError';
  }
}

export interface RecorderProgress {
  /** Seconds captured so far. */
  elapsed: number;
  /** Peak level of the latest chunk, 0..1. */
  level: number;
}

export interface RecorderOptions {
  maxSeconds: number;
  onProgress: (progress: RecorderProgress) => void;
  /** Fired once when capture reaches maxSeconds (the caller should stop()). */
  onLimit: () => void;
}

export interface RecorderHandle {
  /** Stops capture and returns everything recorded (mono, device rate). */
  stop: () => Promise<PcmClip>;
  /** Stops capture and throws the audio away. */
  cancel: () => void;
}

/** Posts mono chunks of 2048 frames; flushes the tail and acks on 'stop'. */
const WORKLET_SOURCE = `
class VmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(2048);
    this.n = 0;
    this.live = true;
    this.port.onmessage = (e) => {
      if (e.data === 'stop') {
        this.flush();
        this.live = false;
        this.port.postMessage({ done: true });
      }
    };
  }
  flush() {
    if (this.n > 0) {
      const out = this.buf.slice(0, this.n);
      this.port.postMessage(out, [out.buffer]);
      this.n = 0;
    }
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (this.live && ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) {
          const out = this.buf;
          this.port.postMessage(out, [out.buffer]);
          this.buf = new Float32Array(2048);
          this.n = 0;
        }
      }
    }
    return this.live;
  }
}
registerProcessor('vm-capture', VmCapture);
`;

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  const w = window as Window & { webkitAudioContext?: AudioContextCtor };
  return (typeof AudioContext !== 'undefined' ? AudioContext : w.webkitAudioContext) ?? null;
}

/** Why recording can't start on this page, or null when it can. */
export function recordingUnsupportedReason(): string | null {
  if (typeof window === 'undefined') return 'Recording isn’t available here.';
  if (!window.isSecureContext) return 'Recording needs a secure (HTTPS) connection. Upload a file instead.';
  if (!navigator.mediaDevices?.getUserMedia) return 'This browser can’t record audio. Upload a file instead.';
  if (!audioContextCtor()) return 'This browser can’t process audio. Upload a file instead.';
  return null;
}

function micErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone access was blocked. Allow it from the icon in the address bar, or upload a file instead.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone was found. Plug one in, or upload a file instead.';
    case 'NotReadableError':
      return 'The microphone is in use by another app. Close it and try again.';
    default:
      return 'The microphone couldn’t be started. Try again, or upload a file instead.';
  }
}

async function attachWorklet(
  ctx: AudioContext,
  onChunk: (chunk: Float32Array) => void,
): Promise<{ node: AudioNode; finish: () => Promise<void> } | null> {
  if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') return null;
  const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
  try {
    await ctx.audioWorklet.addModule(url);
  } catch {
    // e.g. a CSP without blob: in script-src — the ScriptProcessor path works.
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
  const node = new AudioWorkletNode(ctx, 'vm-capture', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
  });
  let resolveDone: (() => void) | null = null;
  node.port.onmessage = (e: MessageEvent<Float32Array | { done: true }>) => {
    if (e.data instanceof Float32Array) onChunk(e.data);
    else resolveDone?.();
  };
  const finish = () =>
    new Promise<void>((resolve) => {
      resolveDone = resolve;
      node.port.postMessage('stop');
      // Never hang the UI on a lost ack — the tail is at most ~40 ms.
      window.setTimeout(resolve, 400);
    });
  return { node, finish };
}

function attachScriptProcessor(ctx: AudioContext, onChunk: (chunk: Float32Array) => void): AudioNode {
  const node = ctx.createScriptProcessor(4096, 1, 1);
  node.onaudioprocess = (e: AudioProcessingEvent) => {
    onChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  return node;
}

/** Asks for the microphone and starts capturing. Throws RecorderError with a user-facing message. */
export async function startRecording({ maxSeconds, onProgress, onLimit }: RecorderOptions): Promise<RecorderHandle> {
  const unsupported = recordingUnsupportedReason();
  if (unsupported) throw new RecorderError(unsupported);

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    throw new RecorderError(micErrorMessage(err));
  }

  const Ctor = audioContextCtor() as AudioContextCtor;
  const ctx = new Ctor();
  const chunks: Float32Array[] = [];
  const maxSamples = Math.ceil(maxSeconds * ctx.sampleRate);
  let captured = 0;
  let limitFired = false;
  let closed = false;

  const onChunk = (chunk: Float32Array) => {
    if (closed || captured >= maxSamples) return;
    chunks.push(chunk);
    captured += chunk.length;
    onProgress({ elapsed: Math.min(captured, maxSamples) / ctx.sampleRate, level: peakLevel(chunk) });
    if (captured >= maxSamples && !limitFired) {
      limitFired = true;
      onLimit();
    }
  };

  const teardown = (nodes: AudioNode[]) => {
    closed = true;
    for (const n of nodes) {
      try {
        n.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    for (const track of stream.getTracks()) track.stop();
    void ctx.close().catch(() => undefined);
  };

  try {
    if (ctx.state === 'suspended') await ctx.resume();
    const source = ctx.createMediaStreamSource(stream);
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);

    const worklet = await attachWorklet(ctx, onChunk);
    const capture = worklet?.node ?? attachScriptProcessor(ctx, onChunk);
    source.connect(capture);
    capture.connect(sink);
    const nodes = [source, capture, sink];

    return {
      stop: async () => {
        if (worklet && !closed) await worklet.finish();
        teardown(nodes);
        return { samples: concatSamples(chunks, maxSamples), sampleRate: ctx.sampleRate };
      },
      cancel: () => {
        teardown(nodes);
        chunks.length = 0;
      },
    };
  } catch {
    teardown([]);
    throw new RecorderError('Recording couldn’t start in this browser. Upload a file instead.');
  }
}
