import { useCallback, useMemo, useRef } from 'react';
import { useVoicemailPlayer } from './useVoicemailPlayer';

/* ─── Icons ───────────────────────────────────────────────── */

const IconPlay = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 18, height: 18, marginLeft: 2 }}>
    <path
      fillRule="evenodd"
      d="M4.5 5.653c0-1.427 1.529-2.33 2.779-1.643l11.54 6.347c1.295.712 1.295 2.573 0 3.286L7.28 19.99c-1.25.687-2.779-.217-2.779-1.643V5.653Z"
      clipRule="evenodd"
    />
  </svg>
);

const IconPause = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 18, height: 18 }}>
    <path
      fillRule="evenodd"
      d="M6.75 5.25a.75.75 0 0 1 .75-.75H9a.75.75 0 0 1 .75.75v13.5a.75.75 0 0 1-.75.75H7.5a.75.75 0 0 1-.75-.75V5.25Zm7.5 0A.75.75 0 0 1 15 4.5h1.5a.75.75 0 0 1 .75.75v13.5a.75.75 0 0 1-.75.75H15a.75.75 0 0 1-.75-.75V5.25Z"
      clipRule="evenodd"
    />
  </svg>
);

/* ─── Helpers ─────────────────────────────────────────────── */

const ACCENT = '#818cf8';
const BAR_COUNT = 56;
const SPEEDS = [1, 1.5, 2] as const;

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Deterministic pseudo-waveform from the message id, used when the backend
 * doesn't supply real `peaks`. A tiny LCG keeps it stable across renders so the
 * bars don't jump while scrubbing.
 */
function pseudoPeaks(seed: number, count: number): number[] {
  let state = (seed * 2654435761) >>> 0 || 1;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    state = (1664525 * state + 1013904223) >>> 0;
    const base = (state / 0xffffffff);
    // Shape it a little so the middle reads "louder" than the edges.
    const envelope = 0.45 + 0.55 * Math.sin((i / count) * Math.PI);
    out.push(Math.max(0.12, Math.min(1, base * envelope)));
  }
  return out;
}

/* ─── Component ───────────────────────────────────────────── */

interface VoicemailPlayerProps {
  messageId: number;
  durationMs: number;
  peaks?: number[];
  /** Fired on first play — used by the inbox to mark-read-on-play. */
  onFirstPlay?: () => void;
}

export function VoicemailPlayer({ messageId, durationMs, peaks, onFirstPlay }: VoicemailPlayerProps) {
  // All hooks unconditionally at the top (React #310).
  const waveRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  const player = useVoicemailPlayer(messageId, {
    fallbackDurationMs: durationMs,
    onFirstPlay,
  });

  const bars = useMemo(
    () => (peaks && peaks.length > 0 ? peaks : pseudoPeaks(messageId, BAR_COUNT)),
    [peaks, messageId],
  );

  const seekFromClientX = useCallback(
    (clientX: number) => {
      const el = waveRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      player.seekFraction((clientX - rect.left) / rect.width);
    },
    [player],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      draggingRef.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      seekFromClientX(e.clientX);
    },
    [seekFromClientX],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (draggingRef.current) seekFromClientX(e.clientX);
    },
    [seekFromClientX],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  const filledBars = Math.round(player.progress * bars.length);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: 16,
        borderRadius: 14,
        background: 'rgba(15,17,23,0.6)',
        border: `1px solid ${ACCENT}22`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        {/* Play / pause */}
        <button
          type="button"
          onClick={player.toggle}
          disabled={player.isLoading}
          aria-label={player.isPlaying ? 'Pause' : 'Play'}
          style={{
            width: 44,
            height: 44,
            borderRadius: '50%',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: 'none',
            cursor: player.isLoading ? 'wait' : 'pointer',
            color: '#fff',
            background: `linear-gradient(135deg, ${ACCENT} 0%, #6366f1 100%)`,
            boxShadow: `0 4px 16px ${ACCENT}55`,
            transition: 'transform 0.1s',
          }}
          onMouseDown={(e) => { e.currentTarget.style.transform = 'scale(0.93)'; }}
          onMouseUp={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
        >
          {player.isLoading ? (
            <span
              style={{
                width: 18,
                height: 18,
                border: '2px solid rgba(255,255,255,0.4)',
                borderTopColor: '#fff',
                borderRadius: '50%',
                animation: 'spin 0.8s linear infinite',
              }}
            />
          ) : player.isPlaying ? (
            <IconPause />
          ) : (
            <IconPlay />
          )}
        </button>

        {/* Waveform — click / drag to scrub */}
        <div
          ref={waveRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          role="slider"
          aria-label="Scrub voicemail"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(player.progress * 100)}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') player.seekFraction(Math.min(1, player.progress + 0.05));
            if (e.key === 'ArrowLeft') player.seekFraction(Math.max(0, player.progress - 0.05));
          }}
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            height: 44,
            cursor: 'pointer',
            touchAction: 'none',
            userSelect: 'none',
          }}
        >
          {bars.map((peak, i) => {
            const active = i < filledBars;
            return (
              <div
                key={i}
                style={{
                  flex: 1,
                  height: `${Math.round(peak * 100)}%`,
                  minHeight: 3,
                  borderRadius: 2,
                  background: active ? ACCENT : 'rgba(148,163,184,0.22)',
                  boxShadow: active ? `0 0 6px ${ACCENT}66` : 'none',
                  transition: 'background 0.12s, box-shadow 0.12s',
                }}
              />
            );
          })}
        </div>

        {/* Clock */}
        <span
          style={{
            fontSize: '0.72rem',
            color: '#94a3b8',
            fontVariantNumeric: 'tabular-nums',
            flexShrink: 0,
            minWidth: 78,
            textAlign: 'right',
          }}
        >
          {formatClock(player.currentTime)} / {formatClock(player.duration)}
        </span>
      </div>

      {/* Speed control + error */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: '0.66rem', color: '#475569', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            Speed
          </span>
          {SPEEDS.map((rate) => {
            const active = player.playbackRate === rate;
            return (
              <button
                key={rate}
                type="button"
                onClick={() => player.setRate(rate)}
                style={{
                  padding: '3px 9px',
                  borderRadius: 7,
                  fontSize: '0.68rem',
                  fontWeight: 700,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                  border: active ? `1px solid ${ACCENT}55` : '1px solid rgba(255,255,255,0.08)',
                  background: active ? `${ACCENT}22` : 'transparent',
                  color: active ? ACCENT : '#64748b',
                  transition: 'all 0.12s',
                }}
              >
                {rate}×
              </button>
            );
          })}
        </div>
        {player.error && (
          <span style={{ fontSize: '0.7rem', color: '#f87171' }}>{player.error}</span>
        )}
      </div>
    </div>
  );
}
