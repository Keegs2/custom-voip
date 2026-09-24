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
 * ROW-MODEL HONESTY (staff only — CDR A/B leg split): staff get a one-line
 * note under the strip saying what a "row" is. Rows=Calls → figures are per
 * call; Rows=All legs / Carrier legs → every carrier bridge attempt is its
 * own row, so counts / ASR / averages are NOT call counts. Tenants are always
 * one row per call (API-enforced) and see no note — their strip is unchanged.
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
import { fmtAvgCallDuration } from '../../utils/callDuration';
import { ROWS_MODE_NOTE } from './callsFilters';
import type { Cdr, CdrRowsMode } from '../../types/cdr';

/** Unit for the "of N matching …" hint (staff only). */
const ROWS_UNIT: Record<CdrRowsMode, string> = {
  calls: 'calls',
  all: 'rows',
  b: 'legs',
};

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
  /** Committed row model (staff) — drives the per-call vs per-leg note. */
  rowsMode?: CdrRowsMode;
}

export function CallsKpiStrip({ cdrs, total, isStaff, rowsMode = 'calls' }: CallsKpiStripProps) {
  const stats = useMemo(() => {
    const loaded = cdrs.length;
    let answered = 0;
    const answeredRows: Cdr[] = [];
    let mosSum = 0; let mosCount = 0;
    let plSum = 0; let plCount = 0;
    let jSum = 0; let jCount = 0;
    let rSum = 0; let rCount = 0;

    for (const c of cdrs) {
      // Avg Duration is over ANSWERED calls only — unanswered rows carry
      // ring time, which would drag a talk-time average toward zero.
      if (c.answer_time != null) {
        answered++;
        answeredRows.push(c);
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
      // Staff rows: exact seconds. Tenant rows: mean of whole minutes,
      // 1 decimal ("2.3 min") — the API never sends tenants seconds.
      avgDurLabel: fmtAvgCallDuration(answeredRows, fmtDurationShort),
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

  const matchingHint =
    total == null
      ? undefined
      : isStaff
        ? `of ${total.toLocaleString()} matching ${ROWS_UNIT[rowsMode]}`
        : `of ${total.toLocaleString()} matching`;

  const strip = (
    <section className="dlx4-statgrid" aria-label="Call aggregates for the current page">
      <StatCell
        label="This Page"
        value={stats.loaded.toLocaleString()}
        hint={matchingHint}
      />
      <StatCell label="Answered" value={stats.answered.toLocaleString()} />
      <StatCell label="ASR" value={`${stats.asr.toFixed(1)}%`} tone={asrTone} />
      <StatCell
        label="Avg Duration"
        value={stats.avgDurLabel}
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
          label={rowsMode === 'calls' ? 'Avg Cost / Call' : 'Avg Cost / Row'}
          value={stats.avgCost != null ? fmtMoneySmart(stats.avgCost) : '—'}
          hint={hasRated ? `${stats.ratedCount.toLocaleString()} rated` : undefined}
        />
      )}
    </section>
  );

  // Tenants: the strip alone, exactly as before.
  if (!isStaff) return strip;

  return (
    <>
      {strip}
      <p
        className="dlx4-statcell-hint"
        role="note"
        style={{
          margin: '-4px 2px 0',
          whiteSpace: 'normal',
          color: rowsMode === 'calls' ? undefined : 'var(--rcf-ink-soft)',
        }}
      >
        {ROWS_MODE_NOTE[rowsMode]}
      </p>
    </>
  );
}
