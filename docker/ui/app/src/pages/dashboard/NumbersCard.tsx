/**
 * NumbersCard — the dashboard's small numbers table: search, All /
 * Forwarding / Paused chips, the first 8 matching numbers, and a way to the
 * full manager on /rcf.
 *
 *   Number              Forwards to          Last 7 days     Status
 *   +1 (217) 352-8498   +1 (949) 614-7510    24 calls        ● Forwarding   ⌄
 *   Boston office       Failover …           96% answered
 *
 * Selecting a row (click, Enter or Space) opens the shared RowEditor right
 * under it — the same editor, mutations and readonly gating as /rcf. One
 * row open at a time; Esc closes it.
 *
 * Staff (the admin dashboard's one-customer view) get the admin RowEditor
 * fields (e.g. max channels) via `isAdmin`, and "View all" goes to the
 * admin console scoped to the customer via `allHref`.
 */
import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Hash } from 'lucide-react';
import type { RcfEntry } from '../../types/rcf';
import { fmt } from '../../utils/format';
import { RowEditor } from '../rcf/RowEditor';
import { Card, CardState } from './Card';
import { numberKey, type NumberStats } from './accountData';

const PREVIEW_ROWS = 8;

type StatusFilter = 'all' | 'on' | 'off';

function matches(entry: RcfEntry, q: string, qDigits: string): boolean {
  if (!q) return true;
  if ((entry.name ?? '').toLowerCase().includes(q)) return true;
  if (qDigits.length >= 2) {
    const digits = (s: string) => s.replace(/\D/g, '');
    if (digits(entry.did).includes(qDigits)) return true;
    if (digits(entry.forward_to).includes(qDigits)) return true;
    if (entry.failover_to && digits(entry.failover_to).includes(qDigits)) return true;
  }
  return entry.did.includes(q) || entry.forward_to.toLowerCase().includes(q);
}

function WeekCell({ stats, did }: { stats: NumberStats; did: string }) {
  if (stats.state === 'loading') return <span className="ad-skel ad-skel-sm" aria-label="Loading" />;
  if (stats.state === 'unavailable') return <span className="ad-faint">—</span>;
  const row = stats.byNumber.get(numberKey(did));
  if (!row || row.calls === 0) return <span className="ad-faint">No calls</span>;
  return (
    <span className="ad-stack">
      <span className="ad-strong">
        {row.calls.toLocaleString()} {row.calls === 1 ? 'call' : 'calls'}
      </span>
      <span className="ad-faint">
        {row.answer_rate_pct == null ? 'None answered' : `${Math.round(row.answer_rate_pct)}% answered`}
      </span>
    </span>
  );
}

export interface NumbersCardProps {
  entries: readonly RcfEntry[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  stats: NumberStats;
  canEdit: boolean;
  /** Numbers on the account, for "View all N numbers". */
  total: number | null;
  /** Empty-state action label, or null when the viewer can't request. */
  requestLabel: string | null;
  onRequest: () => void;
  order: number;
  /** Card title (default "Your numbers"). */
  title?: string;
  /** Show the admin-only RowEditor fields (real admin, not in customer view). */
  isAdmin?: boolean;
  /** Where "View all N numbers" goes (default /rcf). */
  allHref?: string;
}

export function NumbersCard({
  entries,
  loading,
  error,
  onRetry,
  stats,
  canEdit,
  total,
  requestLabel,
  onRequest,
  order,
  title = 'Your numbers',
  isAdmin = false,
  allHref = '/rcf',
}: NumbersCardProps) {
  // ALL hooks unconditionally at the top (React #310).
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [openId, setOpenId] = useState<number | null>(null);

  const counts = useMemo(() => {
    const on = entries.filter((e) => e.enabled).length;
    return { all: entries.length, on, off: entries.length - on };
  }, [entries]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, '');
    return entries
      .filter((e) => (filter === 'all' || (filter === 'on') === e.enabled) && matches(e, q, qDigits))
      .sort((a, b) => a.did.localeCompare(b.did, undefined, { numeric: true }));
  }, [entries, search, filter]);

  const rows = visible.slice(0, PREVIEW_ROWS);
  const allCount = total ?? entries.length;
  const filtersActive = search.trim() !== '' || filter !== 'all';

  const chips: { id: StatusFilter; label: string; count: number }[] = [
    { id: 'all', label: 'All', count: counts.all },
    { id: 'on', label: 'Forwarding', count: counts.on },
    { id: 'off', label: 'Paused', count: counts.off },
  ];

  const footer =
    entries.length > 0 ? (
      <div className="ad-foot-split">
        <span className="ad-faint">
          {filtersActive
            ? `${Math.min(rows.length, visible.length)} of ${visible.length.toLocaleString()} matching`
            : `Showing ${rows.length} of ${allCount.toLocaleString()}`}
        </span>
        <Link to={allHref} className="ad-linkbtn ad-linkbtn-arrow">
          View all {allCount.toLocaleString()} numbers
          <ArrowRight size={14} aria-hidden="true" />
        </Link>
      </div>
    ) : null;

  return (
    <Card
      id="ad-numbers"
      title={title}
      icon={<Hash size={15} strokeWidth={2.2} />}
      count={entries.length > 0 ? allCount : null}
      sub={canEdit ? 'Select a number to change where it rings.' : 'Select a number to see its settings.'}
      className="ad-span-8 ad-card-numbers"
      order={order}
      footer={footer}
    >
      {entries.length > 0 && (
        <div className="ad-toolbar">
          <label className="ad-search">
            <span className="ad-visually-hidden">Search numbers</span>
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path d="m19 19-4.35-4.35M15 9A6 6 0 1 1 3 9a6 6 0 0 1 12 0Z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <input
              type="search"
              value={search}
              placeholder="Search number, label or destination"
              onChange={(e) => {
                setSearch(e.target.value);
                setOpenId(null);
              }}
            />
          </label>
          <div className="ad-chips" role="group" aria-label="Show">
            {chips.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`ad-chipbtn${filter === c.id ? ' ad-chipbtn-active' : ''}`}
                aria-pressed={filter === c.id}
                onClick={() => {
                  setFilter(c.id);
                  setOpenId(null);
                }}
              >
                {c.label}
                <span className="ad-chipbtn-count">{c.count}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <CardState kind="loading">Loading numbers…</CardState>
      ) : error ? (
        <CardState kind="error" onRetry={onRetry}>We couldn’t load the numbers.</CardState>
      ) : entries.length === 0 ? (
        <div className="ad-empty">
          <p className="ad-empty-title">No numbers on this account yet</p>
          <p className="ad-empty-sub">
            {requestLabel
              ? 'Request numbers and they’ll appear here once Granite assigns them.'
              : 'Numbers appear here once Granite assigns them to the account.'}
          </p>
          {requestLabel && (
            <button type="button" className="ad-btn ad-btn-primary" onClick={onRequest}>
              {requestLabel}
            </button>
          )}
        </div>
      ) : rows.length === 0 ? (
        <div className="ad-empty">
          <p className="ad-empty-title">
            {search.trim() ? `No numbers match “${search.trim()}”` : 'No numbers in this view'}
          </p>
          <button
            type="button"
            className="ad-btn ad-btn-quiet"
            onClick={() => {
              setSearch('');
              setFilter('all');
            }}
          >
            Clear search and filters
          </button>
        </div>
      ) : (
        <div className="ad-tablewrap">
          <table className="ad-table ad-numtable">
            <thead>
              <tr>
                <th scope="col">Number</th>
                <th scope="col">Forwards to</th>
                <th scope="col" className="ad-col-week">Last 7 days</th>
                <th scope="col">Status</th>
                <th scope="col" className="ad-col-chev"><span className="ad-visually-hidden">Details</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((entry) => {
                const open = openId === entry.id;
                const editorId = `ad-editor-${entry.id}`;
                const toggle = () => setOpenId((cur) => (cur === entry.id ? null : entry.id));
                return (
                  <Fragment key={entry.id}>
                    <tr
                      className={`ad-row${open ? ' ad-row-open' : ''}`}
                      tabIndex={0}
                      aria-expanded={open}
                      aria-controls={open ? editorId : undefined}
                      aria-label={`${fmt(entry.did)}${entry.name ? `, ${entry.name}` : ''}, ${
                        entry.enabled ? 'forwarding' : 'paused'
                      } to ${fmt(entry.forward_to)}. ${canEdit ? 'Edit' : 'View'} settings`}
                      onClick={toggle}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget) return;
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          toggle();
                        } else if (e.key === 'Escape' && open) {
                          e.preventDefault();
                          setOpenId(null);
                        }
                      }}
                    >
                      <td>
                        <span className="ad-stack">
                          <span className="ad-num">{fmt(entry.did)}</span>
                          <span className={entry.name ? 'ad-faint' : 'ad-faint ad-italic'}>{entry.name ?? 'No label'}</span>
                        </span>
                      </td>
                      <td>
                        <span className="ad-stack">
                          <span className="ad-num ad-num-dest">{fmt(entry.forward_to)}</span>
                          <span className="ad-faint">
                            {entry.failover_to ? `Failover ${fmt(entry.failover_to)}` : `Rings ${entry.ring_timeout}s`}
                          </span>
                        </span>
                      </td>
                      <td className="ad-col-week">
                        <WeekCell stats={stats} did={entry.did} />
                      </td>
                      <td>
                        <span className={`ad-status ad-status-${entry.enabled ? 'on' : 'off'}`}>
                          <span className="ad-dot" aria-hidden="true" />
                          {entry.enabled ? 'Forwarding' : 'Paused'}
                        </span>
                      </td>
                      <td className="ad-col-chev">
                        <svg className="ad-chev" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </td>
                    </tr>
                    {open && (
                      <tr className="ad-editor-row">
                        <td colSpan={5} id={editorId}>
                          <div className="ad-editor rcf-xwrap">
                            <div>
                              <RowEditor entry={entry} isAdmin={isAdmin} canEdit={canEdit} onClose={() => setOpenId(null)} />
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
