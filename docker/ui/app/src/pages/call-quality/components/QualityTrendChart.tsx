/**
 * QualityTrendChart — a smooth SVG line/area chart for one daily quality metric.
 * Handles gaps (null days), a soft area gradient under the line, gridlines with
 * y-axis labels, and per-point hover titles. Purely presentational.
 */

import { useId } from 'react';
import type { TrendPoint } from '../types';
import { chartLabel, chartSurface } from '../styles';

interface QualityTrendChartProps {
  points: TrendPoint[];
  accent: string;
  label: string;
  formatY: (v: number) => string;
  yMin?: number;
  yMax?: number;
}

export function QualityTrendChart({ points, accent, label, formatY, yMin, yMax }: QualityTrendChartProps) {
  const gradId = useId();

  const validValues = points.map((p) => p.value).filter((v): v is number => v != null);
  const dataMin = validValues.length > 0 ? Math.min(...validValues) : 0;
  const dataMax = validValues.length > 0 ? Math.max(...validValues) : 1;

  const visMin = yMin ?? Math.max(0, dataMin - (dataMax - dataMin) * 0.15);
  const visMax = yMax ?? (dataMax + (dataMax - dataMin) * 0.15 || 1);
  const range = visMax - visMin || 1;

  const W = 500;
  const H = 160;
  const PAD_L = 44;
  const PAD_R = 12;
  const PAD_T = 14;
  const PAD_B = 28;
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;

  const coords = points.map((p, i) => ({
    x: PAD_L + (i / Math.max(points.length - 1, 1)) * chartW,
    y: p.value != null ? PAD_T + chartH - ((p.value - visMin) / range) * chartH : null,
    point: p,
  }));

  function buildPathSegments(): string[] {
    const segments: string[] = [];
    let current: string | null = null;

    for (let i = 0; i < coords.length; i++) {
      const c = coords[i];
      if (c.y == null) {
        if (current) { segments.push(current); current = null; }
        continue;
      }
      if (current == null) {
        current = `M ${c.x.toFixed(2)} ${c.y.toFixed(2)}`;
      } else {
        const prev2 = coords[Math.max(i - 2, 0)];
        const prev1 = coords[i - 1];
        const next1 = coords[Math.min(i + 1, coords.length - 1)];
        const p0 = { x: prev2.x, y: prev2.y ?? c.y };
        const p1 = { x: prev1.x, y: prev1.y ?? c.y };
        const p2 = { x: c.x, y: c.y };
        const p3 = { x: next1.x, y: next1.y ?? c.y };
        const t = 0.3;
        const cp1x = p1.x + (p2.x - p0.x) * t;
        const cp1y = p1.y + (p2.y - p0.y) * t;
        const cp2x = p2.x - (p3.x - p1.x) * t;
        const cp2y = p2.y - (p3.y - p1.y) * t;
        current += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
      }
    }
    if (current) segments.push(current);
    return segments;
  }

  const pathSegments = buildPathSegments();
  const firstSegment = pathSegments[0] ?? '';
  const firstStart = coords.find((c) => c.y != null);
  const firstEnd = [...coords].reverse().find((c) => c.y != null);
  const areaPath = firstSegment && firstStart && firstEnd
    ? `${firstSegment} L ${firstEnd.x.toFixed(2)} ${(PAD_T + chartH).toFixed(2)} L ${firstStart.x.toFixed(2)} ${(PAD_T + chartH).toFixed(2)} Z`
    : '';

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((frac) => ({
    y: PAD_T + chartH - frac * chartH,
    value: visMin + frac * range,
  }));

  const LABEL_EVERY = Math.ceil(points.length / 6);

  return (
    <div style={{ width: '100%' }}>
      <div style={chartLabel}>{label}</div>
      <div style={chartSurface}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block', minHeight: 140 }} aria-label={label}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={accent} stopOpacity={0.35} />
              <stop offset="100%" stopColor={accent} stopOpacity={0.02} />
            </linearGradient>
          </defs>

          {gridLines.map(({ y, value }) => (
            <g key={value}>
              <line x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
              <text x={PAD_L - 6} y={y + 4} textAnchor="end" fontSize={9} fill="#94a3b8" fontFamily="system-ui, -apple-system, sans-serif">
                {formatY(value)}
              </text>
            </g>
          ))}

          {areaPath && <path d={areaPath} fill={`url(#${gradId})`} />}

          {pathSegments.map((d, i) => (
            <path key={i} d={d} fill="none" stroke={accent} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          ))}

          {coords.map((c) => {
            if (c.y == null) return null;
            return (
              <g key={c.point.date}>
                <circle cx={c.x} cy={c.y} r={2.5} fill="#0f1117" stroke={accent} strokeWidth={1.5} />
                <title>{c.point.label}: {c.point.value != null ? formatY(c.point.value) : '—'}</title>
              </g>
            );
          })}

          {coords.map((c, i) => {
            if (i % LABEL_EVERY !== 0) return null;
            return (
              <text key={c.point.date} x={c.x} y={H - 6} textAnchor="middle" fontSize={9} fill="#94a3b8" fontFamily="system-ui, -apple-system, sans-serif">
                {c.point.label}
              </text>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
