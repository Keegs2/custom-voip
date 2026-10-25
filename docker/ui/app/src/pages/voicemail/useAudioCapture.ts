/**
 * useAudioCapture — the record / upload → transcode → preview state machine
 * behind every "add audio" dialog: voicemail greetings (GreetingDialog) and
 * IVR prompts (pages/ivr/prompts/PromptDialog). One implementation, so both
 * products capture, convert and preview audio identically:
 *
 *   Record  → mic (Web Audio PCM, auto-stop at maxSeconds) ─┐
 *   Upload  → any audio file → decodeAudioData ─────────────┤
 *                                                           ↓
 *       downmix → `sampleRate` (OfflineAudioContext) → PCM16 WAV → limits
 *                                                           ↓
 *       preview from an object URL (revoked on replace / unmount)
 *
 * Nothing leaves the browser here; the caller uploads `ready.audio.wav`.
 * The mic is released if the owner unmounts mid-take.
 *
 * React #310: every hook is unconditional.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { buildGreetingWav, decodeAudioFile, GreetingAudioError, type GreetingAudio } from './audio/transcode';
import { recordingUnsupportedReason, RecorderError, startRecording, type RecorderHandle } from './audio/recorder';
import { GREETING_MAX_SECONDS, GREETING_SAMPLE_RATE } from './audio/wav';

export type CaptureSource = 'record' | 'upload';

export type CaptureStage =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'recording'; elapsed: number; level: number }
  | { kind: 'processing' }
  | { kind: 'ready'; audio: GreetingAudio; url: string; from: string }
  | { kind: 'error'; message: string };

export interface AudioCaptureOptions {
  /** Output rate: 16 kHz for voicemail greetings (default), 8 kHz for IVR prompts. */
  sampleRate?: number;
  maxSeconds?: number;
  /** "greeting" / "message" — used in limit messages. */
  noun?: string;
  initialSource?: CaptureSource;
}

export interface AudioCapture {
  source: CaptureSource;
  stage: CaptureStage;
  /** Set when a clip is converted and ready to preview / upload. */
  ready: Extract<CaptureStage, { kind: 'ready' }> | null;
  recording: boolean;
  processing: boolean;
  /** Why this browser can't record (insecure origin, no mic API), else null. */
  unsupported: string | null;
  sampleRate: number;
  maxSeconds: number;
  noun: string;
  /** Switches Record ⇄ Upload, discarding any clip. No-op while busy. */
  switchSource: (next: CaptureSource) => boolean;
  startRecordingTake: () => Promise<void>;
  stopRecording: () => Promise<void>;
  takeFile: (file: File | undefined) => void;
  /** Back to idle, dropping the clip and its preview URL. */
  reset: () => void;
}

const CONVERT_ERROR = 'That audio couldn’t be converted. Try another file or recording.';

export function useAudioCapture(options: AudioCaptureOptions = {}): AudioCapture {
  const sampleRate = options.sampleRate ?? GREETING_SAMPLE_RATE;
  const maxSeconds = options.maxSeconds ?? GREETING_MAX_SECONDS;
  const noun = options.noun ?? 'greeting';

  // ── ALL hooks unconditionally at the top (React #310) ──
  const [unsupported] = useState(recordingUnsupportedReason);
  const [source, setSource] = useState<CaptureSource>(
    () => options.initialSource ?? (recordingUnsupportedReason() ? 'upload' : 'record'),
  );
  const [stage, setStage] = useState<CaptureStage>({ kind: 'idle' });
  const recorderRef = useRef<RecorderHandle | null>(null);
  const urlRef = useRef<string | null>(null);

  /** Swaps the preview object URL, revoking the old one. */
  const setPreviewUrl = useCallback((url: string | null) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = url;
  }, []);

  // Release the mic and the preview URL when the owner goes away.
  useEffect(
    () => () => {
      recorderRef.current?.cancel();
      recorderRef.current = null;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    },
    [],
  );

  const finishClip = useCallback(
    async (make: () => Promise<GreetingAudio>, from: string) => {
      setStage({ kind: 'processing' });
      try {
        const audio = await make();
        const url = URL.createObjectURL(audio.wav);
        setPreviewUrl(url);
        setStage({ kind: 'ready', audio, url, from });
      } catch (err) {
        setPreviewUrl(null);
        setStage({ kind: 'error', message: err instanceof GreetingAudioError ? err.message : CONVERT_ERROR });
      }
    },
    [setPreviewUrl],
  );

  const stopRecording = useCallback(async () => {
    const handle = recorderRef.current;
    if (!handle) return;
    recorderRef.current = null;
    const clip = await handle.stop();
    await finishClip(() => buildGreetingWav(clip, { sampleRate, noun }), 'Recording');
  }, [finishClip, sampleRate, noun]);

  const startRecordingTake = useCallback(async () => {
    setPreviewUrl(null);
    setStage({ kind: 'starting' });
    try {
      recorderRef.current = await startRecording({
        maxSeconds,
        onProgress: ({ elapsed, level }) => setStage({ kind: 'recording', elapsed, level }),
        onLimit: () => void stopRecording(),
      });
      setStage({ kind: 'recording', elapsed: 0, level: 0 });
    } catch (err) {
      recorderRef.current = null;
      setStage({ kind: 'error', message: err instanceof RecorderError ? err.message : 'Recording couldn’t start.' });
    }
  }, [setPreviewUrl, stopRecording, maxSeconds]);

  const takeFile = useCallback(
    (file: File | undefined) => {
      if (!file) return;
      void finishClip(async () => buildGreetingWav(await decodeAudioFile(file, noun), { sampleRate, noun }), file.name);
    },
    [finishClip, sampleRate, noun],
  );

  const recording = stage.kind === 'recording' || stage.kind === 'starting';
  const processing = stage.kind === 'processing';

  const reset = useCallback(() => {
    recorderRef.current?.cancel();
    recorderRef.current = null;
    setPreviewUrl(null);
    setStage({ kind: 'idle' });
  }, [setPreviewUrl]);

  const switchSource = useCallback(
    (next: CaptureSource) => {
      if (recording || processing) return false;
      setSource(next);
      setPreviewUrl(null);
      setStage({ kind: 'idle' });
      return true;
    },
    [recording, processing, setPreviewUrl],
  );

  return {
    source,
    stage,
    ready: stage.kind === 'ready' ? stage : null,
    recording,
    processing,
    unsupported,
    sampleRate,
    maxSeconds,
    noun,
    switchSource,
    startRecordingTake,
    stopRecording,
    takeFile,
    reset,
  };
}
