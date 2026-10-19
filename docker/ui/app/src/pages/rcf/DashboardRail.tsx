/**
 * DashboardRail — the right-hand column of the customer dashboard. Three
 * quieter panels, one step lower in elevation than the routing board:
 *
 *   CallsPanel     GET /cdrs/activity (7d) daily bars + avg duration + one-way,
 *                  busiest numbers from GET /reports/numbers, "Open call activity"
 *   TeamPanel      GET /auth/team — who on the account can sign in
 *   RequestsPanel  GET /numbers/my — numbers waiting for approval / release
 *
 * Each panel owns its loading / error / empty state so one failing feed never
 * takes the others down. Tenant redaction holds: no money, no raw media
 * values, no packet counters; quality tone only via quality.ts.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';
import type { CdrActivityKpis, CdrActivityResponse } from '../../types/cdrActivity';
import type { TeamMember, TeamRole } from '../../types/account';
import type { DidInventoryItem } from '../../types/didInventory';
import type { RcfEntry } from '../../types/rcf';
import { fmt } from '../../utils/format';
import { fmtAvgMinutes } from '../../utils/callDuration';
import { Spinner } from '../../components/ui/Spinner';
import { bucketRangeLabel, bucketTick, fmtAcdExact } from './activityFormat';
import { fmtRelative, initials, numberKey } from './dashboardData';
import type { NumberStats } from './RoutingBoard';

// ─── Shared bits ─────────────────────────────────────────────────────────────

function PanelState({ kind, children, onRetry }: { kind: 'loading' | 'error'; children: string; onRetry?: () => void }) {
  return (
    <div className={`rcfd-state rcfd-state-compact${kind === 'error' ? ' rcfd-state-error' : ''}`} role={kind === 'error' ? 'alert' : undefined}>
      {kind === 'loading' && <Spinner size="sm" />}
      <span>{children}</span>
      {onRetry && (
        <button type="button" className="rcfd-linkbtn" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

// ─── Calls ───────────────────────────────────────────────────────────────────

/** Tenant rows carry whole-minute means, staff rows exact seconds — decided by
 *  field presence (utils/callDuration.ts rule), never by role. */
function avgDuration(k: CdrActivityKpis): string {
  if (k.avg_duration_sec !== undefined) {
    return k.avg_duration_sec == null || k.avg_duration_sec <= 0 ? '—' : fmtAcdExact(k.avg_duration_sec);
  }
  return fmtAvgMinutes(k.avg_duration_minutes);
}

function WeekBars({ data }: { data: CdrActivityResponse }) {
  const max = Math.max(1, ...data.points.map((p) => p.calls));
  const tz = data.tz;
  return (
    <figure className="rcfd-bars-fig">
      <div className="rcfd-bars" role="img" aria-label="Calls per day for the last 7 days, answered and missed">
        {data.points.map((p, i) => {
          const next = data.points[i + 1]?.t ?? data.end;
          const heading = bucketRangeLabel(data.bucket, p.t, next, tz);
          const tip = `${heading}: ${p.calls.toLocaleString()} ${p.calls === 1 ? 'call' : 'calls'}, ${p.answered.toLocaleString()} answered, ${p.missed.toLocaleString()} missed`;
          return (
            <div key={p.t} className="rcfd-bar-col" title={tip}>
              <div className="rcfd-bar-track">
                <div className="rcfd-bar-stack" style={{ height: `${(p.calls / max) * 100}%` }}>
                  {p.missed > 0 && <span className="rcfd-bar-missed" style={{ flexGrow: p.missed }} />}
                  {p.answered > 0 && <span className="rcfd-bar-answered" style={{ flexGrow: p.answered }} />}
                </div>
              </div>
              <span className="rcfd-bar-tick">{bucketTick(data.bucket, p.t, tz).split(' ')[0]}</span>
            </div>
          );
        })}
      </div>
      <figcaption className="rcfd-legend">
        <span><span className="rcfd-swatch rcfd-swatch-answered" aria-hidden="true" />Answered</span>
        <span><span className="rcfd-swatch rcfd-swatch-missed" aria-hidden="true" />Missed</span>
      </figcaption>
      <table className="rcfd-visually-hidden">
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

export interface CallsPanelProps {
  activity: UseQueryResult<CdrActivityResponse>;
  stats: NumberStats;
  entries: readonly RcfEntry[];
  onOpen: () => void;
}

export function CallsPanel({ activity, stats, entries, onOpen }: CallsPanelProps) {
  const busiest = useMemo(() => {
    if (stats.state !== 'ready') return [];
    const labels = new Map(entries.map((e) => [numberKey(e.did), e.name ?? null]));
    return [...stats.byNumber.values()]
      .filter((r) => r.calls > 0)
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 3)
      .map((r) => ({ ...r, label: labels.get(numberKey(r.number)) ?? r.name }));
  }, [stats, entries]);

  const data = activity.data;
  const kpis = data?.kpis;

  return (
    <section className="rcfd-panel rcfd-rail-panel" aria-labelledby="rcfd-calls-title">
      <header className="rcfd-rail-head">
        <h2 id="rcfd-calls-title" className="rcfd-panel-title">Calls, last 7 days</h2>
      </header>

      {data === undefined ? (
        activity.isError ? (
          <PanelState kind="error" onRetry={() => void activity.refetch()}>Call activity couldn’t load.</PanelState>
        ) : (
          <PanelState kind="loading">Loading call activity…</PanelState>
        )
      ) : (
        <div className="rcfd-rail-body">
          {data.kpis.calls === 0 ? (
            <p className="rcfd-quiet">No calls reached your numbers in the last 7 days.</p>
          ) : (
            <WeekBars data={data} />
          )}

          {kpis && (
            <dl className="rcfd-facts">
              <div>
                <dt>Average call</dt>
                <dd>{avgDuration(kpis)}</dd>
              </div>
              <div title="Calls where sound came through from one side only.">
                <dt>One-way audio</dt>
                <dd className={kpis.one_way > 0 ? 'rcfd-fact-bad' : undefined}>
                  {kpis.one_way > 0 ? (
                    <>
                      <span className="rcfd-dot rcfd-dot-bad" aria-hidden="true" />
                      {kpis.one_way.toLocaleString()} {kpis.one_way === 1 ? 'call' : 'calls'}
                    </>
                  ) : (
                    'None detected'
                  )}
                </dd>
              </div>
            </dl>
          )}

          {busiest.length > 0 && (
            <div className="rcfd-busiest">
              <h3 className="rcfd-subhead">Busiest numbers</h3>
              <ol>
                {busiest.map((r) => (
                  <li key={r.number}>
                    <span className="rcfd-busiest-id">
                      <span className="rcfd-num rcfd-num-sm">{fmt(r.number)}</span>
                      {r.label && <span className="rcfd-busiest-label">{r.label}</span>}
                    </span>
                    <span className="rcfd-busiest-calls">
                      {r.calls.toLocaleString()} {r.calls === 1 ? 'call' : 'calls'}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}

      <footer className="rcfd-rail-foot">
        <button type="button" className="rcfd-btn rcfd-btn-quiet rcfd-btn-block" onClick={onOpen}>
          Open call activity
        </button>
      </footer>
    </section>
  );
}

// ─── Team ────────────────────────────────────────────────────────────────────

const ROLE_LABEL: Record<TeamRole, string> = {
  admin: 'Administrator',
  user: 'Can edit',
  readonly: 'View only',
};

const TEAM_PREVIEW = 5;

export interface TeamPanelProps {
  team: UseQueryResult<TeamMember[]>;
  nowMs: number;
}

export function TeamPanel({ team, nowMs }: TeamPanelProps) {
  const [showAll, setShowAll] = useState(false);
  const members = useMemo(() => {
    const list = team.data ?? [];
    // You first, then everyone else in the API's order (oldest account first).
    return [...list.filter((m) => m.is_self), ...list.filter((m) => !m.is_self)];
  }, [team.data]);
  const shown = showAll ? members : members.slice(0, TEAM_PREVIEW);

  return (
    <section className="rcfd-panel rcfd-rail-panel" aria-labelledby="rcfd-team-title">
      <header className="rcfd-rail-head">
        <h2 id="rcfd-team-title" className="rcfd-panel-title">
          Team
          {team.data && <span className="rcfd-count">{team.data.length}</span>}
        </h2>
        <Link to="/my-account" className="rcfd-linkbtn">My account</Link>
      </header>

      {team.data === undefined ? (
        team.isError ? (
          <PanelState kind="error" onRetry={() => void team.refetch()}>Your team couldn’t load.</PanelState>
        ) : (
          <PanelState kind="loading">Loading your team…</PanelState>
        )
      ) : members.length === 0 ? (
        <p className="rcfd-quiet rcfd-rail-body">No one else has access yet. Ask Granite support to add a teammate.</p>
      ) : (
        <ul className="rcfd-team">
          {shown.map((m) => {
            const seen = fmtRelative(m.last_login, nowMs);
            const inactive = m.status !== 'active';
            return (
              <li key={m.id} className={inactive ? 'rcfd-member rcfd-member-inactive' : 'rcfd-member'}>
                <span className="rcfd-avatar" aria-hidden="true">{initials(m.name, m.email)}</span>
                <span className="rcfd-member-id">
                  <span className="rcfd-member-name">
                    {m.name || m.email}
                    {m.is_self && <span className="rcfd-tag">You</span>}
                  </span>
                  <span className="rcfd-member-mail">{m.email}</span>
                </span>
                <span className="rcfd-member-meta">
                  <span className="rcfd-member-role">{ROLE_LABEL[m.role] ?? m.role}</span>
                  <span className="rcfd-member-seen">
                    {inactive
                      ? `Account ${m.status}`
                      : seen
                        ? `Signed in ${seen}`
                        : 'Never signed in'}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {members.length > TEAM_PREVIEW && (
        <footer className="rcfd-rail-foot">
          <button type="button" className="rcfd-linkbtn" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
            {showAll ? 'Show fewer' : `Show all ${members.length}`}
          </button>
        </footer>
      )}
    </section>
  );
}

// ─── Number requests ─────────────────────────────────────────────────────────

const REQUEST_PREVIEW = 4;

export interface RequestsPanelProps {
  dids: UseQueryResult<DidInventoryItem[]>;
  actionLabel: string;
  onOpen: () => void;
}

export function RequestsPanel({ dids, actionLabel, onOpen }: RequestsPanelProps) {
  const open = useMemo(
    () => (dids.data ?? []).filter((d) => d.status === 'reserved' || d.status === 'release_requested'),
    [dids.data],
  );
  const pending = open.filter((d) => d.status === 'reserved').length;
  const releasing = open.length - pending;

  return (
    <section className="rcfd-panel rcfd-rail-panel" aria-labelledby="rcfd-req-title">
      <header className="rcfd-rail-head">
        <h2 id="rcfd-req-title" className="rcfd-panel-title">Number requests</h2>
      </header>

      {dids.data === undefined ? (
        dids.isError ? (
          <PanelState kind="error" onRetry={() => void dids.refetch()}>Requests couldn’t load.</PanelState>
        ) : (
          <PanelState kind="loading">Loading requests…</PanelState>
        )
      ) : open.length === 0 ? (
        <p className="rcfd-quiet rcfd-rail-body">Nothing waiting on Granite. Need more numbers? Request them any time.</p>
      ) : (
        <div className="rcfd-rail-body">
          <div className="rcfd-req-counts">
            <span>
              <strong>{pending}</strong> waiting for approval
            </span>
            <span>
              <strong>{releasing}</strong> {releasing === 1 ? 'release' : 'releases'} pending
            </span>
          </div>
          <ul className="rcfd-req-list">
            {open.slice(0, REQUEST_PREVIEW).map((d) => (
              <li key={d.id}>
                <span className="rcfd-num rcfd-num-sm">{fmt(d.did)}</span>
                <span className={`rcfd-req-state rcfd-req-${d.status === 'reserved' ? 'pending' : 'release'}`}>
                  <span className="rcfd-dot" aria-hidden="true" />
                  {d.status === 'reserved' ? 'Waiting for approval' : 'Release pending'}
                </span>
              </li>
            ))}
          </ul>
          {open.length > REQUEST_PREVIEW && (
            <p className="rcfd-quiet">And {open.length - REQUEST_PREVIEW} more.</p>
          )}
        </div>
      )}

      <footer className="rcfd-rail-foot">
        <button type="button" className="rcfd-btn rcfd-btn-quiet rcfd-btn-block" onClick={onOpen}>
          {actionLabel}
        </button>
      </footer>
    </section>
  );
}
