/**
 * CdrStatsBar — aggregate stats for the current CDR result set.
 *
 * Styling: the shared DAYLIGHT CONSOLE system — one bordered slab divided
 * into equal-height cells by hairline seams (`dlx4-statgrid` in
 * styles/dl-platform-b.css, a CSS grid with auto-fit/minmax so the row
 * degrades gracefully at laptop widths — no orphan wrap, no colored
 * keyline bars). Avg margin % folds into the Margin cell as a hint line.
 *
 * Money semantics: em dash when nothing in the set is rated (no fake
 * "$0.0000"), and color only on meaningful nonzero values.
 *
 * Except for Total Calls (server-side total), aggregates are computed
 * client-side over the LOADED rows — the "N loaded" hint says so when the
 * set is partial.
 */
import { useMemo } from 'react';
import { fmtMoneySmart } from '../../utils/format';
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
  const s = Math.floor(totalSeconds % 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

interface StatCellProps {
  label: string;
  value: string;
  /** Semantic tone for the numeral — omit for neutral ink. */
  tone?: string;
  /** Small context line under the label. */
  hint?: string;
}

function StatCell({ label, value, tone, hint }: StatCellProps) {
  return (
    <div className="dlx4-statcell">
      <div className="dlx4-statcell-value" style={tone ? { color: tone } : undefined}>
        {value}
      </div>
      <div className="dlx4-statcell-label">{label}</div>
      {hint && <div className="dlx4-statcell-hint">{hint}</div>}
    </div>
  );
}

interface CdrStatsBarProps {
  cdrs: Cdr[];
  total: number;
}

export function CdrStatsBar({ cdrs, total }: CdrStatsBarProps) {
  const stats = useMemo(() => {
    const loaded = cdrs.length;
    const answered = cdrs.filter((c) => c.answer_time != null).length;
    const asr = loaded > 0 ? (answered / loaded) * 100 : 0;
    const totalDurSec = cdrs.reduce((sum, c) => sum + (c.duration_seconds ?? 0), 0);

    // Money aggregates only mean something when at least one loaded CDR is
    // rated — otherwise every figure is an artifact of missing data.
    const ratedCount = cdrs.filter((c) => c.total_cost != null || c.carrier_cost != null).length;
    const totalBilled = cdrs.reduce((sum, c) => sum + (c.total_cost ?? 0), 0);
    const totalCost = cdrs.reduce((sum, c) => sum + (c.carrier_cost ?? 0), 0);
    const totalMargin = totalBilled - totalCost;
    const avgMarginPct = totalBilled > 0 ? (totalMargin / totalBilled) * 100 : null;

    return { loaded, answered, asr, totalDurSec, ratedCount, totalBilled, totalCost, totalMargin, avgMarginPct };
  }, [cdrs]);

  const hasRated = stats.ratedCount > 0;
  const asrTone = stats.asr > 50 ? GOOD : stats.asr >= 30 ? WARN : BAD;
  const marginTone = !hasRated || stats.totalMargin === 0
    ? undefined
    : stats.totalMargin > 0 ? GOOD : BAD;

  const partial = stats.loaded < total;

  return (
    <section className="dlx4-statgrid" aria-label="CDR result aggregates">
      <StatCell
        label="Total Calls"
        value={total.toLocaleString()}
        hint={partial ? `${stats.loaded.toLocaleString()} loaded` : undefined}
      />
      <StatCell label="Answered" value={stats.answered.toLocaleString()} />
      <StatCell label="ASR" value={`${stats.asr.toFixed(1)}%`} tone={asrTone} />
      <StatCell label="Duration" value={formatTotalDuration(stats.totalDurSec)} />
      <StatCell
        label="Total Billed"
        value={hasRated ? fmtMoneySmart(stats.totalBilled) : '—'}
        tone={hasRated && stats.totalBilled > 0 ? AZURE_DEEP : undefined}
        hint={!hasRated ? 'no rated records' : undefined}
      />
      <StatCell
        label="Carrier Cost"
        value={hasRated ? fmtMoneySmart(stats.totalCost) : '—'}
      />
      <StatCell
        label="Margin"
        value={hasRated ? fmtMoneySmart(stats.totalMargin) : '—'}
        tone={marginTone}
        hint={
          hasRated && stats.avgMarginPct != null
            ? `${stats.avgMarginPct.toFixed(1)}% avg`
            : undefined
        }
      />
    </section>
  );
}
