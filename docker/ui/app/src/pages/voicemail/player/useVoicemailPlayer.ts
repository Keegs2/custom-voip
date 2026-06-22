import { useCallback, useEffect, useRef, useState } from 'react';
import { getVoicemailPlaybackUrl } from '../../../api/voicemail';
import type { PlaybackSource } from '../../../types/voicemail';

export interface VoicemailPlayerApi {
  isLoading: boolean;
  isPlaying: boolean;
  error: string | null;
  /** Seconds. Falls back to the message's metadata duration until audio loads. */
  currentTime: number;
  duration: number;
  /** 0..1 progress for the waveform. */
  progress: number;
  playbackRate: number;
  toggle: () => void;
  /** Seek to a 0..1 fraction of the track. */
  seekFraction: (fraction: number) => void;
  setRate: (rate: number) => void;
}

interface Options {
  /** Fallback duration (from message metadata) before audio metadata loads. */
  fallbackDurationMs?: number;
  /** Fired exactly once, on the first successful play (drives mark-read). */
  onFirstPlay?: () => void;
}

/**
 * Owns a single hidden `HTMLAudioElement` and resolves the encrypted message's
 * playable source lazily, via the decrypt-stream boundary
 * (`getVoicemailPlaybackUrl`). Re-mints the scoped token when it nears expiry.
 *
 * All hooks are unconditional (React #310); the hook is always called with a
 * `messageId | null` — a null id simply leaves the player idle.
 */
export function useVoicemailPlayer(
  messageId: number | null,
  { fallbackDurationMs = 0, onFirstPlay }: Options = {},
): VoicemailPlayerApi {
  const [isLoading, setIsLoading] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const sourceRef = useRef<PlaybackSource | null>(null);
  const firedFirstPlay = useRef(false);
  // Keep the latest onFirstPlay in a ref so callbacks don't churn dependencies.
  const onFirstPlayRef = useRef(onFirstPlay);
  onFirstPlayRef.current = onFirstPlay;

  // Create the audio element once, attach listeners, tear down on unmount.
  useEffect(() => {
    const audio = new Audio();
    audio.preload = 'none';
    audioRef.current = audio;

    const onTime = () => setCurrentTime(audio.currentTime || 0);
    const onMeta = () => {
      if (Number.isFinite(audio.duration)) setDuration(audio.duration);
    };
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEnded = () => {
      setIsPlaying(false);
      setCurrentTime(0);
      audio.currentTime = 0;
    };
    const onErr = () => {
      setIsPlaying(false);
      setIsLoading(false);
      setError('Could not play this message');
    };

    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('durationchange', onMeta);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onErr);

    return () => {
      audio.pause();
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('durationchange', onMeta);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onErr);
      audio.removeAttribute('src');
      audio.load();
      audioRef.current = null;
    };
  }, []);

  // Reset everything when the selected message changes.
  useEffect(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    sourceRef.current = null;
    firedFirstPlay.current = false;
    setIsPlaying(false);
    setIsLoading(false);
    setError(null);
    setCurrentTime(0);
    setDuration(0);
  }, [messageId]);

  // Apply playback rate to the (persistent) element whenever it changes.
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = playbackRate;
  }, [playbackRate]);

  const ensureSource = useCallback(async (audio: HTMLAudioElement) => {
    const cached = sourceRef.current;
    const stillValid =
      cached !== null && (cached.kind !== 'url' || cached.expires_at > Date.now() + 5_000);
    if (stillValid && audio.src) return;

    if (messageId === null) throw new Error('No message selected');
    setIsLoading(true);
    try {
      const src = await getVoicemailPlaybackUrl(messageId);
      sourceRef.current = src;
      audio.src = src.kind === 'url' ? src.url : src.blobUrl;
      audio.playbackRate = playbackRate;
    } finally {
      setIsLoading(false);
    }
  }, [messageId, playbackRate]);

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || messageId === null) return;

    if (!audio.paused) {
      audio.pause();
      return;
    }

    setError(null);
    void (async () => {
      try {
        await ensureSource(audio);
        if (!firedFirstPlay.current) {
          firedFirstPlay.current = true;
          onFirstPlayRef.current?.();
        }
        await audio.play();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Playback failed');
      }
    })();
  }, [ensureSource, messageId]);

  const effectiveDuration = duration > 0 ? duration : fallbackDurationMs / 1000;

  const seekFraction = useCallback(
    (fraction: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      const clamped = Math.min(1, Math.max(0, fraction));
      const target = clamped * effectiveDuration;
      if (Number.isFinite(target) && target >= 0) {
        audio.currentTime = target;
        setCurrentTime(target);
      }
    },
    [effectiveDuration],
  );

  const setRate = useCallback((rate: number) => setPlaybackRate(rate), []);

  const progress = effectiveDuration > 0 ? Math.min(1, currentTime / effectiveDuration) : 0;

  return {
    isLoading,
    isPlaying,
    error,
    currentTime,
    duration: effectiveDuration,
    progress,
    playbackRate,
    toggle,
    seekFraction,
    setRate,
  };
}
