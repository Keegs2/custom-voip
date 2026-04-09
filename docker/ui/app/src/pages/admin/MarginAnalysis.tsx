import { Card, CardTitle } from '../../components/ui/Card';
import { cn } from '../../utils/cn';
import type { MarginsData, MarginRateEntry } from '../../types/rate';

interface MarginRowProps {
  entry: MarginRateEntry;
  colorClass: string;
}

function MarginRow({ entry, colorClass }: MarginRowProps) {
  const pct = entry.margin_pct != null ? Number(entry.margin_pct) : null;
  const pctText = pct != null ? `${pct.toFixed(1)}%` : '--';

  return (
    <div className="flex items-center justify-between py-2 border-b border-[#2a2f45]/50 last:border-0 gap-4">
      <span className="font-mono text-[0.82rem] font-semibold text-[#e2e8f0] shrink-0">
        {entry.prefix}
      </span>
      <span className="text-[0.78rem] text-[#718096] flex-1 truncate">
        {entry.description || ''}
      </span>
      <span className={cn('tabular-nums text-[0.82rem] font-bold shrink-0', colorClass)}>
        {pctText}
      </span>
    </div>
  );
}

interface MarginAnalysisProps {
  margins: MarginsData;
}

export function MarginAnalysis({ margins }: MarginAnalysisProps) {
  const negative: MarginRateEntry[] = margins.negative_margins ?? [];
  const low: MarginRateEntry[] = margins.low_margins ?? [];
  const best: MarginRateEntry[] = margins.best_margins ?? [];

  const problematic = [...negative, ...low];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      {/* Low / Negative margins card */}
      <Card>
        <CardTitle>Low / Negative Margins</CardTitle>
        {problematic.length === 0 ? (
          <p className="text-[#718096] text-sm">All margins are healthy</p>
        ) : (
          <div>
            {problematic.map((entry) => {
              const pct = entry.margin_pct != null ? Number(entry.margin_pct) : null;
              const colorClass =
                pct != null && pct < 0 ? 'text-red-400' : 'text-amber-400';
              return (
                <MarginRow
                  key={entry.prefix}
                  entry={entry}
                  colorClass={colorClass}
                />
              );
            })}
          </div>
        )}
      </Card>

      {/* Best margins card */}
      <Card>
        <CardTitle>Best Margins</CardTitle>
        {best.length === 0 ? (
          <p className="text-[#718096] text-sm">No data available</p>
        ) : (
          <div>
            {best.map((entry) => (
              <MarginRow key={entry.prefix} entry={entry} colorClass="text-green-400" />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
