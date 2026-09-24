/**
 * The Reporting page's metric cards — each one reads a single slice of
 * `/reports/overview` (or `/reports/trend`) and says it in plain English,
 * with a "What does this mean?" explainer underneath.
 */
import { AlertCircle, CalendarClock, Headphones, PhoneMissed, TrendingUp } from 'lucide-react';
import type { ReportOverview, ReportTrend } from '../../types/reports';
import { CallsTrendChart } from './CallsTrendChart';
import { CardError, CardSkeleton, Explainer, ReportCard, Skeleton } from './ReportBits';
import {
  fmtAvgMinutes,
  fmtCount,
  fmtHourRange,
  fmtMinutes,
  fmtPct,
  fmtWeekdayDate,
  GRADE_BLURB,
  GRADE_TONE,
  GRADE_WORD,
  honestWhole,
  plural,
  TREND_COLORS,
} from './reportFormat';
import type { SentenceSegment } from './summarySentence';

/* ─── Shared query-state props ──────────────────────────────────────────── */

interface QueryState<T> {
  data: T | undefined;
  isLoading: boolean;
  error: unknown;
  refetch: () => void;
}

/* ═══ Summary hero — the ELI5 sentence + headline figures ═══════════════ */

export function SummaryHero({
  overview,
  sentence,
}: {
  overview: QueryState<ReportOverview>;
  sentence: SentenceSegment[] | null;
}) {
  const data = overview.data;
  return (
    <section className="dl-panel" aria-labelledby="rpt-summary-heading">
      <div className="dl-panel-body">
        <h2 id="rpt-summary-heading" className="rpt-sr">Summary</h2>
        {overview.isLoading && (
          <div role="status" aria-label="Loading your summary" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Skeleton width="78%" height={24} />
            <Skeleton width="52%" height={24} />
            <div className="dlx4-statgrid rpt-hero-stats">
              {Array.from({ length: 5 }, (_, i) => (
                <div key={i} className="dlx4-statcell">
                  <Skeleton width="60%" height={20} />
                  <Skeleton width="80%" height={10} style={{ marginTop: 8 }} />
                </div>
              ))}
            </div>
          </div>
        )}

        {!overview.isLoading && overview.error != null && (
          <CardError error={overview.error} onRetry={overview.refetch} what="your summary" />
        )}

        {data && sentence && (
          <>
            <p className="rpt-sentence" aria-live="polite">
              {sentence.map((seg, i) => (seg.strong ? <strong key={i}>{seg.text}</strong> : <span key={i}>{seg.text}</span>))}
            </p>

            {data.totals.calls > 0 && (
              <div className="dlx4-statgrid rpt-hero-stats">
                <Stat
                  value={fmtCount(data.totals.calls)}
                  label="Calls"
                  hint={`${fmtCount(data.totals.inbound)} in · ${fmtCount(data.totals.outbound)} out`}
                />
                <Stat value={fmtCount(data.totals.answered)} label="Answered" hint={fmtPct(data.totals.answer_rate_pct)} tone="#15803d" />
                <Stat
                  value={fmtCount(data.totals.missed)}
                  label="Missed"
                  hint={data.totals.missed > 0 && data.totals.answer_rate_pct != null ? fmtPct(100 - data.totals.answer_rate_pct) : 'none'}
                  tone={data.totals.missed > 0 ? '#b45309' : undefined}
                />
                <Stat value={fmtMinutes(data.totals.minutes)} label="Time on the phone" hint="whole minutes" />
                <Stat value={fmtAvgMinutes(data.totals.avg_minutes)} label="Typical call" hint="answered calls" />
              </div>
            )}

            <div style={{ marginTop: 14 }}>
              <Explainer>
                <p>
                  <strong>Calls</strong> counts every call to or from your numbers in this period — “in” are
                  calls people made to you, “out” are calls your numbers made.
                </p>
                <p>
                  <strong>Answered</strong> means someone picked up. <strong>Missed</strong> means the call
                  ended before anyone did — the “Missed calls” card below shows why.
                </p>
                <p>
                  <strong>Time on the phone</strong> adds up how long answered calls lasted, rounded to whole
                  minutes. <strong>Typical call</strong> is the average length of an answered call.
                </p>
              </Explainer>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function Stat({ value, label, hint, tone }: { value: string; label: string; hint?: string; tone?: string }) {
  return (
    <div className="dlx4-statcell">
      <div className="dlx4-statcell-value" style={tone ? { color: tone } : undefined}>{value}</div>
      <div className="dlx4-statcell-label">{label}</div>
      {hint && <div className="dlx4-statcell-hint">{hint}</div>}
    </div>
  );
}

/* ═══ Calls over time ═══════════════════════════════════════════════════ */

export function TrendCard({ trend }: { trend: QueryState<ReportTrend> }) {
  const bucket = trend.data?.bucket ?? 'day';
  const per = bucket === 'day' ? 'day' : bucket === 'week' ? 'week (weeks start on Monday)' : 'month';
  return (
    <ReportCard
      title="Calls over time"
      icon={<TrendingUp size={16} />}
      headExtra={
        <div className="rpt-legend" style={{ marginLeft: 'auto' }} aria-hidden="true">
          <span className="rpt-legend-item">
            <span className="rpt-legend-swatch" style={{ background: TREND_COLORS.answered }} /> Answered
          </span>
          <span className="rpt-legend-item">
            <span className="rpt-legend-swatch" style={{ background: TREND_COLORS.missed }} /> Missed
          </span>
        </div>
      }
      explainer={
        <>
          <p>
            Each bar is one {per}. Its height is how many calls you had; the blue part were answered and the
            orange part on top were missed.
          </p>
          <p>Point at a bar (or click the chart and use the arrow keys) to see the exact numbers.</p>
        </>
      }
    >
      {trend.isLoading && <Skeleton height={250} />}
      {!trend.isLoading && trend.error != null && <CardError error={trend.error} onRetry={trend.refetch} what="the chart" />}
      {trend.data && <CallsTrendChart bucket={trend.data.bucket} points={trend.data.points} />}
    </ReportCard>
  );
}

/* ═══ Busiest day & hour ════════════════════════════════════════════════ */

export function BusiestCard({ overview }: { overview: QueryState<ReportOverview> }) {
  const data = overview.data;
  return (
    <ReportCard
      title="Your busiest times"
      icon={<CalendarClock size={16} />}
      explainer={
        <>
          <p>
            <strong>Busiest day</strong> is the single date with the most calls in this period.
          </p>
          <p>
            <strong>Busiest hour</strong> is the hour of the day when the most calls started, added up across
            every day in the period. It’s a good hint for when to have the most people ready to pick up.
          </p>
        </>
      }
    >
      {overview.isLoading && <CardSkeleton label="your busiest times" />}
      {!overview.isLoading && overview.error != null && <CardError error={overview.error} onRetry={overview.refetch} what="your busiest times" />}
      {data && (
        data.totals.calls === 0 || (!data.busiest_day && !data.busiest_hour) ? (
          <div className="dl-empty">No calls yet, so there’s no busiest time to show.</div>
        ) : (
          <>
            <div>
              <div className="rpt-eyebrow">Busiest day</div>
              {data.busiest_day ? (
                <>
                  <div className="rpt-bigword">{fmtWeekdayDate(data.busiest_day.date)}</div>
                  <p className="rpt-caption">{plural(data.busiest_day.calls, 'call', 'calls')} that day.</p>
                </>
              ) : (
                <p className="rpt-caption">—</p>
              )}
            </div>
            <hr className="rpt-divider" />
            <div>
              <div className="rpt-eyebrow">Busiest hour</div>
              {data.busiest_hour ? (
                <>
                  <div className="rpt-bigword">{fmtHourRange(data.busiest_hour.hour)}</div>
                  <p className="rpt-caption">
                    {plural(data.busiest_hour.calls, 'call', 'calls')} started in this hour across the whole period.
                  </p>
                </>
              ) : (
                <p className="rpt-caption">—</p>
              )}
            </div>
          </>
        )
      )}
    </ReportCard>
  );
}

/* ═══ Missed calls & why ════════════════════════════════════════════════ */

export function MissedCard({ overview }: { overview: QueryState<ReportOverview> }) {
  const data = overview.data;
  const reasons = data ? [...data.missed_reasons].filter((r) => r.calls > 0).sort((a, b) => b.calls - a.calls) : [];
  const missedTotal = data?.totals.missed ?? 0;
  const maxReason = reasons.reduce((m, r) => Math.max(m, r.calls), 0);

  return (
    <ReportCard
      title="Missed calls & why"
      icon={<PhoneMissed size={16} />}
      explainer={
        <>
          <p>A missed call is one that ended before anyone answered. Here’s what stopped each one:</p>
          <p>
            <strong>Nobody picked up</strong> — it rang until it gave up. <strong>The caller hung up</strong> —
            they gave up before it was answered. <strong>Busy</strong> — the line was already in use.{' '}
            <strong>Not in service</strong> — the number dialed doesn’t work. <strong>Declined</strong> — the call
            was turned away or blocked. <strong>Network problem</strong> — something along the way stopped it.
          </p>
        </>
      }
    >
      {overview.isLoading && <CardSkeleton lines={4} label="missed calls" />}
      {!overview.isLoading && overview.error != null && <CardError error={overview.error} onRetry={overview.refetch} what="missed calls" />}
      {data && (
        data.totals.calls === 0 ? (
          <div className="dl-empty">No calls yet in this period.</div>
        ) : missedTotal === 0 ? (
          <div className="dl-empty" style={{ color: '#15803d' }}>No missed calls — every call was answered.</div>
        ) : (
          <>
            <div>
              <div className="rpt-bigword">{plural(missedTotal, 'missed call', 'missed calls')}</div>
              <p className="rpt-caption">
                That’s {honestWhole((missedTotal / data.totals.calls) * 100)} of every 100 calls.
              </p>
            </div>
            {reasons.length > 0 ? (
              <ul className="rpt-bars" aria-label="Why calls were missed">
                {reasons.map((r) => (
                  <li key={r.key}>
                    <div className="rpt-bar-top">
                      <span>{r.label}</span>
                      <span className="rpt-bar-count">
                        {fmtCount(r.calls)} <span>({fmtPct((r.calls / missedTotal) * 100)})</span>
                      </span>
                    </div>
                    <div className="rpt-bar-track" aria-hidden="true">
                      <div className="rpt-bar-fill" style={{ width: `${maxReason > 0 ? Math.max((r.calls / maxReason) * 100, 3) : 0}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rpt-caption">We don’t have a reason on file for these calls.</p>
            )}
          </>
        )
      )}
    </ReportCard>
  );
}

/* ═══ Call quality ══════════════════════════════════════════════════════ */

export function QualityCard({ overview }: { overview: QueryState<ReportOverview> }) {
  const data = overview.data;
  const q = data?.quality;
  return (
    <ReportCard
      title="Call quality"
      icon={<Headphones size={16} />}
      explainer={
        <>
          <p>
            We listen to how clear each answered call sounded and give it a score from 1 (hard to understand) to 5
            (crystal clear). The phone industry calls this a <strong>MOS score</strong>.
          </p>
          <p>
            <strong>Great</strong> is 4 and up, <strong>Good</strong> is 3.6 and up, <strong>Fair</strong> is 3.1 and
            up, and anything lower is <strong>Poor</strong>. Most calls land in Great.
          </p>
          <p>Some calls can’t be measured (for example very short ones), so they’re left out.</p>
        </>
      }
    >
      {overview.isLoading && <CardSkeleton label="call quality" />}
      {!overview.isLoading && overview.error != null && <CardError error={overview.error} onRetry={overview.refetch} what="call quality" />}
      {q && (
        <>
          <div>
            <div className="rpt-eyebrow">Overall</div>
            <div className="rpt-bigword" style={{ color: GRADE_TONE[q.grade] }}>
              {GRADE_WORD[q.grade]}
            </div>
            <p className="rpt-caption">{GRADE_BLURB[q.grade]}</p>
          </div>
          {q.grade !== 'none' && (
            <div className="dl-kvbox">
              {q.avg_mos != null && (
                <div className="dl-kv">
                  <span className="dl-kv-label">Sound score</span>
                  <span className="dl-kv-value">{q.avg_mos.toFixed(1)} out of 5</span>
                </div>
              )}
              {q.pct_good_or_better != null && (
                <div className="dl-kv">
                  <span className="dl-kv-label">Sounded good or better</span>
                  <span className="dl-kv-value">{honestWhole(q.pct_good_or_better)} of every 100</span>
                </div>
              )}
              <div className="dl-kv">
                <span className="dl-kv-label">Calls measured</span>
                <span className="dl-kv-value">{fmtCount(q.rated_calls)}</span>
              </div>
            </div>
          )}
          {q.grade === 'poor' && (
            <div className="dl-banner dl-banner-warn" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <AlertCircle size={15} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
              <span>If callers are telling you the line sounds bad, contact support and mention this report.</span>
            </div>
          )}
        </>
      )}
    </ReportCard>
  );
}

/* ═══ Glossary ══════════════════════════════════════════════════════════ */

export function Glossary() {
  return (
    <section className="dl-panel" aria-labelledby="rpt-glossary-heading">
      <div className="dl-panel-head">
        <h2 id="rpt-glossary-heading" className="dl-panel-title" style={{ margin: 0 }}>Words on this page</h2>
      </div>
      <div className="dl-panel-body">
        <dl className="rpt-glossary">
          <div>
            <dt>Answered</dt>
            <dd>Someone picked up the call.</dd>
          </div>
          <div>
            <dt>Missed</dt>
            <dd>The call ended before anyone picked up — for example nobody was there, the line was busy, or the caller hung up first.</dd>
          </div>
          <div>
            <dt>Minutes</dt>
            <dd>How long answered calls lasted, rounded to whole minutes. Totals are rounded once at the end, so they can differ slightly from adding up each call.</dd>
          </div>
          <div>
            <dt>Call quality</dt>
            <dd>How clear the call sounded, graded Great, Good, Fair or Poor from a 1-to-5 sound score.</dd>
          </div>
          <div>
            <dt>Incoming / outgoing</dt>
            <dd>Incoming calls were made to one of your numbers; outgoing calls were made from one of them.</dd>
          </div>
          <div>
            <dt>Currently forwards to</dt>
            <dd>Where calls to that number ring today. If you changed it during the period, earlier calls may have gone somewhere else.</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
