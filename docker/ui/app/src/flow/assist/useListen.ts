/**
 * useListen — "Listen" for a proposal's new messages: renders the text with
 * the chosen voice through `POST /ivr/prompts/tts-preview` (contract §8.2 —
 * not stored, 30 a minute per user) and plays it. One message plays at a
 * time; a second press stops it. Renders are cached per (voice, text) for
 * the life of the banner, and every object URL is revoked on unmount.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { previewTts } from '../../api/ivr';
import { ivrErrorText } from '../../pages/ivr/ivrData';

export interface Listen {
  /** The message playing now (its key), or null. */
  playing: string | null;
  /** The message being rendered now, or null. */
  loading: string | null;
  /** The last failure, for the message it belongs to. */
  failure: { key: string; text: string } | null;
  toggle: (key: string, text: string, voice: string) => void;
  stop: () => void;
}

export function useListen(customerId: number | undefined): Listen {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlsRef = useRef(new Map<string, string>());
  /** Bumped by every play/stop, so a late render can't start over a newer choice. */
  const turnRef = useRef(0);
  const [playing, setPlaying] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ key: string; text: string } | null>(null);

  const stop = useCallback(() => {
    turnRef.current += 1;
    audioRef.current?.pause();
    setPlaying(null);
    setLoading(null);
  }, []);

  const play = useCallback(
    async (key: string, text: string, voice: string) => {
      const turn = ++turnRef.current;
      audioRef.current?.pause();
      setPlaying(null);
      setFailure(null);
      const cacheKey = `${voice}\u0000${text}`;
      let url = urlsRef.current.get(cacheKey);
      if (!url) {
        setLoading(key);
        try {
          url = URL.createObjectURL(await previewTts(text, voice, customerId));
          urlsRef.current.set(cacheKey, url);
        } catch (err) {
          if (turnRef.current === turn) {
            setLoading(null);
            setFailure({ key, text: ivrErrorText(err, 'That message couldn’t be played. Try again.') });
          }
          return;
        }
        if (turnRef.current !== turn) return;
        setLoading(null);
      }
      // A fresh element per play: the previous one is paused and dropped.
      const el = new Audio(url);
      el.onended = () => {
        if (turnRef.current === turn) setPlaying(null);
      };
      audioRef.current?.pause();
      audioRef.current = el;
      try {
        await el.play();
        if (turnRef.current === turn) setPlaying(key);
      } catch {
        if (turnRef.current === turn) setFailure({ key, text: 'Your browser didn’t play the message. Try again.' });
      }
    },
    [customerId],
  );

  const toggle = useCallback(
    (key: string, text: string, voice: string) => {
      if (playing === key || loading === key) stop();
      else void play(key, text, voice);
    },
    [playing, loading, play, stop],
  );

  useEffect(() => {
    const urls = urlsRef.current;
    const turnBox = turnRef;
    const audioBox = audioRef;
    return () => {
      turnBox.current += 1;
      audioBox.current?.pause();
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  return { playing, loading, failure, toggle, stop };
}
