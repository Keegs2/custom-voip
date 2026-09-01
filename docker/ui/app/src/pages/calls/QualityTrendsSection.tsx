/**
 * QualityTrendsSection — the three polished QualityTrendChart charts (MOS /
 * packet loss / jitter daily averages, bridged gap lines) from the Call
 * Quality page, kept intact on the merged page inside a collapsible panel.
 *
 * Data model: the charts need the WHOLE window, not one table page, so this
 * section runs its own up-to-1000-row fetch over the SAME committed filter
 * set (identical params object + nonce → provably the same search). The
 * query only runs while the section is expanded (react-query `enabled`), so
 * a collapsed section costs nothing. Collapse state persists in
 * localStorage; default expanded.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { searchCdrs } from '../../api/cdrs';
import { Spinner } from '../../components/ui/Spinner';
import { QualityTrendChart } from '../../components/charts/QualityTrendChart';
import type { TrendDomain, TrendPoint } from '../../components/charts/QualityTrendChart';
import type { Cdr, CdrSearchParams } from '../../types/cdr';
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

const MOS_DOMAIN: TrendDomain = { min: 1, max: 5 };
const LOSS_DOMAIN: TrendDomain = { min: 0, max: 'auto' };
const JITTER_DOMAIN: TrendDomain = { min: 0, max: 'auto' };

const CHART_GREEN = '#16a34a';
const CHART_ROSE = '#be123c';
const CHART_AZURE = '#1d63dd';

const fmtMosValue = (v: number): string => v.toFixed(2);
const fmtMosTick = (v: number): string => String(Math.round(v));
const fmtLossValue = (v: number): string => `${v.toFixed(2)}%`;
const fmtLossTick = (v: number): string => `${parseFloat(v.toFixed(3))}%`;
const fmtJitterValue = (v: number): string => `${v.toFixed(1)} ms`;
const fmtJitterTick = (v: number): string => `${parseFloat(v.toFixed(1))}`;

// ---------------------------------------------------------------------------
// Daily quality buckets — one slot for EVERY day of the committed range
// (continuous axis; days without data stay null and render as honest gaps),
// plus per-day sample counts so the chart tooltips can show how many calls
// each average summarizes.
// ---------------------------------------------------------------------------

interface DailyQuality {
  date: string;
  totalCalls: number;
  avgMos: number | null;
  mosCount: number;
  avgPacketLossPct: number | null;
  plCount: number;
  avgJitterMs: number | null;
  jCount: number;
}

function buildDailyQuality(cdrs: Cdr[], startDate: Date, endDate: Date): DailyQuality[] {
  const byDate = new Map<string, { calls: number; mosSum: number; mosCount: number; plSum: number; plCount: number; jSum: number; jCount: number }>();

  for (const cdr of cdrs) {
    const key = cdr.start_time.slice(0, 10);
    const bucket = byDate.get(key) ?? { calls: 0, mosSum: 0, mosCount: 0, plSum: 0, plCount: 0, jSum: 0, jCount: 0 };
    bucket.calls++;
    if (cdr.mos != null) { bucket.mosSum += cdr.mos; bucket.mosCount++; }
    if (cdr.packet_loss_pct != null) { bucket.plSum += cdr.packet_loss_pct; bucket.plCount++; }
    if (cdr.jitter_avg_ms != null) { bucket.jSum += cdr.jitter_avg_ms; bucket.jCount++; }
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
    slots.push({
      date: key,
      totalCalls: b?.calls ?? 0,
      avgMos: b && b.mosCount > 0 ? b.mosSum / b.mosCount : null,
      mosCount: b?.mosCount ?? 0,
      avgPacketLossPct: b && b.plCount > 0 ? b.plSum / b.plCount : null,
      plCount: b?.plCount ?? 0,
      avgJitterMs: b && b.jCount > 0 ? b.jSum / b.jCount : null,
      jCount: b?.jCount ?? 0,
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

  const { data, isLoading, isError } = useQuery({
    queryKey: ['calls-trends', params, nonce],
    queryFn: () => searchCdrs({ ...params, limit: TREND_SAMPLE_LIMIT, offset: 0 }),
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

  // One TrendPoint series per metric — value + per-day sample size for the
  // chart tooltips ("N of M calls scored").
  const trendPoints = useMemo(() => ({
    mos: dailyQuality.map((d): TrendPoint => ({ date: d.date, value: d.avgMos, sampleCount: d.mosCount, totalCalls: d.totalCalls })),
    loss: dailyQuality.map((d): TrendPoint => ({ date: d.date, value: d.avgPacketLossPct, sampleCount: d.plCount, totalCalls: d.totalCalls })),
    jitter: dailyQuality.map((d): TrendPoint => ({ date: d.date, value: d.avgJitterMs, sampleCount: d.jCount, totalCalls: d.totalCalls })),
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
