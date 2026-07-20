/**
 * SavingsChart — a compact SVG grouped-bar chart comparing the baseline carrier
 * cost against the actual (LCO-chosen) cost for the top destination prefixes. The
 * gap between the two bars IS the transparent saving. Matches the app's SVG chart
 * idiom (frosted panel, gradient fills, muted grid + labels, hover titles).
 */

import { useId, useMemo } from 'react';
import { GlassPanel } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import type { SavingsPrefix } from '../../../../types/lco';

const MAX_BARS = 10;

export function SavingsChart({ prefixes }: { prefixes: SavingsPrefix[] }) {
  const gradId = useId();

  const rows = useMemo(
    () => [...prefixes].sort((a, b) => b.savings - a.savings).slice(0, MAX_BARS),
    [prefixes],
  );

  const maxVal = useMemo(() => Math.max(0.0001, ...rows.map((r) => Math.max(r.baseline_cost, r.actual_cost))), [rows]);
  const decimals = maxVal < 1 ? 4 : 2;
  const fmtY = (v: number) => `$${v.toFixed(decimals)}`;

  const W = 620;
  const H = 220;
  const PAD_L = 54;
  const PAD_R = 16;
  const PAD_T = 16;
  const PAD_B = 40;
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;

  const yScale = (v: number) => PAD_T + chartH - (v / maxVal) * chartH;
  const groupW = chartW / Math.max(rows.length, 1);
  const barW = Math.min(16, groupW / 3);

  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ y: PAD_T + chartH - f * chartH, value: maxVal * f }));

  return (
    <GlassPanel padding="18px 20px" radius={16}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: '0.68rem', fontWeight: 700, color: GLASS.textFaint, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
          Baseline vs actual cost — top prefixes
        </span>
      </div>

      {rows.length === 0 ? (
        <div style={{ fontSize: '0.82rem', color: GLASS.textMuted, padding: '20px 0', textAlign: 'center' }}>
          No prefix-level activity in this window.
        </div>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} aria-label="Baseline vs actual cost by prefix">
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={GLASS.success} stopOpacity={0.9} />
              <stop offset="100%" stopColor={GLASS.success} stopOpacity={0.5} />
            </linearGradient>
          </defs>

          {grid.map(({ y, value }) => (
            <g key={value}>
              <line x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
              <text x={PAD_L - 6} y={y + 4} textAnchor="end" fontSize={9} fill="#94a3b8" fontFamily="ui-monospace, monospace">
                {fmtY(value)}
              </text>
            </g>
          ))}

          {rows.map((r, i) => {
            const cx = PAD_L + (i + 0.5) * groupW;
            const baseX = cx - barW - 2;
            const actX = cx + 2;
            const baseY = yScale(r.baseline_cost);
            const actY = yScale(r.actual_cost);
            const floor = PAD_T + chartH;
            return (
              <g key={r.prefix}>
                <rect x={baseX} y={baseY} width={barW} height={Math.max(0, floor - baseY)} rx={2} fill="rgba(148,163,184,0.35)">
                  <title>{r.prefix} baseline: {fmtY(r.baseline_cost)}</title>
                </rect>
                <rect x={actX} y={actY} width={barW} height={Math.max(0, floor - actY)} rx={2} fill={`url(#${gradId})`}>
                  <title>{r.prefix} actual: {fmtY(r.actual_cost)} · saved {fmtY(r.savings)}</title>
                </rect>
                <text x={cx} y={H - 22} textAnchor="middle" fontSize={8.5} fill="#94a3b8" fontFamily="ui-monospace, monospace">
                  {r.prefix}
                </text>
              </g>
            );
          })}
        </svg>
      )}

      {/* Legend */}
      <div style={{ display: 'flex', gap: 18, marginTop: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 12, height: 12, borderRadius: 3, background: 'rgba(148,163,184,0.35)', display: 'inline-block' }} />
          <span style={{ fontSize: '0.66rem', color: GLASS.textFaint }}>Baseline (most-expensive carrier)</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 12, height: 12, borderRadius: 3, background: GLASS.success, display: 'inline-block' }} />
          <span style={{ fontSize: '0.66rem', color: GLASS.textFaint }}>Actual (LCO-chosen)</span>
        </div>
      </div>
    </GlassPanel>
  );
}
