/**
 * AdminCards — the cards only the admin's All customers view has:
 *
 *   CustomersCard   every call forwarding customer: type · status · numbers
 *                   (every product; hover for the mix) · paused; a row opens
 *                   that customer's dashboard
 *   PausedCard      numbers not forwarding right now, across customers
 *   InventoryCard   the number pool: available / assigned / one line per
 *                   product / waiting / releasing
 *
 * Same Card surface, table look and tokens as the customer cards
 * (account-dashboard.css). Status is always a word + colour. No money.
 */
import { useMemo, useState } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { Boxes, Building2, PauseCircle } from 'lucide-react';
import type { RcfListResponse } from '../../api/rcf';
import { compareProducts, isProductHidden, mixSentence, productLabel } from '../../config/products';
import type { CustomerStatus } from '../../types/customer';
import { fmt } from '../../utils/format';
import { Card, CardState } from './Card';
import { CustomerName } from './CallCards';
import { fmtMonthYear } from './accountData';
import { PAUSED_CAP, type CustomerRow, type InventoryStats, type PlatformNumberCounts } from './adminData';

const STATUS_WORD: Record<CustomerStatus, string> = {
  active: 'Active',
  suspended: 'Suspended',
  closed: 'Closed',
};

const TYPE_WORD: Record<CustomerRow['account_type'], string> = {
  rcf: 'Call forwarding',
  hybrid: 'Forwarding + SIP',
  ucaas: 'UCaaS',
  trunk: 'SIP Trunking',
  api: 'API Calling',
};

const CUSTOMER_PREVIEW = 8;

/** "10 forwarding · 1 voicemail · 1 SIP trunk" — only worth a tooltip with 2+ products. */
function mixTitle(mix: PlatformNumberCounts['mix']): string | undefined {
  return mix && mix.length > 1 ? mixSentence(mix) : undefined;
}

// ─── Customers ───────────────────────────────────────────────────────────────

export interface CustomersCardProps {
  customers: readonly CustomerRow[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  /** Numbers per customer (every product), or null while they load / if they failed. */
  numbers: PlatformNumberCounts | null;
  numbersState: 'loading' | 'error' | 'ready';
  /** Paused numbers per customer (lower bounds when `pausedPartial`). */
  paused: ReadonlyMap<number, number> | null;
  pausedPartial: boolean;
  pausedError: boolean;
  onPick: (customerId: number) => void;
  order: number;
}

function CountCell({
  value,
  state,
  partial,
  zeroText,
  title,
}: {
  value: number | undefined;
  state: 'loading' | 'error' | 'ready';
  partial: boolean;
  zeroText: string;
  /** Hover text, e.g. the product mix behind a total. */
  title?: string;
}) {
  if (state === 'loading') return <span className="ad-skel ad-skel-sm" aria-label="Loading" />;
  if (state === 'error') return <span className="ad-faint" title="Couldn’t load right now">—</span>;
  const n = value ?? 0;
  if (n === 0 && !partial) return <span className="ad-faint">{zeroText}</span>;
  return (
    <span className="ad-strong" title={title}>
      {n.toLocaleString()}
      {partial ? '+' : ''}
    </span>
  );
}

export function CustomersCard({
  customers,
  loading,
  error,
  onRetry,
  numbers,
  numbersState,
  paused,
  pausedPartial,
  pausedError,
  onPick,
  order,
}: CustomersCardProps) {
  // ALL hooks unconditionally at the top (React #310).
  const [search, setSearch] = useState('');
  const [showAll, setShowAll] = useState(false);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter((c) => c.name.toLowerCase().includes(q) || String(c.id) === q);
  }, [customers, search]);

  const rows = showAll || search.trim() ? visible : visible.slice(0, CUSTOMER_PREVIEW);
  const pausedState: 'loading' | 'error' | 'ready' = paused ? 'ready' : pausedError ? 'error' : 'loading';

  const footer =
    customers.length > CUSTOMER_PREVIEW && !search.trim() ? (
      <div className="ad-foot-split">
        <span className="ad-faint">
          Showing {rows.length} of {customers.length.toLocaleString()}
        </span>
        <button type="button" className="ad-linkbtn" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
          {showAll ? 'Show fewer' : `Show all ${customers.length.toLocaleString()}`}
        </button>
      </div>
    ) : undefined;

  return (
    <Card
      id="ad-customers"
      title="Customers"
      icon={<Building2 size={15} strokeWidth={2.2} />}
      count={customers.length > 0 ? customers.length : null}
      sub="Select a customer to open their dashboard."
      className="ad-span-8 ad-card-numbers ad-card-customers"
      order={order}
      footer={footer}
    >
      {customers.length > CUSTOMER_PREVIEW && (
        <div className="ad-toolbar">
          <label className="ad-search">
            <span className="ad-visually-hidden">Search customers</span>
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path d="m19 19-4.35-4.35M15 9A6 6 0 1 1 3 9a6 6 0 0 1 12 0Z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <input
              type="search"
              value={search}
              placeholder="Search customers"
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
        </div>
      )}

      {loading ? (
        <CardState kind="loading">Loading customers…</CardState>
      ) : error && customers.length === 0 ? (
        <CardState kind="error" onRetry={onRetry}>We couldn’t load the customer list.</CardState>
      ) : customers.length === 0 ? (
        <div className="ad-empty">
          <p className="ad-empty-title">No call forwarding customers yet</p>
          <p className="ad-empty-sub">Customers are created and onboarded in TED.</p>
        </div>
      ) : rows.length === 0 ? (
        <div className="ad-empty">
          <p className="ad-empty-title">No customers match “{search.trim()}”</p>
          <button type="button" className="ad-btn ad-btn-quiet" onClick={() => setSearch('')}>
            Clear search
          </button>
        </div>
      ) : (
        <div className="ad-tablewrap">
          <table className="ad-table ad-custtable">
            <thead>
              <tr>
                <th scope="col">Customer</th>
                <th scope="col" className="ad-col-type">Type</th>
                <th scope="col">Status</th>
                <th scope="col" className="ad-col-num">Numbers</th>
                <th scope="col" className="ad-col-num">Paused</th>
                <th scope="col" className="ad-col-chev"><span className="ad-visually-hidden">Open</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const since = fmtMonthYear(c.created_at);
                const tone = c.status === 'active' ? 'on' : 'off';
                return (
                  <tr
                    key={c.id}
                    className="ad-row"
                    tabIndex={0}
                    aria-label={`${c.name}, ${STATUS_WORD[c.status] ?? c.status}. Open dashboard`}
                    onClick={() => onPick(c.id)}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onPick(c.id);
                      }
                    }}
                  >
                    <td>
                      <span className="ad-stack">
                        <span className="ad-custname">{c.name}</span>
                        <span className="ad-faint">{since ? `Since ${since}` : `#${c.id}`}</span>
                      </span>
                    </td>
                    <td className="ad-col-type">
                      <span className="ad-typeword">{TYPE_WORD[c.account_type] ?? c.account_type}</span>
                    </td>
                    <td>
                      <span className={`ad-status ad-status-${tone}`}>
                        <span className="ad-dot" aria-hidden="true" />
                        {STATUS_WORD[c.status] ?? c.status}
                      </span>
                    </td>
                    <td className="ad-col-num">
                      <CountCell
                        value={numbers?.byCustomer.get(c.id)}
                        state={numbersState}
                        partial={numbers?.partial ?? false}
                        zeroText="None"
                        title={mixTitle(numbers?.mixByCustomer?.get(c.id))}
                      />
                    </td>
                    <td className="ad-col-num">
                      <CountCell
                        value={paused?.get(c.id)}
                        state={pausedState}
                        // A capped paused list makes a non-zero count a lower bound.
                        partial={pausedPartial && (paused?.get(c.id) ?? 0) > 0}
                        zeroText="None"
                      />
                    </td>
                    <td className="ad-col-chev">
                      <svg className="ad-chev ad-chev-go" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
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

// ─── Paused numbers ──────────────────────────────────────────────────────────

const PAUSED_PREVIEW = 5;

export interface PausedCardProps {
  paused: UseQueryResult<RcfListResponse>;
  customerNames: ReadonlyMap<number, string>;
  onPick: (customerId: number) => void;
  order: number;
}

export function PausedCard({ paused, customerNames, onPick, order }: PausedCardProps) {
  const items = paused.data?.items ?? [];
  const capped = items.length >= PAUSED_CAP;
  return (
    <Card
      id="ad-paused"
      title="Paused numbers"
      sub="Not forwarding right now, all customers"
      icon={<PauseCircle size={15} strokeWidth={2.2} />}
      count={paused.data ? items.length : null}
      className="ad-span-4"
      order={order}
    >
      {paused.data === undefined ? (
        paused.isError ? (
          <CardState kind="error" onRetry={() => void paused.refetch()}>Paused numbers couldn’t load.</CardState>
        ) : (
          <CardState kind="loading">Loading…</CardState>
        )
      ) : items.length === 0 ? (
        <p className="ad-quiet">
          <span className="ad-kpi-ok">
            <span className="ad-dot ad-dot-on" aria-hidden="true" />
            Every number is forwarding.
          </span>
        </p>
      ) : (
        <>
          <ul className="ad-req-list">
            {items.slice(0, PAUSED_PREVIEW).map((r) => (
              <li key={r.id}>
                <span className="ad-stack">
                  <span className="ad-num ad-num-sm">{fmt(r.did)}</span>
                  <span className={r.name ? 'ad-faint ad-ellipsis' : 'ad-faint ad-italic'}>{r.name ?? 'No label'}</span>
                </span>
                <CustomerName id={r.customer_id} names={customerNames} onPick={onPick} />
              </li>
            ))}
          </ul>
          {items.length > PAUSED_PREVIEW && (
            <p className="ad-quiet">
              And {(items.length - PAUSED_PREVIEW).toLocaleString()}
              {capped ? '+' : ''} more.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

// ─── Number inventory ────────────────────────────────────────────────────────

export interface InventoryCardProps {
  stats: UseQueryResult<InventoryStats>;
  order: number;
}

export function InventoryCard({ stats, order }: InventoryCardProps) {
  const s = stats.data;
  const releasing = s?.by_status?.release_requested ?? 0;
  // One line per visible product the pool knows, in catalog order
  // (call forwarding, SIP trunk, voicemail, then any newer product).
  const products = Object.entries(s?.by_product ?? {})
    .filter(([product, n]) => typeof n === 'number' && !isProductHidden(product))
    .sort(([a], [b]) => compareProducts(a, b));
  return (
    <Card
      id="ad-inventory"
      title="Number inventory"
      sub="The platform’s number pool"
      icon={<Boxes size={15} strokeWidth={2.2} />}
      className="ad-span-4"
      order={order}
    >
      {s === undefined ? (
        stats.isError ? (
          <CardState kind="error" onRetry={() => void stats.refetch()}>The inventory couldn’t load.</CardState>
        ) : (
          <CardState kind="loading">Loading…</CardState>
        )
      ) : (
        <dl className="ad-facts ad-facts-stack">
          <div>
            <dt>Available to assign</dt>
            <dd>{s.available.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Assigned</dt>
            <dd>{s.assigned.toLocaleString()}</dd>
          </div>
          {products.map(([product, n]) => (
            <div key={product}>
              <dt>{productLabel(product)}</dt>
              <dd>{n.toLocaleString()}</dd>
            </div>
          ))}
          <div>
            <dt>Waiting for approval</dt>
            <dd className={s.reserved > 0 ? 'ad-fact-todo' : undefined}>{s.reserved.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Release pending</dt>
            <dd className={releasing > 0 ? 'ad-fact-todo' : undefined}>{releasing.toLocaleString()}</dd>
          </div>
        </dl>
      )}
    </Card>
  );
}
