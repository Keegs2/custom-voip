/**
 * NumbersCard — the dashboard's small numbers table: search, filter chips,
 * the first 8 matching numbers, and a way to the full call forwarding
 * manager on /rcf. It lists EVERY product's numbers (accountData
 * `toNumberRows`), one row kind per product:
 *
 *   Number              Forwards to /           Last 7 days     Status
 *                       Where calls go
 *   +1 (217) 352-8498   +1 (949) 614-7510       24 calls        ● Forwarding        ⌄   rcf: RowEditor
 *   Boston office       Failover …              96% answered
 *   +1 (508) 555-0100   Voicemail               3 calls         ● Taking messages   →   voicemail: link
 *   Voicemail           Callers leave a message
 *   +1 (617) 555-0202   Your phone system       —               ● Active                trunk: static
 *   alpha               SIP trunk
 *
 * - rcf: selecting a row (click, Enter or Space) opens the shared RowEditor
 *   right under it — the same editor, mutations and readonly gating as
 *   /rcf. One row open at a time; Esc closes it. Past the /rcf list cap a
 *   row has no editor and says where to manage it.
 * - voicemail: the row is a link to the voicemail page (`row.href`).
 * - trunk and any other product: a plain, non-interactive row whose words
 *   come from config/products.ts (unknown products get its fallback).
 *
 * A call-forwarding-only account renders exactly as before: header
 * "Forwards to", chips All / Forwarding / Paused, "View all N numbers".
 * With other products the header reads "Where calls go", a chip per other
 * product joins (Forwarding / Paused only when there are rcf numbers), and
 * the footer link becomes "Manage call forwarding".
 *
 * Staff (the admin dashboard's one-customer view) get the admin RowEditor
 * fields (e.g. max channels) via `isAdmin`, and the footer link goes to the
 * admin console scoped to the customer via `allHref`.
 */
import { Fragment, useMemo, useState, type KeyboardEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Hash } from 'lucide-react';
import { compareProducts, productInfo } from '../../config/products';
import { fmt } from '../../utils/format';
import { RowEditor } from '../rcf/RowEditor';
import { Card, CardState } from './Card';
import { numberKey, type NumberRow, type NumberStats } from './accountData';

const PREVIEW_ROWS = 8;

/** all · rcf on / off · one product (`p:voicemail`). */
type RowFilter = 'all' | 'on' | 'off' | `p:${string}`;

interface Chip {
  id: RowFilter;
  label: string;
  count: number;
}

const digitsOf = (s: string) => s.replace(/\D/g, '');

function matches(row: NumberRow, q: string, qDigits: string): boolean {
  if (!q) return true;
  if ((row.name ?? '').toLowerCase().includes(q)) return true;
  // "voicemail" / "trunk" find those rows (rcf rows match as before).
  if (row.product !== 'rcf' && productInfo(row.product).label.toLowerCase().includes(q)) return true;
  if (qDigits.length >= 2) {
    if (digitsOf(row.number).includes(qDigits)) return true;
    if (row.forwardsTo && digitsOf(row.forwardsTo).includes(qDigits)) return true;
    if (row.rcf?.failover_to && digitsOf(row.rcf.failover_to).includes(qDigits)) return true;
  }
  return row.number.includes(q) || (row.forwardsTo ?? '').toLowerCase().includes(q);
}

function passes(row: NumberRow, filter: RowFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'on' || filter === 'off') return row.product === 'rcf' && (filter === 'on') === row.enabled;
  return row.product === filter.slice(2);
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

function NumberCell({ row }: { row: NumberRow }) {
  return (
    <span className="ad-stack">
      <span className="ad-num">{fmt(row.number)}</span>
      <span className={row.name ? 'ad-faint' : 'ad-faint ad-italic'}>{row.name ?? 'No label'}</span>
    </span>
  );
}

function StatusCell({ row }: { row: NumberRow }) {
  const info = productInfo(row.product);
  return (
    <span className={`ad-status ad-status-${row.enabled ? 'on' : 'off'}`}>
      <span className="ad-dot" aria-hidden="true" />
      {row.enabled ? info.onWord : info.offWord}
    </span>
  );
}

/** "Where calls go" for a non-forwarding number: catalog words (voicemail → "Voicemail"). */
function DestinationCell({ row }: { row: NumberRow }) {
  const info = productInfo(row.product);
  const main = info.destination?.main ?? info.label;
  const sub = info.destination?.sub ?? null;
  return (
    <span className="ad-stack">
      <span className="ad-dest-main">{main}</span>
      {sub && <span className="ad-faint">{sub}</span>}
    </span>
  );
}

const CHEV_DOWN = (
  <svg className="ad-chev" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const CHEV_GO = (
  <svg className="ad-chev ad-chev-go" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export interface NumbersCardProps {
  /** Every number on the account, any product (accountData `toNumberRows`). */
  rows: readonly NumberRow[];
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
  /** The call forwarding manager the footer links to (default /rcf). */
  allHref?: string;
}

export function NumbersCard({
  rows: allRows,
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
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<RowFilter>('all');
  /** The number whose RowEditor is open (rcf rows only). */
  const [openNumber, setOpenNumber] = useState<string | null>(null);

  const chips = useMemo<Chip[]>(() => {
    const rcf = allRows.filter((r) => r.product === 'rcf');
    const on = rcf.filter((r) => r.enabled).length;
    const others = new Map<string, number>();
    for (const r of allRows) if (r.product !== 'rcf') others.set(r.product, (others.get(r.product) ?? 0) + 1);
    const list: Chip[] = [{ id: 'all', label: 'All', count: allRows.length }];
    // Forwarding / Paused only mean something for call forwarding numbers —
    // shown whenever there are any, and always on an account with no other
    // product (so an empty RCF account keeps today's three chips).
    if (rcf.length > 0 || others.size === 0) {
      list.push({ id: 'on', label: 'Forwarding', count: on }, { id: 'off', label: 'Paused', count: rcf.length - on });
    }
    for (const product of [...others.keys()].sort(compareProducts)) {
      list.push({ id: `p:${product}`, label: productInfo(product).label, count: others.get(product) ?? 0 });
    }
    return list;
  }, [allRows]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, '');
    return allRows
      .filter((r) => passes(r, filter) && matches(r, q, qDigits))
      .sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
  }, [allRows, search, filter]);

  // ── Derived (after all hooks) ──
  const rows = visible.slice(0, PREVIEW_ROWS);
  const allCount = total ?? allRows.length;
  const filtersActive = search.trim() !== '' || filter !== 'all';
  const hasRcf = allRows.some((r) => r.product === 'rcf');
  const onlyRcf = allRows.every((r) => r.product === 'rcf');
  const hasVoicemailLinks = allRows.some((r) => r.href !== null);

  const baseSub = canEdit ? 'Select a number to change where it rings' : 'Select a number to see its settings';
  const sub = hasVoicemailLinks ? `${baseSub}, or open its voicemail.` : `${baseSub}.`;

  const footerLink = onlyRcf ? (
    <Link to={allHref} className="ad-linkbtn ad-linkbtn-arrow">
      View all {allCount.toLocaleString()} numbers
      <ArrowRight size={14} aria-hidden="true" />
    </Link>
  ) : hasRcf ? (
    <Link to={allHref} className="ad-linkbtn ad-linkbtn-arrow">
      Manage call forwarding
      <ArrowRight size={14} aria-hidden="true" />
    </Link>
  ) : null;

  const footer =
    allRows.length > 0 ? (
      <div className="ad-foot-split">
        <span className="ad-faint">
          {filtersActive
            ? `${Math.min(rows.length, visible.length)} of ${visible.length.toLocaleString()} matching`
            : `Showing ${rows.length} of ${allCount.toLocaleString()}`}
        </span>
        {footerLink}
      </div>
    ) : null;

  function pickFilter(next: RowFilter): void {
    setFilter(next);
    setOpenNumber(null);
  }

  function renderRcfRow(row: NumberRow) {
    const entry = row.rcf;
    if (!entry) {
      // Past the /rcf list cap: no editor here, so say where it lives.
      return (
        <tr key={row.number} className="ad-row ad-row-static">
          <td><NumberCell row={row} /></td>
          <td>
            <span className="ad-stack">
              <span className="ad-num ad-num-dest">{row.forwardsTo ? fmt(row.forwardsTo) : '—'}</span>
              <Link to={allHref} className="ad-faint ad-row-hint">Manage in call forwarding</Link>
            </span>
          </td>
          <td className="ad-col-week"><WeekCell stats={stats} did={row.number} /></td>
          <td><StatusCell row={row} /></td>
          <td className="ad-col-chev" />
        </tr>
      );
    }
    const open = openNumber === row.number;
    const editorId = `ad-editor-${entry.id}`;
    const toggle = () => setOpenNumber((cur) => (cur === row.number ? null : row.number));
    return (
      <Fragment key={row.number}>
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
              setOpenNumber(null);
            }
          }}
        >
          <td><NumberCell row={row} /></td>
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
          <td><StatusCell row={row} /></td>
          <td className="ad-col-chev">{CHEV_DOWN}</td>
        </tr>
        {open && (
          <tr className="ad-editor-row">
            <td colSpan={5} id={editorId}>
              <div className="ad-editor rcf-xwrap">
                <div>
                  <RowEditor entry={entry} isAdmin={isAdmin} canEdit={canEdit} onClose={() => setOpenNumber(null)} />
                </div>
              </div>
            </td>
          </tr>
        )}
      </Fragment>
    );
  }

  function renderOtherRow(row: NumberRow) {
    const info = productInfo(row.product);
    const cells = (
      <>
        <td><NumberCell row={row} /></td>
        <td><DestinationCell row={row} /></td>
        <td className="ad-col-week"><WeekCell stats={stats} did={row.number} /></td>
        <td><StatusCell row={row} /></td>
        <td className="ad-col-chev">{row.href ? CHEV_GO : null}</td>
      </>
    );
    const href = row.href;
    if (!href) {
      return (
        <tr key={row.number} className="ad-row ad-row-static">
          {cells}
        </tr>
      );
    }
    const word = info.label.toLowerCase();
    const go = () => navigate(href);
    return (
      <tr
        key={row.number}
        className="ad-row ad-row-link"
        tabIndex={0}
        aria-label={`${fmt(row.number)}${row.name ? `, ${row.name}` : ''}, ${word}. Open ${word}`}
        onClick={go}
        onKeyDown={(e: KeyboardEvent<HTMLTableRowElement>) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            go();
          }
        }}
      >
        {cells}
      </tr>
    );
  }

  return (
    <Card
      id="ad-numbers"
      title={title}
      icon={<Hash size={15} strokeWidth={2.2} />}
      count={allRows.length > 0 ? allCount : null}
      sub={sub}
      className="ad-span-8 ad-card-numbers"
      order={order}
      footer={footer}
    >
      {allRows.length > 0 && (
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
                setOpenNumber(null);
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
                onClick={() => pickFilter(c.id)}
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
      ) : allRows.length === 0 ? (
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
                <th scope="col">{onlyRcf ? 'Forwards to' : 'Where calls go'}</th>
                <th scope="col" className="ad-col-week">Last 7 days</th>
                <th scope="col">Status</th>
                <th scope="col" className="ad-col-chev"><span className="ad-visually-hidden">Details</span></th>
              </tr>
            </thead>
            <tbody>{rows.map((row) => (row.product === 'rcf' ? renderRcfRow(row) : renderOtherRow(row)))}</tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
