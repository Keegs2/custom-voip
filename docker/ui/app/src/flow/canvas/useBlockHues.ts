/**
 * useBlockHues — the block hues as RESOLVED colours, for the one consumer
 * that can't take a var(): the React Flow MiniMap (it hashes colours into
 * marker / mask ids). Mirrors the `--ivr-*` palette in styles/ivr.css,
 * which aliases theme tokens; Voicemail is a mix of violet and red there
 * and here. Re-read on every theme switch (useResolvedToken).
 */
import { useMemo } from 'react';
import { useResolvedToken } from '../../contexts/ThemeContext';
import type { IvrNodeType } from '../../types/ivr';

function parseHex(value: string): [number, number, number] | null {
  const v = value.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(v)) return [0, 1, 2].map((i) => parseInt(v[i] + v[i], 16)) as [number, number, number];
  if (/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(v)) return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16)) as [number, number, number];
  return null;
}

function toHex(rgb: readonly number[]): string {
  return '#' + rgb.map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('');
}

/** `a` and `b` mixed (weight of `a` 0–1); falls back to `a` when unparseable. */
export function mixColors(a: string, b: string, weightA = 0.5): string {
  const x = parseHex(a);
  const y = parseHex(b);
  if (!x || !y) return a;
  return toHex(x.map((c, i) => c * weightA + y[i] * (1 - weightA)));
}

/** `color` at `alpha` as #rrggbbaa (hex only; other forms pass through). */
export function withAlpha(color: string, alpha: number): string {
  const rgb = parseHex(color);
  if (!rgb) return color;
  return toHex(rgb) + Math.round(alpha * 255).toString(16).padStart(2, '0');
}

export function useBlockHues(): Record<IvrNodeType, string> {
  const azure = useResolvedToken('accent-line');
  const violet = useResolvedToken('violet');
  const cobalt = useResolvedToken('cobalt');
  const amber = useResolvedToken('warn-solid');
  const teal = useResolvedToken('teal');
  const green = useResolvedToken('ok-solid');
  const red = useResolvedToken('danger-solid');
  const slate = useResolvedToken('text-dim');
  return useMemo(
    () => ({
      entry: azure,
      play: violet,
      menu: cobalt,
      schedule: amber,
      condition: teal,
      dial: green,
      voicemail: mixColors(violet, red, 0.5),
      goto: slate,
      hangup: red,
    }),
    [azure, violet, cobalt, amber, teal, green, red, slate],
  );
}
