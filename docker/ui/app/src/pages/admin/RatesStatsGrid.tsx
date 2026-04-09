import { cn } from '../../utils/cn';
import type { MarginsData } from '../../types/rate';

interface LocalStatCardProps {
  label: string;
  value: React.ReactNode;
  icon: string;
  valueClass?: string;
}

function LocalStatCard({ label, value, icon, valueClass }: LocalStatCardProps) {
  return (
    <div className="relative bg-[#1a1d27] border border-[#2a2f45] rounded-xl p-5 overflow-hidden shadow-[0_1px_3px_rgba(0,0,0,.4)] hover:border-[#363c57] transition-[border-color] duration-200">
      <span className="absolute top-4 right-4 text-2xl opacity-[0.15] leading-none select-none pointer-events-none">
        {icon}
      </span>
      <p className="text-[0.65rem] font-bold text-[#4a5568] uppercase tracking-[1px] mb-2">
        {label}
      </p>
      <p className={cn('text-[1.9rem] font-extrabold tabular-nums leading-none', valueClass ?? 'text-[#e2e8f0]')}>
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
    avgPct > 30 ? 'text-emerald-400' : avgPct >= 15 ? 'text-amber-400' : 'text-red-400';

  return (
    <div className="space-y-4 mb-6">
      {negCount > 0 && (
        <div className="flex items-center gap-3 px-4 py-3 bg-red-500/[0.07] border border-red-500/20 rounded-xl text-red-400 text-sm font-medium">
          <span className="text-base flex-shrink-0">⚠</span>
          <span>
            <strong className="font-bold">{negCount} rate{negCount === 1 ? '' : 's'}</strong>{' '}
            have negative margins — you are losing money on these destinations.
          </span>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <LocalStatCard label="Total Rates" value={margins.total_rates} icon="$" />
        <LocalStatCard
          label="Avg Margin %"
          value={`${avgPct.toFixed(1)}%`}
          icon="%"
          valueClass={avgClass}
        />
        <LocalStatCard
          label="Negative Margins"
          value={negCount}
          icon="!"
          valueClass={negCount > 0 ? 'text-red-400' : 'text-[#e2e8f0]'}
        />
        <LocalStatCard
          label="Low Margins"
          value={lowCount}
          icon="~"
          valueClass={lowCount > 0 ? 'text-amber-400' : 'text-[#e2e8f0]'}
        />
      </div>
    </div>
  );
}
