/**
 * QualityTrendsSection — four daily QualityTrendChart series (bridged gap
 * lines) inside a collapsible panel on the merged Calls & Quality page:
 *
 *   1. Good or better %  — share of GRADED calls whose call grade is great/good
 *   2. Median call MOS   — p50 of `call_mos` over rated calls
 *   3. Caller→platform loss p95 — p95 `packet_loss_pct` of rated A rows
 *   4. Jitter p95        — p95 RFC 3550 `jitter_avg_ms` of rated A rows
 *
 * No averages of MOS/loss/jitter (docs/CALL_QUALITY_ACCURACY_PLAN.md §E.4):
 * shares and percentiles only, and ONLY graded/rated rows are sampled — the
 * tooltip's "N of M calls" is graded-of-total. Jitter is empty until the
 * FreeSWITCH images carry the quality patch (legacy rows have NULL jitter).
 *
 * Data model: the charts need the WHOLE window, not one table page, so this
 * section runs its own up-to-1000-row fetch over the SAME committed filter
 * set (identical params object + nonce → provably the same search). The
 * query only runs while the section is expanded (react-query `enabled`), so
 * a collapsed section costs nothing. Collapse state persists in
 * localStorage; default expanded.
 *
 * Row model: quality is a ONE-ROW-PER-CALL surface (CDR leg-split contract),
 * so the staff "Rows" choice (`leg`) is stripped here — the charts always
 * sample call rows, never carrier B-legs, whatever the table shows.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { searchCdrs } from '../../api/cdrs';
import { Spinner } from '../../components/ui/Spinner';
import { QualityTrendChart } from '../../components/charts/QualityTrendChart';
import type { TrendDomain, TrendPoint } from '../../components/charts/QualityTrendChart';
import type { Cdr, CdrSearchParams } from '../../types/cdr';
import { percentileCont, summarizeCallQuality } from './quality';
import '../../styles/dl-call-quality.css'; // dlx-chart-grid

/** The API caps `limit` at 1000 — one window-wide sample request max. */
const TREND_SAMPLE_LIMIT = 1000;

const LS_KEY = 'calls_trends_open';

function loadOpen(): boolean {
  try {
    return localStorage.getItem(LS_KEY) !== 'closed'; // default expanded
  } catch {
    return true;
  }
}

function saveOpen(open: boolean): void {
  try {
    localStorage.setItem(LS_KEY, open ? 'open' : 'closed');
  } catch {
    // ignore quota errors
  }
}

// ---------------------------------------------------------------------------
// Chart configuration — y-domains + formatters. MOS renders on its fixed 1–5
// scale; packet loss and jitter auto-scale (padded to the data). Module-scope
// constants so the chart's geometry memo keeps stable inputs.
// ---------------------------------------------------------------------------

const SHARE_DOMAIN: TrendDomain = { min: 0, max: 100 };
// MOS never exceeds 4.5 (G.107 Annex B); a clean G.711 call is 4.41.
const MOS_DOMAIN: TrendDomain = { min: 1, max: 4.5 };
const LOSS_DOMAIN: TrendDomain = { min: 0, max: 'auto' };
const JITTER_DOMAIN: TrendDomain = { min: 0, max: 'auto' };

const CHART_GREEN = '#16a34a';
const CHART_ROSE = '#be123c';
const CHART_AZURE = '#1d63dd';
const CHART_TEAL = '#0f766e';

const fmtShareValue = (v: number): string => `${v.toFixed(1)}%`;
const fmtShareTick = (v: number): string => `${Math.round(v)}%`;
const fmtMosValue = (v: number): string => v.toFixed(2);
const fmtMosTick = (v: number): string => v.toFixed(1);
const fmtLossValue = (v: number): string => `${v.toFixed(2)}%`;
const fmtLossTick = (v: number): string => `${parseFloat(v.toFixed(3))}%`;
const fmtJitterValue = (v: number): string => `${v.toFixed(1)} ms`;
const fmtJitterTick = (v: number): string => `${parseFloat(v.toFixed(1))}`;

// ---------------------------------------------------------------------------
// Daily quality buckets — one slot for EVERY day of the committed range
// (continuous axis; days without data stay null and render as honest gaps),
// plus per-day sample counts so the tooltips show how many graded calls each
// share / percentile summarizes.
// ---------------------------------------------------------------------------

interface DailyQuality {
  date: string;
  totalCalls: number;
  /** Graded calls (call_quality_grade set, incl. one-way). */
  graded: number;
  goodSharePct: number | null;
  medianMos: number | null;
  mosCount: number;
  lossP95: number | null;
  lossCount: number;
  jitterP95: number | null;
  jitterCount: number;
}

interface DayBucket {
  rows: Cdr[];
  loss: number[];
  jitter: number[];
  mosCount: number;
}

function buildDailyQuality(cdrs: Cdr[], startDate: Date, endDate: Date): DailyQuality[] {
  const byDate = new Map<string, DayBucket>();

  for (const cdr of cdrs) {
    const key = cdr.start_time.slice(0, 10);
    const bucket = byDate.get(key) ?? { rows: [], loss: [], jitter: [], mosCount: 0 };
    bucket.rows.push(cdr);
    if (cdr.call_quality_status === 'rated' && cdr.call_mos != null) bucket.mosCount++;
    // Leg-level (caller→platform) diagnostics: rated A rows only.
    if (cdr.quality_status === 'rated') {
      if (cdr.packet_loss_pct != null) bucket.loss.push(cdr.packet_loss_pct);
      if (cdr.jitter_avg_ms != null) bucket.jitter.push(cdr.jitter_avg_ms);
    }
    byDate.set(key, bucket);
  }

  const slots: DailyQuality[] = [];
  const msPerDay = 86400000;
  const dayCount = Math.round((endDate.getTime() - startDate.getTime()) / msPerDay);

  // Cover the FULL committed range; 365 is a defensive ceiling against
  // absurd custom ranges.
  for (let i = 0; i <= Math.min(dayCount, 365); i++) {
    const key = new Date(startDate.getTime() + i * msPerDay).toISOString().slice(0, 10);
    const b = byDate.get(key);
    const q = b ? summarizeCallQuality(b.rows) : null;
    slots.push({
      date: key,
      totalCalls: b?.rows.length ?? 0,
      graded: q?.graded ?? 0,
      goodSharePct: q?.goodSharePct ?? null,
      medianMos: q?.medianMos ?? null,
      mosCount: b?.mosCount ?? 0,
      lossP95: b ? percentileCont(b.loss, 0.95) : null,
      lossCount: b?.loss.length ?? 0,
      jitterP95: b ? percentileCont(b.jitter, 0.95) : null,
      jitterCount: b?.jitter.length ?? 0,
    });
  }
  return slots;
}

interface QualityTrendsSectionProps {
  /** The committed search params — identical object the Records query uses. */
  params: CdrSearchParams;
  /** Search nonce — bumps per Search click so identical params still re-fetch. */
  nonce: number;
}

export function QualityTrendsSection({ params, nonce }: QualityTrendsSectionProps) {
  // ALL hooks unconditionally at the top — React #310 prevention.
  const [open, setOpen] = useState<boolean>(loadOpen);

  // Same committed filter set minus the row model (see header).
  const callParams = useMemo<CdrSearchParams>(() => {
    const p: CdrSearchParams = { ...params };
    delete p.leg;
    return p;
  }, [params]);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['calls-trends', callParams, nonce],
    queryFn: () => searchCdrs({ ...callParams, limit: TREND_SAMPLE_LIMIT, offset: 0 }),
    // Collapsed section = no fetch. Expanding triggers it (and react-query
    // caches per committed search, so re-collapsing/expanding is free).
    enabled: open,
    staleTime: 60_000,
  });

  const cdrs = useMemo(() => data?.items ?? [], [data]);

  // The committed params ALWAYS carry a concrete window (filtersToParams
  // guarantees start_date/end_date), so the axis is the frozen search range.
  // The epoch fallbacks are unreachable type-narrowing only — never "now"
  // (calling Date.now()/new Date() during render is impure).
  const startDate = useMemo(
    () => new Date(params.start_date ?? 0),
    [params.start_date],
  );
  const endDate = useMemo(
    () => new Date(params.end_date ?? 0),
    [params.end_date],
  );

  const dailyQuality = useMemo(
    () => buildDailyQuality(cdrs, startDate, endDate),
    [cdrs, startDate, endDate],
  );

  // One TrendPoint series per metric — value + per-day graded sample size for
  // the chart tooltips ("N of M calls").
  const trendPoints = useMemo(() => ({
    share: dailyQuality.map((d): TrendPoint => ({ date: d.date, value: d.goodSharePct, sampleCount: d.graded, totalCalls: d.totalCalls })),
    mos: dailyQuality.map((d): TrendPoint => ({ date: d.date, value: d.medianMos, sampleCount: d.mosCount, totalCalls: d.totalCalls })),
    loss: dailyQuality.map((d): TrendPoint => ({ date: d.date, value: d.lossP95, sampleCount: d.lossCount, totalCalls: d.totalCalls })),
    jitter: dailyQuality.map((d): TrendPoint => ({ date: d.date, value: d.jitterP95, sampleCount: d.jitterCount, totalCalls: d.totalCalls })),
  }), [dailyQuality]);

  const sampled = data?.items.length ?? 0;
  const truncated = data?.total != null && data.total > sampled;

  function toggle() {
    setOpen((prev) => {
      const next = !prev;
      saveOpen(next);
      return next;
    });
  }

  return (
    <section className="dl-panel">
      <button
        type="button"
        className="dl-panel-head"
        onClick={toggle}
        aria-expanded={open}
        style={{
          width: '100%',
          background: 'none',
          border: 'none',
          borderBottom: open ? undefined : 'none',
          cursor: 'pointer',
          textAlign: 'left',
          font: 'inherit',
        }}
      >
        <span className="dl-panel-title">Quality Trends</span>
        {open && truncated && (
          <span className="dl-count" style={{ marginLeft: 12 }}>
            sampled {sampled.toLocaleString()} of {data!.total!.toLocaleString()} matching
          </span>
        )}
        <span
          aria-hidden="true"
          style={{
            marginLeft: 'auto',
            fontSize: '0.72rem',
            color: 'var(--rcf-ink-dim)',
            transition: 'transform 0.2s ease',
            transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
          }}
        >
          ▾
        </span>
      </button>

      {open && (
        <>
          {isLoading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--rcf-ink-dim)', fontSize: '0.82rem', padding: 20 }}>
              <Spinner size="xs" /> Building charts…
            </div>
          )}

          {isError && (
            <div style={{ padding: 20 }}>
              <div className="dl-banner dl-banner-err">Failed to load trend data.</div>
            </div>
          )}

          {!isLoading && !isError && cdrs.length === 0 && (
            <div style={{ padding: 20 }}>
              <div className="dl-empty">
                No CDR data for the selected filters. Adjust the criteria and search again.
              </div>
            </div>
          )}

          {!isLoading && !isError && cdrs.length > 0 && (
            <div className="dl-panel-body">
              <div className="dlx-chart-grid">
                <QualityTrendChart
                  points={trendPoints.share}
                  accent={CHART_TEAL}
                  title="Good or better — % of graded calls"
                  domain={SHARE_DOMAIN}
                  formatValue={fmtShareValue}
                  formatTick={fmtShareTick}
                />
                <QualityTrendChart
                  points={trendPoints.mos}
                  accent={CHART_GREEN}
                  title="Median call MOS"
                  domain={MOS_DOMAIN}
                  formatValue={fmtMosValue}
                  formatTick={fmtMosTick}
                />
                <QualityTrendChart
                  points={trendPoints.loss}
                  accent={CHART_ROSE}
                  title="Caller→platform loss p95"
                  domain={LOSS_DOMAIN}
                  formatValue={fmtLossValue}
                  formatTick={fmtLossTick}
                />
                <QualityTrendChart
                  points={trendPoints.jitter}
                  accent={CHART_AZURE}
                  title="Jitter p95 (RFC 3550, ms)"
                  domain={JITTER_DOMAIN}
                  formatValue={fmtJitterValue}
                  formatTick={fmtJitterTick}
                />
              </div>
            </div>
          )}

          {!isLoading && !isError && cdrs.length > 0 && (
            <div className="dl-panel-body">
              <div className="dlx-chart-grid">
                <QualityTrendChart
                  points={trendPoints.mos}
                  accent={CHART_GREEN}
                  title="MOS"
                  domain={MOS_DOMAIN}
                  formatValue={fmtMosValue}
                  formatTick={fmtMosTick}
                />
                <QualityTrendChart
                  points={trendPoints.loss}
                  accent={CHART_ROSE}
                  title="Packet Loss %"
                  domain={LOSS_DOMAIN}
                  formatValue={fmtLossValue}
                  formatTick={fmtLossTick}
                />
                <QualityTrendChart
                  points={trendPoints.jitter}
                  accent={CHART_AZURE}
                  title="Jitter — est (ms)"
                  domain={JITTER_DOMAIN}
                  formatValue={fmtJitterValue}
                  formatTick={fmtJitterTick}
                />
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
