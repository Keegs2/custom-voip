/**
 * RoutingBoard — the dashboard's main panel: every number, where it rings,
 * how busy it was this week, and whether it's forwarding.
 *
 *   +1 (217) 352-8498 ━━━━━━━━━━━━━━━━━━━━━ +1 (949) 614-7510   24 calls   ● Forwarding  ⌄
 *   Boston office                            Failover +1 (949)…  96% answered
 *
 * Clicking (or Enter/Space on) a row opens the shared RowEditor inline under
 * it — the same editor, mutations and readonly gating the console has
 * always used. One row open at a time; Esc closes it.
 *
 * Search, the All / Forwarding / Paused chips, sort and paging are all
 * client-side over the full list (GET /rcf returns the whole account in one
 * response). The connector "filament" is azure and faintly lit when the
 * number forwards, dashed slate when paused — status is always also a word.
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { RcfEntry } from '../../types/rcf';
import { fmt } from '../../utils/format';
import { Spinner } from '../../components/ui/Spinner';
import { RowEditor } from './RowEditor';
import { PaginationControls } from './PaginationControls';
import { DEFAULT_PAGE_SIZE } from './theme';
import { numberKey, type NumberStats } from '../dashboard/accountData';

type StatusFilter = 'all' | 'on' | 'off';
type SortKey = 'did' | 'name' | 'forward_to' | 'calls' | 'status';

const SORT_OPTIONS: { id: SortKey; label: string }[] = [
  { id: 'did', label: 'Number' },
  { id: 'name', label: 'Label' },
  { id: 'forward_to', label: 'Destination' },
  { id: 'calls', label: 'Most calls this week' },
  { id: 'status', label: 'Paused first' },
];

export interface RoutingBoardProps {
  entries: readonly RcfEntry[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  /** GET /rcf hit its row cap — some numbers aren't listed. */
  partialOf: number | null;
  stats: NumberStats;
  canEdit: boolean;
  /** Label for the empty-state action, or null when the viewer can't request. */
  requestLabel: string | null;
  onRequest: () => void;
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function callsFor(stats: NumberStats, did: string): number {
  return stats.state === 'ready' ? (stats.byNumber.get(numberKey(did))?.calls ?? 0) : 0;
}

function sortRoutes(rows: RcfEntry[], key: SortKey, stats: NumberStats): RcfEntry[] {
  return [...rows].sort((a, b) => {
    switch (key) {
      case 'name': {
        // Unlabelled numbers sink to the bottom rather than leading the list.
        if (!a.name !== !b.name) return a.name ? -1 : 1;
        return compareText(a.name ?? '', b.name ?? '') || compareText(a.did, b.did);
      }
      case 'forward_to':
        return compareText(a.forward_to, b.forward_to) || compareText(a.did, b.did);
      case 'calls':
        return callsFor(stats, b.did) - callsFor(stats, a.did) || compareText(a.did, b.did);
      case 'status':
        return Number(a.enabled) - Number(b.enabled) || compareText(a.did, b.did);
      case 'did':
      default:
        return compareText(a.did, b.did);
    }
  });
}

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

// ─── One route ───────────────────────────────────────────────────────────────

interface RouteRowProps {
  entry: RcfEntry;
  index: number;
  stats: NumberStats;
  open: boolean;
  canEdit: boolean;
  onToggle: () => void;
  onClose: () => void;
}

function WeekFigures({ stats, did }: { stats: NumberStats; did: string }) {
  if (stats.state === 'loading') {
    return (
      <span className="rcfd-route-kpi">
        <span className="rcfd-skel rcfd-skel-light" aria-label="Loading" />
      </span>
    );
  }
  if (stats.state === 'unavailable') {
    return <span className="rcfd-route-kpi rcfd-route-kpi-none">—</span>;
  }
  const row = stats.byNumber.get(numberKey(did));
  if (!row || row.calls === 0) {
    return (
      <span className="rcfd-route-kpi rcfd-route-kpi-none">
        <span className="rcfd-route-kpi-main">No calls</span>
        <span className="rcfd-route-kpi-sub">this week</span>
      </span>
    );
  }
  return (
    <span className="rcfd-route-kpi">
      <span className="rcfd-route-kpi-main">
        {row.calls.toLocaleString()} {row.calls === 1 ? 'call' : 'calls'}
      </span>
      <span className="rcfd-route-kpi-sub">
        {row.answer_rate_pct == null ? 'None answered' : `${Math.round(row.answer_rate_pct)}% answered`}
      </span>
    </span>
  );
}

function RouteRow({ entry, index, stats, open, canEdit, onToggle, onClose }: RouteRowProps) {
  const state = entry.enabled ? 'on' : 'off';
  const editorId = `rcfd-editor-${entry.id}`;
  return (
    <li
      className={`rcfd-route rcfd-route-${state}${open ? ' rcfd-route-open' : ''}`}
      style={{ '--i': Math.min(index, 14) } as CSSProperties}
    >
      <div
        className="rcfd-route-main"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-controls={open ? editorId : undefined}
        aria-label={`${fmt(entry.did)}${entry.name ? `, ${entry.name}` : ''}, ${
          entry.enabled ? 'forwarding' : 'paused'
        } to ${fmt(entry.forward_to)}. ${canEdit ? 'Edit' : 'View'} settings`}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          } else if (e.key === 'Escape' && open) {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <span className="rcfd-route-from">
          <span className="rcfd-num">{fmt(entry.did)}</span>
          <span className={`rcfd-route-label${entry.name ? '' : ' rcfd-route-label-empty'}`}>
            {entry.name ?? 'No label'}
          </span>
        </span>

        <span className="rcfd-filament" aria-hidden="true">
          <span className="rcfd-filament-line" />
          <svg className="rcfd-filament-head" viewBox="0 0 8 10">
            <path d="M1 1l5 4-5 4" fill="none" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>

        <span className="rcfd-route-to">
          <span className="rcfd-num rcfd-num-dest">{fmt(entry.forward_to)}</span>
          <span className="rcfd-route-label">
            {entry.failover_to ? `Failover ${fmt(entry.failover_to)}` : `Rings for ${entry.ring_timeout}s`}
          </span>
        </span>

        <WeekFigures stats={stats} did={entry.did} />

        <span className={`rcfd-status rcfd-status-${state}`}>
          <span className="rcfd-dot" aria-hidden="true" />
          {entry.enabled ? 'Forwarding' : 'Paused'}
        </span>

        <svg className="rcfd-chev" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      {open && (
        <div id={editorId} className="rcfd-route-editor rcf-xwrap">
          <div>
            <RowEditor entry={entry} isAdmin={false} canEdit={canEdit} onClose={onClose} />
          </div>
        </div>
      )}
    </li>
  );
}

// ─── Board ───────────────────────────────────────────────────────────────────

export function RoutingBoard({
  entries,
  loading,
  error,
  onRetry,
  partialOf,
  stats,
  canEdit,
  requestLabel,
  onRequest,
}: RoutingBoardProps) {
  // ALL hooks unconditionally at the top (React #310).
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [sortKey, setSortKey] = useState<SortKey>('did');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [openId, setOpenId] = useState<number | null>(null);
  // The filaments "light up" once, on the first render that has rows. Rows
  // that mount later (paging, filtering) appear already lit.
  const [intro, setIntro] = useState<'pending' | 'playing' | 'done'>('pending');
  if (entries.length > 0 && intro === 'pending') setIntro('playing');

  useEffect(() => {
    if (intro !== 'playing') return;
    const t = window.setTimeout(() => setIntro('done'), 900);
    return () => window.clearTimeout(t);
  }, [intro]);

  const counts = useMemo(() => {
    const on = entries.filter((e) => e.enabled).length;
    return { all: entries.length, on, off: entries.length - on };
  }, [entries]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, '');
    const filtered = entries.filter(
      (e) => (filter === 'all' || (filter === 'on') === e.enabled) && matches(e, q, qDigits),
    );
    return sortRoutes(filtered, sortKey, stats);
  }, [entries, search, filter, sortKey, stats]);

  const totalPages = Math.max(1, Math.ceil(visible.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = visible.slice((safePage - 1) * pageSize, safePage * pageSize);
  const filtersActive = search.trim() !== '' || filter !== 'all';

  function resetPaging(): void {
    setPage(1);
    setOpenId(null);
  }

  function clearFilters(): void {
    setSearch('');
    setFilter('all');
    resetPaging();
  }

  const chips: { id: StatusFilter; label: string; count: number }[] = [
    { id: 'all', label: 'All', count: counts.all },
    { id: 'on', label: 'Forwarding', count: counts.on },
    { id: 'off', label: 'Paused', count: counts.off },
  ];

  return (
    <section className="rcfd-panel rcfd-board" aria-labelledby="rcfd-board-title">
      <header className="rcfd-board-head">
        <div className="rcfd-board-titles">
          <h2 id="rcfd-board-title" className="rcfd-panel-title">Your numbers</h2>
          <p className="rcfd-panel-sub">
            {canEdit ? 'Select a number to change where it rings.' : 'Select a number to see its settings.'}
          </p>
        </div>

        <div className="rcfd-board-tools">
          <label className="rcfd-search">
            <span className="rcfd-visually-hidden">Search numbers</span>
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path d="m19 19-4.35-4.35M15 9A6 6 0 1 1 3 9a6 6 0 0 1 12 0Z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <input
              type="search"
              value={search}
              placeholder="Search number, label or destination"
              onChange={(e) => {
                setSearch(e.target.value);
                resetPaging();
              }}
            />
          </label>

          <div className="rcfd-chips" role="group" aria-label="Show">
            {chips.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`rcfd-chip${filter === c.id ? ' rcfd-chip-active' : ''}`}
                aria-pressed={filter === c.id}
                onClick={() => {
                  setFilter(c.id);
                  resetPaging();
                }}
              >
                {c.label}
                <span className="rcfd-chip-count">{c.count}</span>
              </button>
            ))}
          </div>

          <label className="rcfd-sort">
            <span>Sort by</span>
            <select
              value={sortKey}
              onChange={(e) => {
                setSortKey(e.target.value as SortKey);
                resetPaging();
              }}
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.id} value={o.id} disabled={o.id === 'calls' && stats.state !== 'ready'}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      {loading ? (
        <div className="rcfd-state">
          <Spinner size="sm" />
          <span>Loading your numbers…</span>
        </div>
      ) : error ? (
        <div className="rcfd-state rcfd-state-error" role="alert">
          <span>We couldn’t load your numbers.</span>
          <button type="button" className="rcfd-btn rcfd-btn-quiet" onClick={onRetry}>
            Try again
          </button>
        </div>
      ) : entries.length === 0 ? (
        <div className="rcfd-empty">
          <p className="rcfd-empty-title">No numbers on this account yet</p>
          <p className="rcfd-empty-sub">
            {requestLabel
              ? 'Request numbers and they’ll appear here once Granite assigns them.'
              : 'Numbers appear here once Granite assigns them to your account.'}
          </p>
          {requestLabel && (
            <button type="button" className="rcfd-btn rcfd-btn-primary" onClick={onRequest}>
              {requestLabel}
            </button>
          )}
        </div>
      ) : visible.length === 0 ? (
        <div className="rcfd-empty">
          <p className="rcfd-empty-title">
            {search.trim() ? `No numbers match “${search.trim()}”` : 'No numbers in this view'}
          </p>
          <p className="rcfd-empty-sub">Try a different search or show all numbers.</p>
          {filtersActive && (
            <button type="button" className="rcfd-btn rcfd-btn-quiet" onClick={clearFilters}>
              Clear search and filters
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="rcfd-routes-cols" aria-hidden="true">
            <span>Number</span>
            <span />
            <span>Forwards to</span>
            <span>Last 7 days</span>
            <span>Status</span>
            <span />
          </div>
          <ul className={`rcfd-routes${intro === 'playing' ? ' rcfd-routes-intro' : ''}`}>
            {pageRows.map((entry, i) => (
              <RouteRow
                key={entry.id}
                entry={entry}
                index={i}
                stats={stats}
                open={openId === entry.id}
                canEdit={canEdit}
                onToggle={() => setOpenId((cur) => (cur === entry.id ? null : entry.id))}
                onClose={() => setOpenId(null)}
              />
            ))}
          </ul>
          {visible.length > 10 && (
            <PaginationControls
              currentPage={safePage}
              totalPages={totalPages}
              pageSize={pageSize}
              totalItems={visible.length}
              onPageChange={(p) => {
                setPage(p);
                setOpenId(null);
              }}
              onPageSizeChange={(size) => {
                setPageSize(size);
                resetPaging();
              }}
            />
          )}
          {partialOf !== null && (
            <p className="rcfd-board-foot">
              Showing the first {entries.length} of {partialOf.toLocaleString()} numbers on your account. Contact Granite
              support to change a number that isn’t listed here.
            </p>
          )}
        </>
      )}
    </section>
  );
}
