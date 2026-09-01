/**
 * CallsKpiStrip — the union KPI strip for the merged Calls & Quality page:
 * the CDR Search aggregates (calls / answered / ASR / duration / money) plus
 * the Call Quality averages (MOS / loss / jitter / R-factor), in one bordered
 * daylight slab (`dlx4-statgrid` — hairline seams, auto-fit reflow).
 *
 * SCOPE HONESTY: with real server pagination, `cdrs` is exactly one page —
 * every aggregate here is deliberately PAGE-SCOPED and the lead cell says so
 * ("This Page", with the full match count as its hint). Whole-result-set
 * aggregation is the Summary tab's job (/cdrs/summary aggregates server-side
 * over the same committed filter set); the trend charts aggregate their own
 * up-to-1000-row fetch.
 *
 * Money cells (Total Cost / Avg Cost per call) render for STAFF only —
 * tenants never see cost anywhere. Em dash when nothing in the set is rated
 * (no fake "$0.0000"); color only on meaningful nonzero values.
 */
import { useMemo } from 'react';
import { fmtMoneySmart } from '../../utils/format';
import {
  GOOD, WARN, BAD, AZURE_DEEP,
  mosColor, packetLossColor, jitterColor, rFactorColor, fmtDurationShort,
} from './quality';
import type { Cdr } from '../../types/cdr';

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

interface CallsKpiStripProps {
  /** The rows on the CURRENT page — every aggregate below is page-scoped. */
  cdrs: Cdr[];
  /** Full match count across all pages — absent on legacy API responses. */
  total?: number;
  /** Admin or support — money KPIs render only for staff. */
  isStaff: boolean;
}

export function CallsKpiStrip({ cdrs, total, isStaff }: CallsKpiStripProps) {
  const stats = useMemo(() => {
    const loaded = cdrs.length;
    let answered = 0;
    let durSum = 0;
    let mosSum = 0; let mosCount = 0;
    let plSum = 0; let plCount = 0;
    let jSum = 0; let jCount = 0;
    let rSum = 0; let rCount = 0;

    for (const c of cdrs) {
      // Avg Duration is over ANSWERED calls only — unanswered rows carry
      // ring time, which would drag a talk-time average toward zero.
      if (c.answer_time != null) {
        answered++;
        durSum += c.duration_seconds ?? 0;
      }
      if (c.mos != null) { mosSum += c.mos; mosCount++; }
      if (c.packet_loss_pct != null) { plSum += c.packet_loss_pct; plCount++; }
      if (c.jitter_avg_ms != null) { jSum += c.jitter_avg_ms; jCount++; }
      if (c.r_factor != null) { rSum += c.r_factor; rCount++; }
    }

    // Money aggregates only mean something when at least one loaded CDR is
    // rated — otherwise every figure is an artifact of missing data.
    const ratedCount = cdrs.filter((c) => c.total_cost != null).length;
    const totalCost = cdrs.reduce((sum, c) => sum + (c.total_cost ?? 0), 0);

    return {
      loaded,
      answered,
      asr: loaded > 0 ? (answered / loaded) * 100 : 0,
      avgDurSec: answered > 0 ? durSum / answered : null,
      avgMos: mosCount > 0 ? mosSum / mosCount : null,
      avgLossPct: plCount > 0 ? plSum / plCount : null,
      avgJitterMs: jCount > 0 ? jSum / jCount : null,
      avgRFactor: rCount > 0 ? rSum / rCount : null,
      ratedCount,
      totalCost,
      avgCost: ratedCount > 0 ? totalCost / ratedCount : null,
    };
  }, [cdrs]);

  const hasRated = stats.ratedCount > 0;
  const asrTone = stats.asr > 50 ? GOOD : stats.asr >= 30 ? WARN : BAD;

  return (
    <section className="dlx4-statgrid" aria-label="Call aggregates for the current page">
      <StatCell
        label="This Page"
        value={stats.loaded.toLocaleString()}
        hint={total != null ? `of ${total.toLocaleString()} matching` : undefined}
      />
      <StatCell label="Answered" value={stats.answered.toLocaleString()} />
      <StatCell label="ASR" value={`${stats.asr.toFixed(1)}%`} tone={asrTone} />
      <StatCell
        label="Avg Duration"
        value={stats.avgDurSec != null ? fmtDurationShort(stats.avgDurSec) : '—'}
        hint="answered calls"
      />
      <StatCell
        label="Avg MOS"
        value={stats.avgMos != null ? stats.avgMos.toFixed(2) : '—'}
        tone={stats.avgMos != null ? mosColor(stats.avgMos) : undefined}
      />
      <StatCell
        label="Avg Loss"
        value={stats.avgLossPct != null ? `${stats.avgLossPct.toFixed(2)}%` : '—'}
        tone={stats.avgLossPct != null ? packetLossColor(stats.avgLossPct) : undefined}
      />
      <StatCell
        label="Avg Jitter"
        value={stats.avgJitterMs != null ? `${stats.avgJitterMs.toFixed(1)}ms` : '—'}
        tone={stats.avgJitterMs != null ? jitterColor(stats.avgJitterMs) : undefined}
        hint="RMS estimate"
      />
      <StatCell
        label="Avg R-Factor"
        value={stats.avgRFactor != null ? stats.avgRFactor.toFixed(1) : '—'}
        tone={stats.avgRFactor != null ? rFactorColor(stats.avgRFactor) : undefined}
      />
      {isStaff && (
        <StatCell
          label="Total Cost"
          value={hasRated ? fmtMoneySmart(stats.totalCost) : '—'}
          tone={hasRated && stats.totalCost > 0 ? AZURE_DEEP : undefined}
          hint={!hasRated ? 'no rated records' : undefined}
        />
      )}
      {isStaff && (
        <StatCell
          label="Avg Cost / Call"
          value={stats.avgCost != null ? fmtMoneySmart(stats.avgCost) : '—'}
          hint={hasRated ? `${stats.ratedCount.toLocaleString()} rated` : undefined}
        />
      )}
    </section>
  );
}
