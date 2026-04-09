import { cn } from '../../utils/cn';
import type { MarginsData } from '../../types/rate';

interface StatCardProps {
  label: string;
  value: React.ReactNode;
  icon: string;
  valueClass?: string;
}

function StatCard({ label, value, icon, valueClass }: StatCardProps) {
  return (
    <div className="relative bg-[#1a1d27] border border-[#2a2f45] rounded-[10px] p-5 overflow-hidden shadow-[0_1px_4px_rgba(0,0,0,.4)] hover:border-[#363c57] transition-[border-color] duration-200">
      <span className="absolute top-4 right-[18px] text-[1.4rem] opacity-[0.18] leading-none select-none">
        {icon}
      </span>
      <p className="text-[0.72rem] font-bold text-[#718096] uppercase tracking-[0.7px] mb-2.5">
        {label}
      </p>
      <p className={cn('text-[2rem] font-extrabold tabular-nums leading-none', valueClass ?? 'text-[#e2e8f0]')}>
        {value}
      </p>
    </div>
  );
}

interface RatesStatsGridProps {
  margins: MarginsData;
}

export function RatesStatsGrid({ margins }: RatesStatsGridProps) {
  const avgPct = margins.avg_margin_pct;
  const negCount = margins.negative_margins?.length ?? margins.negative_margin_count ?? 0;
  const lowCount = margins.low_margins?.length ?? 0;

  const avgClass =
    avgPct > 30 ? 'text-green-400' : avgPct >= 15 ? 'text-amber-400' : 'text-red-400';

  return (
    <div className="space-y-4 mb-6">
      {/* Warning banner */}
      {negCount > 0 && (
        <div className="flex items-center gap-3 px-4 py-3 bg-red-500/[0.08] border border-red-500/25 rounded-lg text-red-400 text-sm font-semibold">
          <span className="text-base">⚠</span>
          WARNING: {negCount} rate{negCount === 1 ? '' : 's'} have negative margins — you are
          losing money on these destinations.
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total Rates" value={margins.total_rates} icon="$" />
        <StatCard
          label="Avg Margin %"
          value={`${avgPct.toFixed(1)}%`}
          icon="%"
          valueClass={avgClass}
        />
        <StatCard
          label="Negative Margins"
          value={negCount}
          icon="!"
          valueClass={negCount > 0 ? 'text-red-400' : 'text-[#e2e8f0]'}
        />
        <StatCard
          label="Low Margins"
          value={lowCount}
          icon="~"
          valueClass={lowCount > 0 ? 'text-amber-400' : 'text-[#e2e8f0]'}
        />
      </div>
    </div>
  );
}
