/**
 * CustomerNumbersPage — the customer's view of /rcf: the full numbers
 * manager. A quiet daylight header ("Call forwarding numbers" + Request
 * numbers) over the RoutingBoard (search, All / Forwarding / Paused chips,
 * sort, paging, rows open the shared RowEditor).
 *
 * The at-a-glance picture lives on /dashboard; this page is for working
 * through the whole list. RcfPage renders it for a non-admin viewer with an
 * effective customer (a tenant, or an admin previewing one in "View as
 * Customer"), keyed by the customer id. Data comes from the same
 * accountData.ts hooks as the dashboard, so a staff preview reads the
 * previewed customer — never the platform.
 */
import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth, type EffectiveCustomer } from '../../contexts/AuthContext';
import { DIDManagementTab } from './DidManagement';
import { DashboardOverlay } from './DashboardOverlay';
import { RoutingBoard } from './RoutingBoard';
import { browserTimeZone } from './activityFormat';
import {
  RCF_LIST_CAP,
  toNumberStats,
  useAccountNumbers,
  useAccountSummary,
  useWeekNumberStats,
  type DashboardScope,
} from '../dashboard/accountData';
import '../../styles/rcf-dashboard.css';

export interface CustomerNumbersPageProps {
  customer: EffectiveCustomer;
  /** The viewer is staff (an admin previewing this customer). */
  staff: boolean;
}

export function CustomerNumbersPage({ customer, staff }: CustomerNumbersPageProps) {
  // ── ALL hooks unconditionally at the top (React #310) ──
  const { user } = useAuth();
  const [tz] = useState(browserTimeZone);
  const [overlay, setOverlay] = useState(false);
  const scope = useMemo<DashboardScope>(() => ({ customerId: customer.id, staff }), [customer.id, staff]);

  const summary = useAccountSummary(scope);
  const numbers = useAccountNumbers(customer.id);
  const numberStats = useWeekNumberStats(customer.id, tz);

  const openNumbers = useCallback(() => setOverlay(true), []);
  const closeOverlay = useCallback(() => setOverlay(false), []);

  const entries = useMemo(() => numbers.data?.items ?? [], [numbers.data]);
  const stats = useMemo(() => toNumberStats(numberStats.data, numberStats.isError), [numberStats.data, numberStats.isError]);

  // ── Derived values (after all hooks) ──
  const role = user?.role ?? 'user';
  const canEdit = role !== 'readonly' && role !== 'support';
  const canRequest = role === 'user';
  const actionLabel = canRequest ? 'Request numbers' : canEdit ? 'Manage numbers' : 'View numbers';

  const accountTotal = summary.data?.rcfCount ?? null;
  const partialOf =
    accountTotal !== null && entries.length >= RCF_LIST_CAP && accountTotal > entries.length ? accountTotal : null;
  const accountName = summary.data?.name ?? customer.name;

  return (
    <div className="rcf-scope rcfd-scope">
      <div className="rcfd-shell">
        <header className="rcfn-header">
          <div className="rcfn-id">
            <nav className="rcfn-crumb" aria-label="Breadcrumb">
              <Link to="/dashboard">Dashboard</Link>
              <span aria-hidden="true">/</span>
              <span>{accountName || 'Your account'}</span>
            </nav>
            <h1 className="rcfn-title">Call forwarding numbers</h1>
            <p className="rcfn-sub">Every number on the account, where it rings, and whether it’s forwarding right now.</p>
          </div>
          <button type="button" className="rcfd-btn rcfd-btn-primary" onClick={openNumbers}>
            {canRequest && (
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path d="M8 3v10M3 8h10" strokeLinecap="round" />
              </svg>
            )}
            {actionLabel}
          </button>
        </header>

        <RoutingBoard
          entries={entries}
          loading={numbers.isLoading}
          error={numbers.isError && !numbers.data}
          onRetry={() => void numbers.refetch()}
          partialOf={partialOf}
          stats={stats}
          canEdit={canEdit}
          requestLabel={canRequest ? 'Request numbers' : null}
          onRequest={openNumbers}
        />
      </div>

      {overlay && (
        <DashboardOverlay
          title={canRequest ? 'Request and manage numbers' : 'Your numbers'}
          subtitle={
            canRequest
              ? 'Request new numbers, or ask Granite to release ones you no longer need.'
              : 'Numbers assigned to the account and any open requests.'
          }
          onClose={closeOverlay}
        >
          <DIDManagementTab
            customerId={customer.id}
            filterToCustomer={staff ? customer.id : undefined}
            onShowNumbers={closeOverlay}
          />
        </DashboardOverlay>
      )}
    </div>
  );
}
