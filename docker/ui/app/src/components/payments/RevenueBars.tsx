/**
 * RevenueBars — a compact SVG bar chart of revenue split by settlement rail
 * (card / stablecoin / machine). Matches the app's SVG chart idiom used by
 * SavingsChart / QualityTrendChart: frosted-panel host supplied by the caller,
 * per-rail gradient fills, muted grid + labels, hover titles, tabular value
 * labels above each bar.
 *
 * Pure presentational — amounts are minor units, converted at render.
 */

import { useId, useMemo } from 'react';
import { GLASS } from '../glass/glass';
import { fmtDollars, sourceMeta } from './format';
import type { RevenueByRail } from '../../types/payments';

export function RevenueBars({ data }: { data: RevenueByRail[] }) {
  const gradId = useId();

  const rows = useMemo(
    () => [...data].sort((a, b) => b.revenue - a.revenue),
    [data],
  );

  const maxVal = useMemo(
    () => Math.max(1, ...rows.map((r) => r.revenue)),
    [rows],
  );

  const W = 620;
  const H = 240;
  const PAD_L = 64;
  const PAD_R = 18;
  const PAD_T = 24;
  const PAD_B = 46;
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;

  const yScale = (v: number) => PAD_T + chartH - (v / maxVal) * chartH;
  const groupW = chartW / Math.max(rows.length, 1);
  const barW = Math.min(78, groupW * 0.5);

  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
    y: PAD_T + chartH - f * chartH,
    value: maxVal * f,
  }));

  if (rows.length === 0) {
    return (
      <div style={{ fontSize: '0.82rem', color: GLASS.textMuted, padding: '30px 0', textAlign: 'center' }}>
        No revenue recorded yet — seed the demo and run a scenario.
      </div>
    );
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} aria-label="Revenue by rail">
      <defs>
        {rows.map((r) => (
          <linearGradient key={r.rail} id={`${gradId}-${r.rail}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={sourceMeta(r.rail).color} stopOpacity={0.95} />
            <stop offset="100%" stopColor={sourceMeta(r.rail).color} stopOpacity={0.42} />
          </linearGradient>
        ))}
      </defs>

      {grid.map(({ y, value }) => (
        <g key={value}>
          <line x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
          <text x={PAD_L - 8} y={y + 4} textAnchor="end" fontSize={9.5} fill="#94a3b8" fontFamily="ui-monospace, monospace">
            {value >= 1000 ? `$${Math.round(value / 1000)}k` : fmtDollars(value, 0)}
          </text>
        </g>
      ))}

      {rows.map((r, i) => {
        const cx = PAD_L + (i + 0.5) * groupW;
        const x = cx - barW / 2;
        const y = yScale(r.revenue);
        const floor = PAD_T + chartH;
        const meta = sourceMeta(r.rail);
        return (
          <g key={r.rail}>
            <rect x={x} y={y} width={barW} height={Math.max(0, floor - y)} rx={6} fill={`url(#${gradId}-${r.rail})`}>
              <title>{r.label}: {fmtDollars(r.revenue)} · {r.count} txns</title>
            </rect>
            {/* Value label above the bar */}
            <text x={cx} y={y - 8} textAnchor="middle" fontSize={12} fontWeight={700} fill={GLASS.text} fontFamily="ui-monospace, monospace">
              {fmtDollars(r.revenue, 0)}
            </text>
            {/* Rail label under the axis */}
            <text x={cx} y={H - 26} textAnchor="middle" fontSize={11} fontWeight={600} fill={meta.color} fontFamily="inherit">
              {meta.short}
            </text>
            <text x={cx} y={H - 12} textAnchor="middle" fontSize={9} fill="#94a3b8" fontFamily="inherit">
              {r.count} txns
            </text>
          </g>
        );
      })}
    </svg>
  );
}
