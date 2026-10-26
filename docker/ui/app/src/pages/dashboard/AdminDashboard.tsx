/**
 * AdminDashboard — `/dashboard` for a platform admin (not in customer view).
 * The same look as the customer dashboard, with a "Viewing" dropdown in the
 * granite header:
 *
 *   All customers (default)  holistic view — platform KPIs, the customers
 *                            table, call volume / quality / recent calls for
 *                            every customer, open number requests (the
 *                            admin's to-dos), paused numbers, the number pool
 *   one customer             AccountDashboardView with viewer="admin"
 *
 * All customers layout (docker/ui/CLAUDE.md §20 — every row one height):
 *
 *   ┌ Customers (first 5, "Show all") ┐ ┌ Call volume  ┐
 *   ├ Number requests (follows)       ┤ ├ Call quality ┤
 *   ┌ Recent calls ───────────────────┐ ┌ Paused (follows) ┐
 *   ┌ Inventory ┐ ┌ Quick actions (two columns) ─────────┐
 *
 * The admin's to-dos (number requests) sit right under the customers.
 *
 * The scope lives in the URL (`?customer=<id>`, absent = All customers), so
 * a scope can be linked or bookmarked and Back steps through picks. Each
 * scope's view is keyed (`all` / the id): switching remounts instead of
 * changing hook order.
 *
 * Data: adminData.ts (customers, owned numbers, paused, requests, stats)
 * plus accountData.ts's activity / recent-calls hooks with a null customer.
 * Holistic: numbers count EVERY product (GET /numbers/owned — exact, no
 * caps), and calls cover every product. If /numbers/owned is unavailable
 * (an older API) the counts fall back to the call forwarding inventory, as
 * before. No money anywhere.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth, type EffectiveCustomer } from '../../contexts/AuthContext';
import { CallActivityTab } from '../rcf/CallActivityTab';
import { DashboardOverlay } from '../rcf/DashboardOverlay';
import { browserTimeZone } from '../rcf/activityFormat';
import { AccountDashboardView } from './AccountDashboardView';
import { AdminScopeSelect } from './AdminScopeSelect';
import { CustomersCard, InventoryCard, PausedCard } from './AdminCards';
import { QualityCard, RecentCard, VolumeCard } from './CallCards';
import { QuickActionsCard, RequestsCard } from './AccountCards';
import { DashboardHeader } from './DashboardHeader';
import { KpiRow, type CustomerCounts, type NumberCounts } from './KpiCards';
import { adminPlatformActions } from './quickActions';
import { parseCustomerParam, rcfConsoleHref } from './adminLinks';
import { useRecentCalls, useWeekActivity, type Feed } from './accountData';
import {
  PAUSED_CAP,
  hasCallForwarding,
  isOwnedNumbers,
  ownedToPlatformCounts,
  toPlatformNumberCounts,
  useAdminCustomers,
  useInventoryStats,
  useOpenRequests,
  useOwnedNumbers,
  usePausedNumbers,
  useRcfInventory,
  type CustomerRow,
} from './adminData';
import type { CdrActivityResponse } from '../../types/cdrActivity';
import '../../styles/rcf-dashboard.css';
import '../../styles/account-dashboard.css';

export function AdminDashboard() {
  // ── ALL hooks unconditionally at the top (React #310) ──
  const [params, setParams] = useSearchParams();
  const { customerViewMode, setPreviewCustomer, toggleCustomerView } = useAuth();
  const customers = useAdminCustomers();

  const scope = parseCustomerParam(params.get('customer'));
  const all = useMemo(() => customers.data ?? [], [customers.data]);
  const forwardingCustomers = useMemo(() => all.filter((c) => hasCallForwarding(c.account_type)), [all]);

  const select = useCallback(
    (next: number | 'all') => {
      setParams((prev) => {
        const p = new URLSearchParams(prev);
        if (next === 'all') p.delete('customer');
        else p.set('customer', String(next));
        return p;
      });
    },
    [setParams],
  );

  const viewAsCustomer = useCallback(
    (c: EffectiveCustomer) => {
      setPreviewCustomer(c);
      // Entering customer view navigates to / → productHome → /dashboard.
      if (!customerViewMode) toggleCustomerView();
    },
    [customerViewMode, setPreviewCustomer, toggleCustomerView],
  );

  // ── Derived (after all hooks) ──
  const current: CustomerRow | null = typeof scope === 'number' ? (all.find((c) => c.id === scope) ?? null) : null;
  // The dropdown lists call forwarding customers, plus a deep-linked one of another type.
  const options = current && !forwardingCustomers.includes(current) ? [...forwardingCustomers, current] : forwardingCustomers;
  const picker = (
    <AdminScopeSelect
      value={scope}
      onChange={select}
      customers={options}
      loading={customers.isLoading}
      error={customers.isError}
    />
  );

  if (scope === 'all') {
    return (
      <AdminOverview
        key="all"
        picker={picker}
        customers={forwardingCustomers}
        allCustomers={all}
        customersLoading={customers.isLoading}
        customersError={customers.isError}
        onRetryCustomers={() => void customers.refetch()}
        onPick={select}
      />
    );
  }

  if (customers.data && !current) {
    return <CustomerNotFound key={`missing-${scope}`} id={scope} picker={picker} onBack={() => select('all')} />;
  }

  return (
    <AccountDashboardView
      key={scope}
      customer={{ id: scope, name: current?.name ?? '', account_type: current?.account_type ?? null }}
      viewer="admin"
      scopePicker={picker}
      onViewAsCustomer={viewAsCustomer}
    />
  );
}

// ─── All customers ───────────────────────────────────────────────────────────

interface AdminOverviewProps {
  picker: ReactNode;
  /** Call forwarding customers (the dashboard's product). */
  customers: readonly CustomerRow[];
  /** Every customer — for naming calls and requests. */
  allCustomers: readonly CustomerRow[];
  customersLoading: boolean;
  customersError: boolean;
  onRetryCustomers: () => void;
  onPick: (customerId: number) => void;
}

function AdminOverview({
  picker,
  customers,
  allCustomers,
  customersLoading,
  customersError,
  onRetryCustomers,
  onPick,
}: AdminOverviewProps) {
  // ── ALL hooks unconditionally at the top (React #310) ──
  const [tz] = useState(browserTimeZone);
  const [activityOpen, setActivityOpen] = useState(false);
  const owned = useOwnedNumbers();
  const ownedData = isOwnedNumbers(owned.data) ? owned.data : null;
  // Fallback only: an API without /numbers/owned (or an unexpected body).
  const inventoryFallback = owned.isError || (owned.data !== undefined && ownedData === null);
  const inventory = useRcfInventory(inventoryFallback);
  const paused = usePausedNumbers();
  const activity = useWeekActivity(null, tz);
  const recent = useRecentCalls(null);
  const requests = useOpenRequests();
  const stats = useInventoryStats();

  const openActivity = useCallback(() => setActivityOpen(true), []);
  const closeActivity = useCallback(() => setActivityOpen(false), []);

  const names = useMemo(() => new Map(allCustomers.map((c) => [c.id, c.name])), [allCustomers]);
  const counts = useMemo(
    () =>
      ownedData
        ? ownedToPlatformCounts(ownedData)
        : inventoryFallback && inventory.data
          ? toPlatformNumberCounts(inventory.data)
          : null,
    [ownedData, inventoryFallback, inventory.data],
  );
  const pausedItems = useMemo(() => paused.data?.items ?? null, [paused.data]);
  const pausedFromList = useMemo(() => {
    if (!pausedItems) return null;
    const m = new Map<number, number>();
    for (const r of pausedItems) m.set(r.customer_id, (m.get(r.customer_id) ?? 0) + 1);
    return m;
  }, [pausedItems]);

  // ── Derived (after all hooks) ──
  const exact = counts?.rcf !== undefined;
  // Exact per-customer paused counts when /numbers/owned answered; else the capped list.
  const pausedByCustomer = counts?.pausedByCustomer ?? pausedFromList;
  const pausedPartial = !exact && (pausedItems?.length ?? 0) >= PAUSED_CAP;

  let numberFeed: Feed<NumberCounts>;
  if (counts?.rcf) {
    numberFeed = {
      state: 'ready',
      value: {
        total: counts.total,
        forwarding: counts.rcf.forwarding,
        paused: counts.rcf.paused,
        partial: false,
        mix: counts.mix,
      },
    };
  } else if (!inventoryFallback) numberFeed = { state: 'loading' };
  else if (inventory.isError && !counts) numberFeed = { state: 'error' };
  else if (!counts || !pausedItems) numberFeed = paused.isError && counts ? { state: 'error' } : { state: 'loading' };
  else {
    const pausedCount = Math.min(pausedItems.length, counts.total);
    numberFeed = {
      state: 'ready',
      value: {
        total: counts.total,
        forwarding: Math.max(0, counts.total - pausedCount),
        paused: pausedCount,
        partial: counts.partial,
        pausedPartial,
      },
    };
  }

  const activityFeed: Feed<CdrActivityResponse> = activity.data
    ? { state: 'ready', value: activity.data }
    : activity.isError
      ? { state: 'error' }
      : { state: 'loading' };

  const customerFeed: Feed<CustomerCounts> = customersLoading
    ? { state: 'loading' }
    : customersError && customers.length === 0
      ? { state: 'error' }
      : { state: 'ready', value: { total: customers.length, active: customers.filter((c) => c.status === 'active').length } };

  const numbersState: 'loading' | 'error' | 'ready' = counts ? 'ready' : inventoryFallback && inventory.isError ? 'error' : 'loading';

  return (
    <div className="rcf-scope ad-scope">
      <div className="ad-shell">
        <DashboardHeader
          name="All customers"
          status={null}
          since={null}
          kicker="Remote call forwarding"
          tag="Staff"
          meta={
            <span>
              {customersLoading
                ? 'Every call forwarding customer'
                : `${customers.length.toLocaleString()} call forwarding ${customers.length === 1 ? 'customer' : 'customers'} · last 7 days`}
            </span>
          }
          scope={picker}
          products={{ accountType: 'rcf', active: 'rcf', onSelect: () => undefined }}
        />

        <KpiRow
          numbers={numberFeed}
          activity={activityFeed}
          people={{ kind: 'customers', feed: customerFeed }}
          onOpenActivity={openActivity}
          numbersHref={rcfConsoleHref('all')}
          scope="platform"
          voice="staff"
          order={1}
        />

        <div className="ad-grid">
          <div className="ad-span-8 ad-col">
            <CustomersCard
              customers={customers}
              loading={customersLoading}
              error={customersError}
              onRetry={onRetryCustomers}
              numbers={counts}
              numbersState={numbersState}
              paused={pausedByCustomer}
              pausedPartial={pausedPartial}
              pausedError={!exact && paused.isError}
              onPick={onPick}
              order={7}
              preview={5}
            />
            <RequestsCard
              dids={requests}
              action={null}
              order={8}
              sub="Waiting for approval or release, every customer"
              emptyText="No open number requests — nothing to approve."
              customerNames={names}
              onPickCustomer={onPick}
              follow
              className="ad-card-requests-wide"
            />
          </div>
          <div className="ad-span-4 ad-col">
            <VolumeCard
              activity={activity}
              onOpen={openActivity}
              order={9}
              emptyText="No calls reached any customer’s numbers in the last 7 days."
            />
            <QualityCard activity={activity} onOpen={openActivity} order={10} />
          </div>
          <RecentCard
            calls={recent}
            nowMs={recent.dataUpdatedAt}
            onOpen={openActivity}
            order={11}
            sub="The newest calls, every customer"
            customerNames={names}
            onPickCustomer={onPick}
          />
          <PausedCard paused={paused} customerNames={names} onPick={onPick} order={12} follow />
          <InventoryCard stats={stats} order={13} />
          <QuickActionsCard
            actions={adminPlatformActions({ onActivity: openActivity })}
            order={14}
            columns={2}
            className="ad-span-8 ad-qa-wide"
          />
        </div>
      </div>

      {activityOpen && (
        <DashboardOverlay
          title="Call activity"
          subtitle="Every customer’s calls. Pick a time range to narrow it down."
          onClose={closeActivity}
        >
          <CallActivityTab customerId={undefined} scope="account" />
        </DashboardOverlay>
      )}
    </div>
  );
}

// ─── Unknown customer id ─────────────────────────────────────────────────────

function CustomerNotFound({ id, picker, onBack }: { id: number; picker: ReactNode; onBack: () => void }) {
  return (
    <div className="rcf-scope ad-scope">
      <div className="ad-shell">
        <DashboardHeader name={`Customer #${id}`} status={null} since={null} kicker="Remote call forwarding" tag="Staff" scope={picker} />
        <section className="ad-card ad-prompt" aria-labelledby="ad-missing-title">
          <h2 id="ad-missing-title" className="ad-prompt-title">We couldn’t find customer #{id}</h2>
          <p className="ad-quiet">The link may be old, or the customer was removed. Pick another customer above.</p>
          <button type="button" className="ad-btn ad-btn-quiet" onClick={onBack}>
            Back to all customers
          </button>
        </section>
      </div>
    </div>
  );
}
