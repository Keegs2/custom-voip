import { useMemo } from 'react';
import { cn } from '../../utils/cn';
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
  valueClass?: string;
}

function StatPill({ label, value, valueClass }: StatPillProps) {
  return (
    <div className="flex flex-col items-center bg-[#1e2130] border border-[#2a2f45] rounded-xl px-4 py-3 min-w-[100px]">
      <span className="text-[0.62rem] font-bold uppercase tracking-[0.8px] text-[#4a5568] mb-1.5 whitespace-nowrap">
        {label}
      </span>
      <span className={cn('text-base font-bold tabular-nums leading-none', valueClass ?? 'text-[#e2e8f0]')}>
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

  const asrClass =
    stats.asr > 50
      ? 'text-green-400'
      : stats.asr >= 30
        ? 'text-amber-400'
        : 'text-red-400';

  const marginClass = stats.totalMargin >= 0 ? 'text-green-400' : 'text-red-400';

  const avgMpClass =
    stats.avgMarginPct == null
      ? 'text-[#718096]'
      : stats.avgMarginPct >= 30
        ? 'text-green-400'
        : stats.avgMarginPct >= 15
          ? 'text-amber-400'
          : 'text-red-400';

  return (
    <div className="flex flex-wrap gap-2.5 mb-5">
      <StatPill label="Total Calls" value={total.toLocaleString()} />
      <StatPill label="Answered" value={stats.answered.toLocaleString()} />
      <StatPill label="ASR" value={`${stats.asr.toFixed(1)}%`} valueClass={asrClass} />
      <StatPill label="Duration" value={formatTotalDuration(stats.totalDurSec)} />
      <StatPill
        label="Total Billed"
        value={fmtMoney4(stats.totalBilled)}
        valueClass="text-green-400"
      />
      <StatPill label="Total Cost" value={fmtMoney4(stats.totalCost)} valueClass="text-red-400" />
      <StatPill label="Total Margin" value={fmtMoney4(stats.totalMargin)} valueClass={marginClass} />
      <StatPill
        label="Avg Margin %"
        value={stats.avgMarginPct != null ? `${stats.avgMarginPct.toFixed(1)}%` : '--'}
        valueClass={avgMpClass}
      />
    </div>
  );
}
