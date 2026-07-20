/**
 * AnimatedNumber — a smoothly-tweening numeric readout. When `value` changes,
 * it eases from the previous value to the new one over `durationMs` using
 * requestAnimationFrame, so a balance visibly ROLLS during the demo instead of
 * snapping. `format` renders each interpolated frame (default: raw number).
 *
 * This is the "numbers move live" primitive for every payments surface — balance
 * hero, revenue totals, MPP tab spend, per-rail figures.
 *
 * React #310: every hook is at the top, before any return.
 * `prefers-reduced-motion` snaps instantly (no rAF loop).
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';

interface AnimatedNumberProps {
  value: number;
  /** Render an interpolated frame value to a string. */
  format?: (v: number) => string;
  durationMs?: number;
  style?: CSSProperties;
  className?: string;
  /** Optional: briefly flash this colour when the value changes. */
  flashColor?: string;
}

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function AnimatedNumber({
  value,
  format = (v) => String(Math.round(v)),
  durationMs = 850,
  style,
  className,
  flashColor,
}: AnimatedNumberProps) {
  // ── ALL hooks first (React #310) ────────────────────────────────────────────
  const [display, setDisplay] = useState(value);
  const [flashing, setFlashing] = useState(false);
  const fromRef = useRef(value);
  const rafRef = useRef<number | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // No-op when unchanged.
    if (fromRef.current === value) return;

    const from = fromRef.current;
    const to = value;

    if (prefersReducedMotion() || durationMs <= 0) {
      fromRef.current = to;
      setDisplay(to);
      return;
    }

    // Flash on change when a colour is provided.
    if (flashColor) {
      setFlashing(true);
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      flashTimerRef.current = setTimeout(() => setFlashing(false), 650);
    }

    const start = performance.now();
    const tick = (now: number) => {
      const elapsed = now - start;
      const t = Math.min(1, elapsed / durationMs);
      const eased = easeOutCubic(t);
      const current = from + (to - from) * eased;
      setDisplay(current);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = to;
        setDisplay(to);
      }
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [value, durationMs, flashColor]);

  // Clean up the flash timer on unmount.
  useEffect(() => () => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
  }, []);

  return (
    <span
      className={className}
      style={{
        ...style,
        color: flashing && flashColor ? flashColor : style?.color,
        transition: 'color 0.3s ease',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {format(display)}
    </span>
  );
}
