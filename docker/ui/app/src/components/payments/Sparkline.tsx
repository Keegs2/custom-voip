/**
 * Sparkline — a compact SVG area+line trend, used for the revenue trend on the
 * exec dashboard and the metered-usage mini-chart. Matches the app's SVG idiom
 * (gradient area fill, muted accent stroke, no axes chrome). Pure presentational.
 */

import { useId, useMemo } from 'react';
import { GLASS, hexToRgba } from '../glass/glass';

interface SparklineProps {
  /** Y values in draw order (e.g. per-day revenue in minor units). */
  values: number[];
  accent?: string;
  height?: number;
  /** Optional formatter for the hover title on the last point. */
  format?: (v: number) => string;
}

export function Sparkline({ values, accent = GLASS.accent, height = 72, format }: SparklineProps) {
  const gradId = useId();

  const { linePath, areaPath, lastX, lastY } = useMemo(() => {
    const W = 600;
    const H = height;
    const PAD = 6;
    const n = values.length;
    if (n === 0) return { linePath: '', areaPath: '', lastX: 0, lastY: 0 };

    const max = Math.max(1, ...values);
    const min = Math.min(0, ...values);
    const range = Math.max(1, max - min);
    const stepX = n > 1 ? (W - PAD * 2) / (n - 1) : 0;
    const x = (i: number) => PAD + i * stepX;
    const y = (v: number) => PAD + (H - PAD * 2) * (1 - (v - min) / range);

    const pts = values.map((v, i) => `${x(i)},${y(v)}`);
    const line = `M ${pts.join(' L ')}`;
    const area = `${line} L ${x(n - 1)},${H - PAD} L ${x(0)},${H - PAD} Z`;
    return { linePath: line, areaPath: area, lastX: x(n - 1), lastY: y(values[n - 1]) };
  }, [values, height]);

  if (values.length === 0) {
    return (
      <div style={{ fontSize: '0.78rem', color: GLASS.textMuted, padding: '18px 0', textAlign: 'center' }}>
        No trend data yet.
      </div>
    );
  }

  return (
    <svg viewBox={`0 0 600 ${height}`} preserveAspectRatio="none" style={{ width: '100%', height, display: 'block' }} aria-hidden>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={hexToRgba(accent, 0.32)} />
          <stop offset="100%" stopColor={hexToRgba(accent, 0)} />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradId})`} />
      <path d={linePath} fill="none" stroke={accent} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lastX} cy={lastY} r={3.5} fill={accent}>
        {format && <title>{format(values[values.length - 1])}</title>}
      </circle>
    </svg>
  );
}
