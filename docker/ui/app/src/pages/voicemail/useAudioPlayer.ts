/**
 * useAudioPlayer — drives one <audio> element whose source is a short-lived
 * playback URL (contract §4.2/4.3: POST …/playback-token → {url, expires_in:
 * 120}; GET …/audio?t= is Range-capable WAV, decrypted in server memory).
 *
 * Token lifecycle:
 *  - Nothing is minted until the first Play (opening a message must not mark
 *    it read — minting does, server-side).
 *  - Play after the token is ~100 s old (or within 15 s of its expiry,
 *    whichever is sooner) mints a fresh one and resumes where the user was.
 *  - A mid-playback failure (the browser's next Range request hit an expired
 *    token → 401 → media error) is recovered ONCE per attempt: mint, reload,
 *    seek back, keep playing. A second failure surfaces an error.
 *
 * The URL is used verbatim as `src`; the bearer token never touches media
 * requests (the playback token authenticates them).
 *
 * React #310: all hooks are unconditional. Mutable playback facts live in
 * refs (they change between renders without needing one); the rendered
 * state is status / time / duration / rate / error.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { PlaybackToken } from '../../types/voicemail';
import { vmErrorText } from './voicemailData';

export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

export interface AudioPlayer {
  audioRef: RefObject<HTMLAudioElement | null>;
  status: PlayerStatus;
  error: string | null;
  currentTime: number;
  /** Media duration once known, else the fallback from metadata. */
  duration: number;
  rate: number;
  toggle: () => void;
  seek: (seconds: number) => void;
  setRate: (rate: number) => void;
}

export interface AudioPlayerOptions {
  /** Mints a fresh playback URL. */
  mint: () => Promise<PlaybackToken>;
  /** Duration from the message/greeting row, used until the media reports one. */
  fallbackDurationSec: number;
  /** Fired after every successful mint (e.g. reflect is_read in the list). */
  onMinted?: () => void;
}

/** Re-mint once the token is this old, even if the server would still take it. */
export const TOKEN_REFRESH_AFTER_MS = 100_000;
/** …or this close to its stated expiry, whichever comes first. */
const TOKEN_EXPIRY_MARGIN_MS = 15_000;
const METADATA_TIMEOUT_MS = 8_000;
const PLAY_ERROR = 'This recording couldn’t be played. Try again.';

function waitForMetadata(audio: HTMLAudioElement): Promise<void> {
  if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => {
      cleanup();
      resolve();
    };
    const fail = () => {
      cleanup();
      reject(new Error('media error'));
    };
    const timer = window.setTimeout(done, METADATA_TIMEOUT_MS);
    function cleanup() {
      window.clearTimeout(timer);
      audio.removeEventListener('loadedmetadata', done);
      audio.removeEventListener('error', fail);
    }
    audio.addEventListener('loadedmetadata', done);
    audio.addEventListener('error', fail);
  });
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

export function useAudioPlayer({ mint, fallbackDurationSec, onMinted }: AudioPlayerOptions): AudioPlayer {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const tokenRef = useRef<{ url: string; freshUntil: number } | null>(null);
  const wantPlayRef = useRef(false);
  const recoveringRef = useRef(false);
  const loadingRef = useRef(false);
  const lastTimeRef = useRef(0);
  const rateRef = useRef(1);
  const mintRef = useRef(mint);
  const onMintedRef = useRef(onMinted);

  const [status, setStatus] = useState<PlayerStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [rate, setRateState] = useState(1);

  // Latest callbacks without re-binding the media listeners.
  useEffect(() => {
    mintRef.current = mint;
    onMintedRef.current = onMinted;
  });

  /** Mints a token, points the element at it and restores the position. */
  const loadFresh = useCallback(async (resumeAt: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    loadingRef.current = true;
    setStatus('loading');
    try {
      const token = await mintRef.current();
      const lifetimeMs = Math.max(20, token.expires_in) * 1000;
      tokenRef.current = {
        url: token.url,
        freshUntil: Date.now() + Math.min(TOKEN_REFRESH_AFTER_MS, lifetimeMs - TOKEN_EXPIRY_MARGIN_MS),
      };
      onMintedRef.current?.();
      audio.defaultPlaybackRate = rateRef.current;
      audio.src = token.url;
      audio.playbackRate = rateRef.current;
      if (resumeAt > 0) {
        await waitForMetadata(audio);
        audio.currentTime = resumeAt;
      }
    } finally {
      loadingRef.current = false;
    }
  }, []);

  const fail = useCallback((err: unknown) => {
    wantPlayRef.current = false;
    setStatus('error');
    setError(vmErrorText(err, PLAY_ERROR));
  }, []);

  /** One silent retry with a fresh token after a media error. */
  const recover = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !tokenRef.current || loadingRef.current) return;
    if (recoveringRef.current) {
      fail(null);
      return;
    }
    recoveringRef.current = true;
    try {
      await loadFresh(lastTimeRef.current);
      if (wantPlayRef.current) await audio.play();
      else setStatus('paused');
    } catch (err) {
      if (!isAbort(err)) fail(err);
    }
  }, [fail, loadFresh]);

  // Media element listeners — bound once per element.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;
    const onTime = () => {
      lastTimeRef.current = audio.currentTime;
      setCurrentTime(audio.currentTime);
    };
    const onMeta = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) setMediaDuration(audio.duration);
    };
    const onPlaying = () => {
      recoveringRef.current = false;
      setError(null);
      setStatus('playing');
    };
    const onPause = () => {
      if (!loadingRef.current) setStatus('paused');
    };
    const onWaiting = () => setStatus('loading');
    const onError = () => {
      void recover();
    };
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('durationchange', onMeta);
    audio.addEventListener('playing', onPlaying);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('waiting', onWaiting);
    audio.addEventListener('error', onError);
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('durationchange', onMeta);
      audio.removeEventListener('playing', onPlaying);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('waiting', onWaiting);
      audio.removeEventListener('error', onError);
      // Release the decrypted stream: stop playback and drop the source.
      audio.pause();
      if (audio.hasAttribute('src')) {
        audio.removeAttribute('src');
        audio.load();
      }
    };
  }, [recover]);

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (loadingRef.current) {
      // A press while a fresh token loads means "stop": the load finishes
      // but playback does not resume.
      wantPlayRef.current = false;
      return;
    }
    if (!audio.paused) {
      wantPlayRef.current = false;
      audio.pause();
      return;
    }
    wantPlayRef.current = true;
    setError(null);
    void (async () => {
      try {
        const token = tokenRef.current;
        if (!token || Date.now() > token.freshUntil) {
          recoveringRef.current = false;
          await loadFresh(lastTimeRef.current);
        }
        if (wantPlayRef.current) await audio.play();
        else setStatus('paused');
      } catch (err) {
        if (!isAbort(err)) fail(err);
      }
    })();
  }, [fail, loadFresh]);

  const duration = mediaDuration > 0 ? mediaDuration : fallbackDurationSec;

  const seek = useCallback(
    (seconds: number) => {
      const audio = audioRef.current;
      const target = Math.max(0, Math.min(Number.isFinite(seconds) ? seconds : 0, duration || 0));
      lastTimeRef.current = target;
      setCurrentTime(target);
      // Before the first play there is no source yet — the position is
      // applied when the token is minted.
      if (audio && tokenRef.current) audio.currentTime = target;
    },
    [duration],
  );

  const setRate = useCallback((next: number) => {
    rateRef.current = next;
    setRateState(next);
    const audio = audioRef.current;
    if (audio) {
      audio.defaultPlaybackRate = next;
      audio.playbackRate = next;
    }
  }, []);

  return { audioRef, status, error, currentTime, duration, rate, toggle, seek, setRate };
}
