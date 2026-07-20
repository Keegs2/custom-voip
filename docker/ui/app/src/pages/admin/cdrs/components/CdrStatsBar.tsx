/**
 * Aggregate stat tiles for the loaded CDR set — glassified. Computes ASR,
 * duration, billed / cost / margin from the in-memory rows.
 */

import { useMemo } from 'react';
import { GlassPanel } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import { statTile, statLabel, statValue } from '../styles';
import type { Cdr } from '../../../../types/cdr';

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

function StatTile({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div style={statTile}>
      <span style={statLabel}>{label}</span>
      <span style={statValue(accent)}>{value}</span>
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

  const asrAccent = stats.asr > 50 ? GLASS.success : stats.asr >= 30 ? GLASS.warning : GLASS.danger;
  const marginAccent = stats.totalMargin >= 0 ? GLASS.success : GLASS.danger;
  const avgMpAccent =
    stats.avgMarginPct == null
      ? undefined
      : stats.avgMarginPct >= 30
        ? GLASS.success
        : stats.avgMarginPct >= 15
          ? GLASS.warning
          : GLASS.danger;

  return (
    <GlassPanel padding={14}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        <StatTile label="Total Calls" value={total.toLocaleString()} />
        <StatTile label="Answered" value={stats.answered.toLocaleString()} />
        <StatTile label="ASR" value={`${stats.asr.toFixed(1)}%`} accent={asrAccent} />
        <StatTile label="Duration" value={formatTotalDuration(stats.totalDurSec)} />
        <StatTile label="Total Billed" value={fmtMoney4(stats.totalBilled)} accent={GLASS.success} />
        <StatTile label="Total Cost" value={fmtMoney4(stats.totalCost)} accent={GLASS.danger} />
        <StatTile label="Total Margin" value={fmtMoney4(stats.totalMargin)} accent={marginAccent} />
        <StatTile
          label="Avg Margin %"
          value={stats.avgMarginPct != null ? `${stats.avgMarginPct.toFixed(1)}%` : '--'}
          accent={avgMpAccent}
        />
      </div>
    </GlassPanel>
  );
}
