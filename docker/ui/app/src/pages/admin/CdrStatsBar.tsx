/**
 * CdrStatsBar — aggregate stats for the CURRENT PAGE of CDR results.
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
 * SCOPE HONESTY: with real pagination, `cdrs` is exactly one page — so
 * every aggregate here is deliberately PAGE-SCOPED and the strip says so
 * (lead cell "This Page", with the full match count as its hint when the
 * API reports one; the pagination bar carries "Showing X–Y of Z"). Do NOT
 * try to fake platform-wide stats client-side from one page of rows —
 * whole-result-set aggregation is the Summary tab's job (/cdrs/summary
 * aggregates server-side over the same committed filter set).
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
  /** The rows on the CURRENT page — every aggregate below is page-scoped. */
  cdrs: Cdr[];
  /** Full match count across all pages — absent until the API ships `total`. */
  total?: number;
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

  return (
    <section className="dlx4-statgrid" aria-label="CDR aggregates for the current page">
      {/* Lead cell anchors the strip's scope: everything here summarizes
          THIS page. The full match count rides along as the hint (the
          pagination bar owns "Showing X–Y of Z" as the primary readout). */}
      <StatCell
        label="This Page"
        value={stats.loaded.toLocaleString()}
        hint={total != null ? `of ${total.toLocaleString()} matching` : undefined}
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
