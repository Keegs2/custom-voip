/**
 * CdrStatsBar — aggregate stats for the current CDR result set.
 *
 * Styling: the shared DAYLIGHT CONSOLE system — one white `dl-panel` slab
 * carrying left-keyline figures in the statline language (`dlx4-statline`
 * in styles/dl-platform-b.css). Status-measured figures (ASR, margin) keep
 * their green/amber/red semantics in light-tuned tones; the stat math is
 * unchanged.
 */
import { useMemo } from 'react';
import type { Cdr } from '../../types/cdr';

/** Light-tuned semantic tones (mirrors the Call Quality daylight palette). */
const GOOD = 'var(--rcf-green)';
const WARN = '#b45309';
const BAD = 'var(--rcf-red)';
const AZURE_DEEP = 'var(--rcf-azure-deep)';

/** Formats total seconds as HH:MM:SS */
function formatTotalDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function fmtMoney4(val: number): string {
  return `$${val.toFixed(4)}`;
}

interface StatFigureProps {
  label: string;
  value: string;
  /** Semantic accent — colors both the keyline and the numeral. */
  accent?: string;
}

function StatFigure({ label, value, accent }: StatFigureProps) {
  return (
    <div
      className={accent ? 'dlx4-stat' : 'dlx4-stat dlx4-stat-dim'}
      style={accent ? { borderLeftColor: accent } : undefined}
    >
      <div className="dlx4-stat-value" style={accent ? { color: accent } : undefined}>
        {value}
      </div>
      <div className="dlx4-stat-label">{label}</div>
    </div>
  );
}

interface CdrStatsBarProps {
  cdrs: Cdr[];
  total: number;
}

export function CdrStatsBar({ cdrs, total }: CdrStatsBarProps) {
  const stats = useMemo(() => {
    const answered = cdrs.filter((c) => c.answer_time != null).length;
    const asr = total > 0 ? (answered / cdrs.length) * 100 : 0;
    const totalDurSec = cdrs.reduce((sum, c) => sum + (c.duration_seconds ?? 0), 0);
    const totalBilled = cdrs.reduce((sum, c) => sum + (c.total_cost ?? 0), 0);
    const totalCost = cdrs.reduce((sum, c) => sum + (c.carrier_cost ?? 0), 0);
    const totalMargin = totalBilled - totalCost;
    const avgMarginPct = totalBilled > 0 ? (totalMargin / totalBilled) * 100 : null;

    return { answered, asr, totalDurSec, totalBilled, totalCost, totalMargin, avgMarginPct };
  }, [cdrs, total]);

  const asrAccent = stats.asr > 50 ? GOOD : stats.asr >= 30 ? WARN : BAD;

  const marginAccent = stats.totalMargin >= 0 ? GOOD : BAD;

  const avgMpAccent =
    stats.avgMarginPct == null
      ? undefined
      : stats.avgMarginPct >= 30
        ? GOOD
        : stats.avgMarginPct >= 15
          ? WARN
          : BAD;

  return (
    <section className="dl-panel">
      <div className="dl-panel-body" style={{ padding: '16px 20px' }}>
        <div className="dlx4-statline">
          <StatFigure label="Total Calls" value={total.toLocaleString()} />
          <StatFigure label="Answered" value={stats.answered.toLocaleString()} />
          <StatFigure label="ASR" value={`${stats.asr.toFixed(1)}%`} accent={asrAccent} />
          <StatFigure label="Duration" value={formatTotalDuration(stats.totalDurSec)} />
          <StatFigure label="Total Billed" value={fmtMoney4(stats.totalBilled)} accent={AZURE_DEEP} />
          <StatFigure label="Total Cost" value={fmtMoney4(stats.totalCost)} accent={BAD} />
          <StatFigure label="Total Margin" value={fmtMoney4(stats.totalMargin)} accent={marginAccent} />
          <StatFigure
            label="Avg Margin %"
            value={stats.avgMarginPct != null ? `${stats.avgMarginPct.toFixed(1)}%` : '--'}
            accent={avgMpAccent}
          />
        </div>
      </div>
    </section>
  );
}
