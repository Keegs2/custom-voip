/**
 * CallsKpiStrip — the Calls & Quality KPI row: ONE centered band of
 * equal-width tiles (8 for staff, 7 for tenants) that fits a single row at
 * ~1440px and wraps into full rows (no empty filler) below that.
 *
 *   Calls on page · ASR · Avg duration · Graded calls · Good or better ·
 *   Poor calls · Median call MOS · Cost (staff only)
 *
 * Consolidated from the old 11-cell strip without dropping a figure:
 * "This page" + its match total → the first tile; Answered → the ASR tile's
 * subline; One-way audio → the Poor tile's subline (one-way calls ARE graded
 * poor — the subline says "incl. N one-way"); Total cost + Avg cost/call →
 * one Cost tile.
 *
 * QUALITY HONESTY (docs/CALL_QUALITY_ACCURACY_PLAN.md §E.4): no averages of
 * MOS / loss / jitter / R. Everything reads the CALL grade
 * (`call_quality_grade` / `call_quality_status` / `call_mos` — the worse of
 * the two audio directions) through quality.ts::summarizeCallQuality, and only
 * graded calls count. One-way audio is counted as graded + poor, never as a
 * score. Carrier B rows carry no call grade, so in the staff All-legs /
 * Carrier-legs views they simply don't count toward the quality tiles.
 *
 * SCOPE HONESTY: with real server pagination, `cdrs` is exactly one page —
 * every aggregate here is deliberately PAGE-SCOPED and the first tile says
 * so ("… on page", with the full match count as its subline). Whole-result-
 * set aggregation is the Summary tab's job (/cdrs/summary, server-side).
 *
 * ROW-MODEL HONESTY (staff only — CDR A/B leg split): Rows=Calls → figures are
 * per call (stated in the strip's tooltip). Rows=All legs / Carrier legs →
 * every carrier bridge attempt is its own row, so counts / ASR / averages are
 * NOT call counts: the first tile relabels ("Rows" / "Legs") and a visible
 * caption under the strip says so. Tenants are always one row per call
 * (API-enforced) and see neither.
 *
 * Money (the Cost tile) renders for STAFF only — tenants never see cost
 * anywhere. Em dash when nothing in the set is rated (no fake "$0.0000");
 * color only on meaningful nonzero values.
 */
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { fmtMoneySmart } from '../../utils/format';
import {
  GOOD, WARN, BAD,
  goodShareColor, mosColor, summarizeCallQuality, fmtDurationShort,
} from './quality';
import { T } from '../../styles/theme';
import { fmtAvgCallDuration } from '../../utils/callDuration';
import { ROWS_MODE_NOTE } from './callsFilters';
import type { Cdr, CdrRowsMode } from '../../types/cdr';

/** First-tile label per row model (staff); tenants are always "Calls". */
const COUNT_LABEL: Record<CdrRowsMode, string> = {
  calls: 'Calls on page',
  all: 'Rows on page',
  b: 'Legs on page',
};

interface KpiTileProps {
  label: string;
  value: string;
  /** Semantic tone for the numeral — omit for neutral ink. */
  tone?: string;
  /** One- or two-line context under the value. */
  sub?: ReactNode;
  /** Longer explanation, shown on hover. */
  title?: string;
}

function KpiTile({ label, value, tone, sub, title }: KpiTileProps) {
  return (
    <div className="cqk-tile" title={title}>
      <div className="cqk-label">{label}</div>
      <div className="cqk-value" style={tone ? { color: tone } : undefined}>{value}</div>
      <div className="cqk-sub">{sub}</div>
    </div>
  );
}

interface CallsKpiStripProps {
  /** The rows on the CURRENT page — every aggregate below is page-scoped. */
  cdrs: Cdr[];
  /** Full match count across all pages — absent on legacy API responses. */
  total?: number;
  /** Admin or support — the Cost tile renders only for staff. */
  isStaff: boolean;
  /** Committed row model (staff) — drives the per-call vs per-leg wording. */
  rowsMode?: CdrRowsMode;
}

export function CallsKpiStrip({ cdrs, total, isStaff, rowsMode = 'calls' }: CallsKpiStripProps) {
  const stats = useMemo(() => {
    const loaded = cdrs.length;
    const answeredRows: Cdr[] = [];

    for (const c of cdrs) {
      // Avg Duration is over ANSWERED calls only — unanswered rows carry
      // ring time, which would drag a talk-time average toward zero.
      if (c.answer_time != null) answeredRows.push(c);
    }
    const answered = answeredRows.length;

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
  const mode: CdrRowsMode = isStaff ? rowsMode : 'calls';
  const perUnit = mode === 'calls' ? 'call' : 'row';

  const poorSub: ReactNode =
    q.graded === 0
      ? 'no graded calls'
      : q.oneWay > 0
        ? <>incl. <span style={{ color: BAD, fontWeight: 600 }}>{q.oneWay.toLocaleString()} one-way</span> audio</>
        : 'no one-way audio';

  return (
    <div className="cqk">
      <section
        className="cqk-strip"
        aria-label="Call aggregates for the current page"
        title={isStaff && mode === 'calls' ? ROWS_MODE_NOTE.calls : undefined}
      >
        <KpiTile
          label={COUNT_LABEL[mode]}
          value={stats.loaded.toLocaleString()}
          sub={total != null ? `of ${total.toLocaleString()} matching` : 'this page only'}
          title="Every figure in this strip covers the rows on the current page."
        />
        <KpiTile
          label="ASR"
          value={`${stats.asr.toFixed(1)}%`}
          tone={asrTone}
          sub={`${stats.answered.toLocaleString()} answered`}
          title="Answer-seizure ratio — answered ÷ attempted on this page."
        />
        <KpiTile
          label="Avg duration"
          value={stats.avgDurLabel}
          sub="answered calls"
        />
        <KpiTile
          label="Graded calls"
          value={q.graded.toLocaleString()}
          sub="answered ≥ 5 s with audio"
          title="Calls answered for at least 5 seconds whose audio was measured."
        />
        <KpiTile
          label="Good or better"
          value={q.goodSharePct != null ? `${q.goodSharePct.toFixed(1)}%` : '—'}
          tone={q.goodSharePct != null ? goodShareColor(q.goodSharePct) : undefined}
          sub={q.graded > 0 ? `${q.goodOrBetter.toLocaleString()} of ${q.graded.toLocaleString()} graded` : 'no graded calls'}
        />
        <KpiTile
          label="Poor calls"
          value={q.graded > 0 ? q.poor.toLocaleString() : '—'}
          tone={q.poor > 0 ? BAD : q.graded > 0 ? GOOD : undefined}
          sub={poorSub}
          title="Poor-grade calls, including one-way audio (no sound from one side)."
        />
        <KpiTile
          label="Median call MOS"
          value={q.medianMos != null ? q.medianMos.toFixed(2) : '—'}
          tone={q.medianMos != null ? mosColor(q.medianMos) : undefined}
          sub="worse direction"
          title="Median over rated calls, using each call's worse audio direction. Clean G.711 tops out at 4.41."
        />
        {isStaff && (
          <KpiTile
            label="Cost"
            value={hasRated ? fmtMoneySmart(stats.totalCost) : '—'}
            tone={hasRated && stats.totalCost > 0 ? T.accentText : undefined}
            sub={
              hasRated && stats.avgCost != null
                ? `avg ${fmtMoneySmart(stats.avgCost)}/${perUnit} · ${stats.ratedCount.toLocaleString()} rated`
                : 'no rated records'
            }
            title={`Total cost of rated records on this page, and the average per rated ${perUnit}.`}
          />
        )}
      </section>

      {/* Per-leg row models change what every count means — say so visibly. */}
      {isStaff && mode !== 'calls' && (
        <p className="cqk-note" role="note">{ROWS_MODE_NOTE[mode]}</p>
      )}
    </div>
  );
}
