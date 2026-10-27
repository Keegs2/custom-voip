/**
 * IvrAllCustomers — the admin console's "All customers" IVR view
 * (`/ivr?customer=all`): one compact row per customer that has IVR switched
 * on or any flow, from `GET /v1/ivr/admin/overview` (admin only).
 *
 *   ┌ CompactHeader: All customers / IVR [Staff] · IVR   [Customer ▾]   Customers | IVR on | Flows | Numbers on IVR ┐
 *   ┌ Every customer's IVR ─────────────────────────────────────────────────────────────────────────┐
 *   │ CUSTOMER                  IVR    FLOWS               NUMBERS ON IVR   LAST PUBLISHED            │
 *   │ Bay State Utilities       ● On   2 of 3 published    2                3 days ago            ›   │
 *   │ Old Mill Water  Suspended ○ Off  No flows            None             Never                 ›   │
 *   └───────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * Every row opens that customer's IVR (`?customer=<id>`, where the builder
 * and every per-customer route live): the name is a real link (keyboard,
 * open in a new tab) and the whole row is a click target. Layout kit §20:
 * the first 10 rows, then "Show all N" opens the rest inside a capped
 * scroll with sticky heads, so the card never runs the page long.
 */
import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronRight, RefreshCw, Workflow } from 'lucide-react';
import { ApiError } from '../../api/client';
import { getIvrAdminOverview } from '../../api/ivr';
import { CompactHeader, ShowMoreButton, useShowMore, type HeaderStat } from '../../components/layout/kit';
import { Spinner } from '../../components/ui/Spinner';
import type { IvrAdminOverviewRow } from '../../types/ivr';

/** Rows before "Show all N". */
const ROW_LIMIT = 10;

const NO_ROWS: readonly IvrAdminOverviewRow[] = [];

const STATUS_WORD: Readonly<Record<string, string>> = { suspended: 'Suspended', closed: 'Closed' };

const ABSOLUTE = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });
const RELATIVE = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now" · "12 minutes ago" · "yesterday" · "3 weeks ago" · "last year". */
function relativeWhen(iso: string, nowMs: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '—';
  const sec = Math.round((at - nowMs) / 1000);
  const abs = Math.abs(sec);
  if (abs < 45) return 'just now';
  if (abs < HOUR) return RELATIVE.format(Math.round(sec / MINUTE), 'minute');
  if (abs < DAY) return RELATIVE.format(Math.round(sec / HOUR), 'hour');
  if (abs < 7 * DAY) return RELATIVE.format(Math.round(sec / DAY), 'day');
  if (abs < 30 * DAY) return RELATIVE.format(Math.round(sec / (7 * DAY)), 'week');
  if (abs < 365 * DAY) return RELATIVE.format(Math.round(sec / (30 * DAY)), 'month');
  return RELATIVE.format(Math.round(sec / (365 * DAY)), 'year');
}

function absoluteWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : ABSOLUTE.format(d);
}

function customerHref(id: number): string {
  return `/ivr?customer=${id}`;
}

function sum(rows: readonly IvrAdminOverviewRow[], pick: (r: IvrAdminOverviewRow) => number): number {
  return rows.reduce((n, r) => n + pick(r), 0);
}

export function IvrAllCustomers({ picker }: { picker: ReactNode }) {
  // ── ALL hooks unconditionally at the top (React #310) ──
  const navigate = useNavigate();
  const [nowMs] = useState(() => Date.now());
  const overview = useQuery({
    // Under the ['ivr'] root, apart from every per-customer key ('self:…' / 'c:…').
    queryKey: ['ivr', 'admin-overview'],
    queryFn: getIvrAdminOverview,
    staleTime: 30_000,
  });
  const rows = overview.data?.customers ?? NO_ROWS;
  const more = useShowMore(rows, ROW_LIMIT);

  // ── Derived (after all hooks) ──
  const stats: HeaderStat[] | undefined = overview.data
    ? [
        { label: rows.length === 1 ? 'Customer' : 'Customers', value: rows.length },
        { label: 'IVR on', value: rows.filter((r) => r.ivr_enabled).length, title: 'Customers with IVR switched on' },
        { label: 'Flows', value: sum(rows, (r) => r.flows_total) },
        {
          label: 'Numbers on IVR',
          value: sum(rows, (r) => r.numbers_bound),
          title: 'Numbers that answer with a flow',
        },
      ]
    : undefined;

  const header = (
    <CompactHeader
      className="ivr-header fx-load"
      crumb={
        <>
          <span className="vm-crumb-tail">All customers</span>
          <span className="dl-crumb-sep" aria-hidden="true">
            /
          </span>
          <span>IVR</span>
          <span className="vm-staff-tag">Staff</span>
        </>
      }
      title="IVR"
      subtitle="Every customer’s IVR at a glance. Open a customer to edit their flows, numbers and messages."
      tools={picker}
      stats={stats}
      statsLabel="IVR totals, every customer"
    />
  );

  let body: ReactNode;
  if (overview.isLoading) {
    body = (
      <div className="ivr-state" role="status">
        <Spinner /> Loading every customer’s IVR…
      </div>
    );
  } else if (overview.isError || !overview.data) {
    const forbidden = overview.error instanceof ApiError && overview.error.status === 403;
    body = (
      <div className="dl-banner dl-banner-err ivr-gap" role="alert">
        {forbidden
          ? 'Only platform admins can see every customer’s IVR. Pick one customer instead.'
          : 'The IVR overview couldn’t be loaded.'}{' '}
        {!forbidden && (
          <button type="button" className="vm-linkbtn" onClick={() => void overview.refetch()} disabled={overview.isFetching}>
            <RefreshCw size={13} aria-hidden="true" /> Try again
          </button>
        )}
      </div>
    );
  } else {
    body = (
      <section className="dl-panel ivr-panel ivr-card ivr-ov" aria-labelledby="ivr-ov-title">
        <div className="ivr-panel-head">
          <div>
            <h2 id="ivr-ov-title" className="ivr-panel-title">
              Every customer’s IVR
              <span className="ivr-title-count">{rows.length.toLocaleString()}</span>
            </h2>
            <p className="ivr-panel-sub">Customers with IVR switched on or any flow. Open one to work on their IVR.</p>
          </div>
        </div>

        {rows.length === 0 ? (
          <div className="ivr-empty">
            <span className="ivr-empty-icon" aria-hidden="true">
              <Workflow size={20} strokeWidth={1.8} />
            </span>
            <div>
              <p className="ivr-empty-title">No customer has IVR yet</p>
              <p className="ivr-empty-copy">
                Switch IVR on for a customer in TED (Customer 360 → Products) and they show up here. You can still pick
                any customer from the Customer menu.
              </p>
            </div>
          </div>
        ) : (
          <div className={more.expanded ? 'ivr-ov-wrap ivr-ov-wrap-cap' : 'ivr-ov-wrap'}>
            <table className="ivr-ov-table">
              <caption className="ivr-sr">IVR by customer</caption>
              <thead>
                <tr>
                  <th className="dl-th" scope="col">
                    Customer
                  </th>
                  <th className="dl-th" scope="col">
                    IVR
                  </th>
                  <th className="dl-th" scope="col">
                    Flows
                  </th>
                  <th className="dl-th ivr-ov-num" scope="col">
                    Numbers on IVR
                  </th>
                  <th className="dl-th" scope="col">
                    Last published
                  </th>
                  <th className="dl-th ivr-ov-chev" scope="col">
                    <span className="ivr-sr">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody id={more.listId}>
                {more.visible.map((r) => (
                  <OverviewRow key={r.customer_id} row={r} nowMs={nowMs} onOpen={() => navigate(customerHref(r.customer_id))} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {more.needed && <ShowMoreButton {...more.buttonProps} noun="customers" variant="bar" />}
      </section>
    );
  }

  return (
    <div className="dl-shell ivr-shell">
      {header}
      <div className="ivr-sections fx-load fx-load-d1">{body}</div>
    </div>
  );
}

function OverviewRow({ row, nowMs, onOpen }: { row: IvrAdminOverviewRow; nowMs: number; onOpen: () => void }) {
  const statusWord = row.status !== 'active' ? (STATUS_WORD[row.status] ?? row.status) : null;
  return (
    <tr
      className="dl-row ivr-ov-row"
      // The name's link is the keyboard / new-tab route; the row is a pointer convenience.
      onClick={(e) => {
        if ((e.target as Element).closest('a')) return;
        onOpen();
      }}
    >
      <td className="ivr-ov-cust">
        <Link className="ivr-ov-name" to={customerHref(row.customer_id)} title={`Open ${row.name}’s IVR`}>
          {row.name}
        </Link>
        {statusWord && <span className="ivr-tag ivr-tag-warn">{statusWord}</span>}
      </td>
      <td>
        <span className={`ivr-status ${row.ivr_enabled ? 'ivr-status-ok' : 'ivr-status-neutral'}`}>
          <span className="ivr-status-dot" aria-hidden="true" />
          {row.ivr_enabled ? 'On' : 'Off'}
        </span>
      </td>
      <td className={row.flows_total === 0 ? 'ivr-ov-dim' : undefined}>
        {row.flows_total === 0
          ? 'No flows'
          : `${row.flows_published.toLocaleString()} of ${row.flows_total.toLocaleString()} published`}
      </td>
      <td className={row.numbers_bound === 0 ? 'ivr-ov-num ivr-ov-dim' : 'ivr-ov-num'}>
        {row.numbers_bound === 0 ? 'None' : row.numbers_bound.toLocaleString()}
      </td>
      <td className={row.last_published_at ? 'ivr-ov-when' : 'ivr-ov-when ivr-ov-dim'}>
        {row.last_published_at ? (
          <time dateTime={row.last_published_at} title={absoluteWhen(row.last_published_at)}>
            {relativeWhen(row.last_published_at, nowMs)}
          </time>
        ) : (
          'Never'
        )}
      </td>
      <td className="ivr-ov-chev" aria-hidden="true">
        <ChevronRight size={15} strokeWidth={2} />
      </td>
    </tr>
  );
}
