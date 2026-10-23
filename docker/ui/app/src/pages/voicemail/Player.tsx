/**
 * Player — play/pause, a scrubbable timeline, time / duration and speed for
 * one voicemail message or greeting. The timeline is a native range input
 * (keyboard, touch and screen readers for free), dressed with a filled
 * azure track. Mount it KEYED by the item id so a new item starts clean.
 */
import type { CSSProperties } from 'react';
import { Pause, Play } from 'lucide-react';
import type { PlaybackToken } from '../../types/voicemail';
import { useAudioPlayer } from './useAudioPlayer';
import { formatClock } from './format';

const SPEEDS = [1, 1.5, 2] as const;

export interface PlayerProps {
  mint: () => Promise<PlaybackToken>;
  durationMs: number;
  /** Accessible name of what plays, e.g. "message from (617) 555-0134". */
  label: string;
  onMinted?: () => void;
  /** Compact single-row variant (greeting lists). */
  compact?: boolean;
}

export function Player({ mint, durationMs, label, onMinted, compact = false }: PlayerProps) {
  // ALL hooks unconditionally at the top (React #310).
  // Destructured: the ref only goes to `ref=`, never read during render.
  const { audioRef, status, error, currentTime, duration, rate, toggle, seek, setRate } = useAudioPlayer({
    mint,
    fallbackDurationSec: durationMs / 1000,
    onMinted,
  });

  const busy = status === 'loading';
  const playing = status === 'playing';
  const max = duration > 0 ? duration : 0;
  const pct = max > 0 ? Math.min(100, (currentTime / max) * 100) : 0;

  return (
    <div className={`vm-player${compact ? ' vm-player-compact' : ''}`}>
      {/* preload="metadata": nothing loads until a token is minted (no src). */}
      <audio ref={audioRef} preload="metadata" />
      <div className="vm-player-row">
        <button
          type="button"
          className={`vm-play${playing ? ' vm-play-on' : ''}`}
          onClick={toggle}
          aria-label={`${playing ? 'Pause' : 'Play'} ${label}`}
          aria-busy={busy || undefined}
        >
          {busy ? (
            <span className="vm-spin" aria-hidden="true" />
          ) : playing ? (
            <Pause size={compact ? 14 : 18} strokeWidth={2.4} fill="currentColor" aria-hidden="true" />
          ) : (
            <Play size={compact ? 14 : 18} strokeWidth={2.4} fill="currentColor" aria-hidden="true" />
          )}
        </button>

        <div className="vm-track-wrap">
          <input
            type="range"
            className="vm-track"
            min={0}
            max={max || 1}
            step={0.05}
            value={Math.min(currentTime, max || 1)}
            disabled={max <= 0}
            onChange={(e) => seek(Number(e.target.value))}
            aria-label={`Position in ${label}`}
            aria-valuetext={`${formatClock(currentTime)} of ${formatClock(max)}`}
            style={{ '--vm-pct': `${pct}%` } as CSSProperties}
          />
        </div>

        <span className="vm-time" aria-hidden="true">
          {formatClock(currentTime)} / {formatClock(max)}
        </span>
      </div>

      {!compact && (
        <div className="vm-player-foot">
          <div className="vm-speed" role="group" aria-label="Playback speed">
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                className={`vm-speed-opt${rate === s ? ' vm-speed-on' : ''}`}
                aria-pressed={rate === s}
                onClick={() => setRate(s)}
              >
                {s}×
              </button>
            ))}
          </div>
          {error && (
            <span className="vm-player-err" role="alert">
              {error}
            </span>
          )}
        </div>
      )}
      {compact && error && (
        <span className="vm-player-err" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
