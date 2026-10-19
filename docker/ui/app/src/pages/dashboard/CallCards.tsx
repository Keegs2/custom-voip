/**
 * CallCards — the dashboard's call cards, all over the last 7 days:
 *
 *   VolumeCard   GET /cdrs/activity  answered / missed bars per day + average call
 *   QualityCard  GET /cdrs/activity  good-or-better ring (quality.ts tone + word),
 *                                    one-way audio, graded / poor counts
 *   RecentCard   GET /cdrs           the newest calls: time · from · to · outcome · quality
 *   BusiestCard  GET /reports/numbers top numbers by calls, with a relative bar
 *
 * Tenant redaction holds: no money, no raw FreeSWITCH values, no packet
 * counters, no MOS figures — quality is words + tone from quality.ts only.
 */
import { useMemo, type CSSProperties } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { Activity, AudioLines, Flame, PhoneIncoming } from 'lucide-react';
import type { CdrActivityKpis, CdrActivityResponse } from '../../types/cdrActivity';
import type { CdrSearchResult } from '../../types/cdr';
import type { RcfEntry } from '../../types/rcf';
import { fmt } from '../../utils/format';
import { fmtAvgMinutes } from '../../utils/callDuration';
import { goodShareColor } from '../calls/quality';
import { bucketRangeLabel, bucketTick, fmtAcdExact, fmtCallDateTime, fmtShareFloor } from '../rcf/activityFormat';
import { callQualityLabel, callStatusInfo } from '../rcf/callOutcome';
import { Card, CardState } from './Card';
import { fmtRelative, numberKey, shareWord, type NumberStats } from './accountData';

// ─── Shared ──────────────────────────────────────────────────────────────────

/** Tenant rows carry whole-minute means, staff rows exact seconds — decided by
 *  field presence (utils/callDuration.ts rule), never by role. */
function avgDuration(k: CdrActivityKpis): string {
  if (k.avg_duration_sec !== undefined) {
    return k.avg_duration_sec == null || k.avg_duration_sec <= 0 ? '—' : fmtAcdExact(k.avg_duration_sec);
  }
  return fmtAvgMinutes(k.avg_duration_minutes);
}

function OpenActivity({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" className="ad-linkbtn" onClick={onOpen}>
      Call activity
    </button>
  );
}

// ─── Volume ──────────────────────────────────────────────────────────────────

export interface ActivityCardProps {
  activity: UseQueryResult<CdrActivityResponse>;
  onOpen: () => void;
  order: number;
}

export function VolumeCard({ activity, onOpen, order }: ActivityCardProps) {
  const data = activity.data;
  return (
    <Card
      id="ad-volume"
      title="Call volume"
      sub="Last 7 days, answered and missed"
      icon={<PhoneIncoming size={15} strokeWidth={2.2} />}
      action={<OpenActivity onOpen={onOpen} />}
      className="ad-span-4 ad-card-volume"
      order={order}
    >
      {data === undefined ? (
        activity.isError ? (
          <CardState kind="error" onRetry={() => void activity.refetch()}>Call activity couldn’t load.</CardState>
        ) : (
          <CardState kind="loading">Loading call activity…</CardState>
        )
      ) : data.kpis.calls === 0 ? (
        <p className="ad-quiet">No calls reached your numbers in the last 7 days.</p>
      ) : (
        <>
          <WeekBars data={data} />
          <dl className="ad-facts">
            <div>
              <dt>Calls</dt>
              <dd>{data.kpis.calls.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Average call</dt>
              <dd>{avgDuration(data.kpis)}</dd>
            </div>
          </dl>
        </>
      )}
    </Card>
  );
}

function WeekBars({ data }: { data: CdrActivityResponse }) {
  const max = Math.max(1, ...data.points.map((p) => p.calls));
  const tz = data.tz;
  return (
    <figure className="ad-bars-fig">
      <div className="ad-bars" role="img" aria-label="Calls per day for the last 7 days, answered and missed">
        {data.points.map((p, i) => {
          const next = data.points[i + 1]?.t ?? data.end;
          const heading = bucketRangeLabel(data.bucket, p.t, next, tz);
          const tip = `${heading}: ${p.calls.toLocaleString()} ${p.calls === 1 ? 'call' : 'calls'}, ${p.answered.toLocaleString()} answered, ${p.missed.toLocaleString()} missed`;
          return (
            <div key={p.t} className="ad-bar-col" title={tip} style={{ '--i': i } as CSSProperties}>
              <div className="ad-bar-track">
                <div className="ad-bar-stack" style={{ height: `${(p.calls / max) * 100}%` }}>
                  {p.missed > 0 && <span className="ad-bar-missed" style={{ flexGrow: p.missed }} />}
                  {p.answered > 0 && <span className="ad-bar-answered" style={{ flexGrow: p.answered }} />}
                </div>
              </div>
              <span className="ad-bar-tick">{bucketTick(data.bucket, p.t, tz).split(' ')[0]}</span>
            </div>
          );
        })}
      </div>
      <figcaption className="ad-legend">
        <span><span className="ad-swatch ad-swatch-answered" aria-hidden="true" />Answered</span>
        <span><span className="ad-swatch ad-swatch-missed" aria-hidden="true" />Missed</span>
      </figcaption>
      <table className="ad-visually-hidden">
        <caption>Calls per day, last 7 days</caption>
        <thead>
          <tr><th scope="col">Day</th><th scope="col">Calls</th><th scope="col">Answered</th><th scope="col">Missed</th></tr>
        </thead>
        <tbody>
          {data.points.map((p) => (
            <tr key={p.t}>
              <th scope="row">{bucketTick(data.bucket, p.t, tz)}</th>
              <td>{p.calls}</td><td>{p.answered}</td><td>{p.missed}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

// ─── Quality ─────────────────────────────────────────────────────────────────

const RING_R = 42;
const RING_C = 2 * Math.PI * RING_R;

export function QualityCard({ activity, onOpen, order }: ActivityCardProps) {
  const k = activity.data?.kpis;
  const share = k?.good_share_pct ?? null;
  const tone = goodShareColor(share);
  const word = share != null ? shareWord(tone) : null;

  return (
    <Card
      id="ad-quality"
      title="Call quality"
      sub="How clear calls sounded, last 7 days"
      icon={<AudioLines size={15} strokeWidth={2.2} />}
      action={<OpenActivity onOpen={onOpen} />}
      className="ad-span-4"
      order={order}
    >
      {k === undefined ? (
        activity.isError ? (
          <CardState kind="error" onRetry={() => void activity.refetch()}>Call quality couldn’t load.</CardState>
        ) : (
          <CardState kind="loading">Loading call quality…</CardState>
        )
      ) : (
        <div className="ad-quality">
          <div className="ad-ring" style={{ '--ad-tone': tone } as CSSProperties}>
            <svg viewBox="0 0 100 100" aria-hidden="true">
              <circle className="ad-ring-track" cx="50" cy="50" r={RING_R} />
              {share != null && (
                <circle
                  className="ad-ring-fill"
                  cx="50"
                  cy="50"
                  r={RING_R}
                  strokeDasharray={`${(Math.max(0, Math.min(100, share)) / 100) * RING_C} ${RING_C}`}
                />
              )}
            </svg>
            <span className="ad-ring-label">
              <span className="ad-ring-value">{fmtShareFloor(share)}</span>
              <span className="ad-ring-cap">sounded good</span>
            </span>
          </div>

          <div className="ad-quality-side">
            {word ? (
              <span className="ad-tone-word ad-tone-word-lg" style={{ '--ad-tone': tone } as CSSProperties}>
                <span className="ad-dot" aria-hidden="true" />
                {word}
              </span>
            ) : (
              <span className="ad-faint">No graded calls yet</span>
            )}
            <dl className="ad-facts ad-facts-stack">
              <div>
                <dt>Graded calls</dt>
                <dd>{k.graded.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Poor calls</dt>
                <dd className={k.poor > 0 ? 'ad-fact-bad' : undefined}>{k.poor.toLocaleString()}</dd>
              </div>
              <div title="Calls where sound came through from one side only.">
                <dt>One-way audio</dt>
                <dd className={k.one_way > 0 ? 'ad-fact-bad' : undefined}>
                  {k.one_way > 0 ? `${k.one_way.toLocaleString()} ${k.one_way === 1 ? 'call' : 'calls'}` : 'None'}
                </dd>
              </div>
            </dl>
          </div>
        </div>
      )}
    </Card>
  );
}

// ─── Recent calls ────────────────────────────────────────────────────────────

export interface RecentCardProps {
  calls: UseQueryResult<CdrSearchResult>;
  nowMs: number;
  onOpen: () => void;
  order: number;
}

export function RecentCard({ calls, nowMs, onOpen, order }: RecentCardProps) {
  const rows = calls.data?.items ?? [];
  return (
    <Card
      id="ad-recent"
      title="Recent calls"
      sub="The newest calls to your numbers"
      icon={<Activity size={15} strokeWidth={2.2} />}
      action={<OpenActivity onOpen={onOpen} />}
      className="ad-span-8 ad-card-calls"
      order={order}
      footer={
        <button type="button" className="ad-btn ad-btn-quiet ad-btn-block" onClick={onOpen}>
          Open call activity
        </button>
      }
    >
      {calls.data === undefined ? (
        calls.isError ? (
          <CardState kind="error" onRetry={() => void calls.refetch()}>Recent calls couldn’t load.</CardState>
        ) : (
          <CardState kind="loading">Loading recent calls…</CardState>
        )
      ) : rows.length === 0 ? (
        <p className="ad-quiet">No calls in the last 7 days.</p>
      ) : (
        <div className="ad-tablewrap">
          <table className="ad-table ad-calltable">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">From</th>
                <th scope="col" className="ad-col-to">To</th>
                <th scope="col">Outcome</th>
                <th scope="col">Quality</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((cdr) => {
                const status = callStatusInfo(cdr);
                const quality = callQualityLabel(cdr);
                return (
                  <tr key={cdr.uuid}>
                    <td>
                      <time dateTime={cdr.start_time} title={fmtCallDateTime(cdr.start_time)} className="ad-when">
                        {fmtRelative(cdr.start_time, nowMs) ?? '—'}
                      </time>
                    </td>
                    <td><span className="ad-num ad-num-sm ad-num-soft">{cdr.caller_id ? fmt(cdr.caller_id) : 'Unknown'}</span></td>
                    <td className="ad-col-to"><span className="ad-num ad-num-sm ad-num-dest">{fmt(cdr.destination)}</span></td>
                    <td>
                      <span
                        className="ad-pill"
                        style={{ color: status.color, background: status.bg, border: status.border }}
                      >
                        {status.label}
                      </span>
                    </td>
                    <td>
                      {quality.text ? (
                        <span className="ad-quality-word" style={{ color: quality.color }} title={quality.reason ?? undefined}>
                          <span className="ad-dot" aria-hidden="true" />
                          {quality.text}
                        </span>
                      ) : (
                        <span className="ad-faint" title={quality.reason ?? undefined}>
                          Not rated{quality.short ? ` · ${quality.short}` : ''}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ─── Busiest numbers ─────────────────────────────────────────────────────────

const BUSIEST = 5;

export interface BusiestCardProps {
  stats: NumberStats;
  entries: readonly RcfEntry[];
  order: number;
}

export function BusiestCard({ stats, entries, order }: BusiestCardProps) {
  const busiest = useMemo(() => {
    if (stats.state !== 'ready') return [];
    const labels = new Map(entries.map((e) => [numberKey(e.did), e.name ?? null]));
    return [...stats.byNumber.values()]
      .filter((r) => r.calls > 0)
      .sort((a, b) => b.calls - a.calls)
      .slice(0, BUSIEST)
      .map((r) => ({ ...r, label: labels.get(numberKey(r.number)) ?? r.name }));
  }, [stats, entries]);
  const max = busiest[0]?.calls ?? 1;

  return (
    <Card
      id="ad-busiest"
      title="Busiest numbers"
      sub="Most calls in the last 7 days"
      icon={<Flame size={15} strokeWidth={2.2} />}
      className="ad-span-4"
      order={order}
    >
      {stats.state === 'loading' ? (
        <CardState kind="loading">Loading…</CardState>
      ) : stats.state === 'unavailable' ? (
        <p className="ad-quiet">Per-number figures aren’t available right now.</p>
      ) : busiest.length === 0 ? (
        <p className="ad-quiet">No calls to any number in the last 7 days.</p>
      ) : (
        <ol className="ad-busiest">
          {busiest.map((r, i) => (
            <li key={r.number}>
              <span className="ad-busiest-rank" aria-hidden="true">{i + 1}</span>
              <span className="ad-busiest-id">
                <span className="ad-num ad-num-sm">{fmt(r.number)}</span>
                {r.label && <span className="ad-faint">{r.label}</span>}
                <span className="ad-meter" aria-hidden="true">
                  <span style={{ width: `${Math.max(4, (r.calls / max) * 100)}%` }} />
                </span>
              </span>
              <span className="ad-busiest-calls">
                {r.calls.toLocaleString()} <span className="ad-faint">{r.calls === 1 ? 'call' : 'calls'}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
