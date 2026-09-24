/**
 * CallsKpiStrip — the union KPI strip for the merged Calls & Quality page:
 * the CDR Search aggregates (calls / answered / ASR / duration / money) plus
 * the call-quality SHARES (graded calls / good-or-better % / poor / one-way
 * audio / median call MOS), in one bordered daylight slab (`dlx4-statgrid` —
 * hairline seams, auto-fit reflow).
 *
 * QUALITY HONESTY (docs/CALL_QUALITY_ACCURACY_PLAN.md §E.4): no averages of
 * MOS / loss / jitter / R. Everything reads the CALL grade
 * (`call_quality_grade` / `call_quality_status` / `call_mos` — the worse of
 * the two audio directions) through quality.ts::summarizeCallQuality, and only
 * graded calls count. One-way audio is counted as graded + poor, never as a
 * score. Carrier B rows carry no call grade, so in the staff All-legs /
 * Carrier-legs views they simply don't count toward the quality cells.
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
  goodShareColor, mosColor, summarizeCallQuality, fmtDurationShort,
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

    for (const c of cdrs) {
      // Avg Duration is over ANSWERED calls only — unanswered rows carry
      // ring time, which would drag a talk-time average toward zero.
      if (c.answer_time != null) {
        answered++;
        answeredRows.push(c);
      }
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
      quality: summarizeCallQuality(cdrs),
      ratedCount,
      totalCost,
      avgCost: ratedCount > 0 ? totalCost / ratedCount : null,
    };
  }, [cdrs]);

  const hasRated = stats.ratedCount > 0;
  const q = stats.quality;
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
        label="Graded Calls"
        value={q.graded.toLocaleString()}
        hint="answered ≥ 5 s, audio measured"
      />
      <StatCell
        label="Good or Better"
        value={q.goodSharePct != null ? `${q.goodSharePct.toFixed(1)}%` : '—'}
        tone={q.goodSharePct != null ? goodShareColor(q.goodSharePct) : undefined}
        hint={q.graded > 0 ? `${q.goodOrBetter.toLocaleString()} of ${q.graded.toLocaleString()} graded` : 'no graded calls'}
      />
      <StatCell
        label="Poor Calls"
        value={q.graded > 0 ? q.poor.toLocaleString() : '—'}
        tone={q.poor > 0 ? BAD : q.graded > 0 ? GOOD : undefined}
        hint="incl. one-way audio"
      />
      <StatCell
        label="One-way Audio"
        value={q.graded > 0 ? q.oneWay.toLocaleString() : '—'}
        tone={q.oneWay > 0 ? BAD : undefined}
        hint="no sound from one side"
      />
      <StatCell
        label="Median Call MOS"
        value={q.medianMos != null ? q.medianMos.toFixed(2) : '—'}
        tone={q.medianMos != null ? mosColor(q.medianMos) : undefined}
        hint="worse direction · G.711 max 4.41"
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
