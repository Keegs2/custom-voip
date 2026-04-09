import { useMemo } from 'react';
import type { Cdr } from '../../types/cdr';

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

interface StatPillProps {
  label: string;
  value: string;
  accent?: string;
}

function StatPill({ label, value, accent }: StatPillProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        background: 'linear-gradient(135deg, rgba(30,33,48,0.8) 0%, rgba(19,21,29,0.9) 100%)',
        border: '1px solid rgba(42,47,69,0.6)',
        borderRadius: 12,
        padding: '10px 16px',
        minWidth: 90,
      }}
    >
      <span
        style={{
          fontSize: '0.62rem',
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: '#4a5568',
          marginBottom: 6,
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: '1rem',
          fontWeight: 700,
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 1,
          color: accent ?? '#e2e8f0',
        }}
      >
        {value}
      </span>
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

  const asrAccent =
    stats.asr > 50
      ? '#4ade80'
      : stats.asr >= 30
        ? '#fbbf24'
        : '#f87171';

  const marginAccent = stats.totalMargin >= 0 ? '#4ade80' : '#f87171';

  const avgMpAccent =
    stats.avgMarginPct == null
      ? undefined
      : stats.avgMarginPct >= 30
        ? '#4ade80'
        : stats.avgMarginPct >= 15
          ? '#fbbf24'
          : '#f87171';

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        marginBottom: 20,
      }}
    >
      <StatPill label="Total Calls" value={total.toLocaleString()} />
      <StatPill label="Answered" value={stats.answered.toLocaleString()} />
      <StatPill label="ASR" value={`${stats.asr.toFixed(1)}%`} accent={asrAccent} />
      <StatPill label="Duration" value={formatTotalDuration(stats.totalDurSec)} />
      <StatPill
        label="Total Billed"
        value={fmtMoney4(stats.totalBilled)}
        accent="#4ade80"
      />
      <StatPill label="Total Cost" value={fmtMoney4(stats.totalCost)} accent="#f87171" />
      <StatPill label="Total Margin" value={fmtMoney4(stats.totalMargin)} accent={marginAccent} />
      <StatPill
        label="Avg Margin %"
        value={stats.avgMarginPct != null ? `${stats.avgMarginPct.toFixed(1)}%` : '--'}
        accent={avgMpAccent}
      />
    </div>
  );
}
