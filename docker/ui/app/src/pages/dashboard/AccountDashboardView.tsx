/**
 * AccountDashboardView — one customer account's dashboard, as cards:
 *
 *   ┌ Granite header: name · status · since     [ product switcher ] [action] ┐
 *   ┌KPI┐┌KPI┐┌KPI┐┌KPI┐┌KPI┐┌KPI┐   numbers · forwarding · calls · answered · sounded good · team
 *   ┌ Numbers (8) ──────────────────┐ ┌ Call volume (4) ┐
 *   │ small table, row → RowEditor  │ ├ Call quality (4) ┤
 *   ┌ Recent calls (8) ─────────────┐ ┌ Team (4) ┐
 *   ┌ Busiest (4) ┐ ┌ Requests (4) ┐ ┌ Quick actions (4) ┐
 *
 * Three viewers, one layout:
 *   tenant   the customer's own account (self-scoped endpoints)
 *   preview  an admin in "View as Customer" — sees exactly what the tenant
 *            sees (same copy and actions), on the staff endpoints
 *   admin    the admin dashboard's one-customer view — the same cards with
 *            ADMIN actions: the scope dropdown in the header, "View as
 *            customer", the RowEditor's admin fields, links into the admin
 *            console / Calls & Quality / Reporting / Troubleshooting, a
 *            read-only team list, and no customer-only actions (Request
 *            numbers).
 *
 * Callers key this component on the customer id, so switching accounts
 * remounts it (hook order never changes). Endpoints: accountData.ts. No
 * money anywhere.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Eye } from 'lucide-react';
import { useAuth, type EffectiveCustomer } from '../../contexts/AuthContext';
import { canSeeReporting } from '../../utils/reportingAccess';
import { CallActivityTab } from '../rcf/CallActivityTab';
import { DIDManagementTab } from '../rcf/DidManagement';
import { DashboardOverlay } from '../rcf/DashboardOverlay';
import { browserTimeZone } from '../rcf/activityFormat';
import { DashboardHeader, type HeaderAction } from './DashboardHeader';
import { KpiRow, type NumberCounts, type TeamCounts } from './KpiCards';
import { NumbersCard } from './NumbersCard';
import { BusiestCard, QualityCard, RecentCard, VolumeCard } from './CallCards';
import { QuickActionsCard, RequestsCard, TeamCard } from './AccountCards';
import { adminCustomerActions, customerQuickActions } from './quickActions';
import { rcfConsoleHref } from './adminLinks';
import { DASHBOARD_PRODUCTS, isProductAvailable, type DashboardProductId } from './products';
import {
  RCF_LIST_CAP,
  fmtMonthYear,
  toNumberStats,
  useAccountDids,
  useAccountNumbers,
  useAccountSummary,
  useAccountTeam,
  useRecentCalls,
  useWeekActivity,
  useWeekNumberStats,
  type DashboardScope,
  type Feed,
} from './accountData';
import type { CdrActivityResponse } from '../../types/cdrActivity';
import '../../styles/rcf-dashboard.css';
import '../../styles/account-dashboard.css';

export type DashboardViewer = 'tenant' | 'preview' | 'admin';

type OverlayKind = 'activity' | 'numbers';

export interface AccountDashboardViewProps {
  customer: EffectiveCustomer;
  viewer: DashboardViewer;
  /** Admin only: the scope dropdown for the header. */
  scopePicker?: ReactNode;
  /** Admin only: enter customer view previewing this account. */
  onViewAsCustomer?: (customer: EffectiveCustomer) => void;
}

const MY_ACCOUNT = { to: '/my-account', label: 'My account' };

export function AccountDashboardView({ customer, viewer, scopePicker, onViewAsCustomer }: AccountDashboardViewProps) {
  // ── ALL hooks unconditionally at the top (React #310) ──
  const { user } = useAuth();
  const [tz] = useState(browserTimeZone);
  const [overlay, setOverlay] = useState<OverlayKind | null>(null);
  const [pickedProduct, setPickedProduct] = useState<DashboardProductId | null>(null);
  const staff = viewer !== 'tenant';
  const scope = useMemo<DashboardScope>(() => ({ customerId: customer.id, staff }), [customer.id, staff]);

  const summary = useAccountSummary(scope);
  const numbers = useAccountNumbers(customer.id);
  const activity = useWeekActivity(customer.id, tz);
  const numberStats = useWeekNumberStats(customer.id, tz);
  const recent = useRecentCalls(customer.id);
  const team = useAccountTeam(scope);
  const dids = useAccountDids(scope);

  const closeOverlay = useCallback(() => setOverlay(null), []);
  const openNumbers = useCallback(() => setOverlay('numbers'), []);
  const openActivity = useCallback(() => setOverlay('activity'), []);

  const entries = useMemo(() => numbers.data?.items ?? [], [numbers.data]);
  const stats = useMemo(() => toNumberStats(numberStats.data, numberStats.isError), [numberStats.data, numberStats.isError]);

  const accountTotal = summary.data?.rcfCount ?? null;
  const numberFeed = useMemo<Feed<NumberCounts>>(() => {
    if (numbers.isError) return { state: 'error' };
    if (!numbers.data) return { state: 'loading' };
    const forwarding = entries.filter((e) => e.enabled).length;
    return {
      state: 'ready',
      value: {
        total: accountTotal !== null ? Math.max(accountTotal, entries.length) : entries.length,
        forwarding,
        paused: entries.length - forwarding,
        // Without an account count (staff) a full first page means
        // "at least this many".
        partial: accountTotal === null && entries.length >= RCF_LIST_CAP,
      },
    };
  }, [numbers.isError, numbers.data, entries, accountTotal]);

  // ── Derived values (after all hooks) ──
  const admin = viewer === 'admin';
  const role = user?.role ?? 'user';
  const canEdit = role !== 'readonly' && role !== 'support';
  const canRequest = role === 'user';
  const numbersLabel = canRequest ? 'Request numbers' : canEdit ? 'Manage numbers' : 'View numbers';

  const accountType = summary.data?.account_type ?? customer.account_type ?? null;
  const firstAvailable = DASHBOARD_PRODUCTS.find((p) => isProductAvailable(p, accountType))?.id ?? null;
  const pickedOk = DASHBOARD_PRODUCTS.some((p) => p.id === pickedProduct && isProductAvailable(p, accountType));
  const activeProduct = pickedOk ? pickedProduct : firstAvailable;

  const activityFeed: Feed<CdrActivityResponse> = activity.data
    ? { state: 'ready', value: activity.data }
    : activity.isError
      ? { state: 'error' }
      : { state: 'loading' };
  const teamFeed: Feed<TeamCounts> = team.data
    ? { state: 'ready', value: { total: team.data.length, active: team.data.filter((m) => m.status === 'active').length } }
    : team.isError
      ? { state: 'error' }
      : { state: 'loading' };

  const accountName = summary.data?.name ?? (customer.name || (admin ? `Customer #${customer.id}` : 'Your account'));
  const totalNumbers = numberFeed.state === 'ready' ? numberFeed.value.total : null;
  const numbersHref = admin ? rcfConsoleHref(customer.id) : '/rcf';

  const headerAction: HeaderAction | null =
    activeProduct !== 'rcf' ? null : canRequest ? { label: 'Request numbers', onClick: openNumbers } : staff ? { label: 'Manage numbers', onClick: openNumbers } : null;
  const viewAs = onViewAsCustomer
    ? () => onViewAsCustomer({ id: customer.id, name: accountName, account_type: accountType })
    : null;
  const secondary: HeaderAction | null =
    admin && viewAs ? { label: 'View as customer', onClick: viewAs, icon: <Eye size={14} strokeWidth={2.2} aria-hidden="true" /> } : null;

  const quickActions = admin
    ? adminCustomerActions({
        customerId: customer.id,
        customerName: accountName,
        onViewAsCustomer: viewAs ?? (() => undefined),
        onActivity: openActivity,
      })
    : customerQuickActions({ numbersLabel, onNumbers: openNumbers, onActivity: openActivity, showReports: canSeeReporting(user) });

  return (
    <div className="rcf-scope ad-scope">
      <div className="ad-shell">
        <DashboardHeader
          name={accountName}
          status={summary.data?.status ?? null}
          since={fmtMonthYear(summary.data?.created_at)}
          tag={viewer === 'preview' ? 'Staff preview' : admin ? 'Staff' : null}
          scope={scopePicker}
          products={{ accountType, active: activeProduct, onSelect: setPickedProduct }}
          action={headerAction}
          secondary={secondary}
        />

        {activeProduct === 'rcf' ? (
          <>
            <KpiRow
              numbers={numberFeed}
              activity={activityFeed}
              people={{ kind: 'team', feed: teamFeed, href: admin ? null : MY_ACCOUNT.to }}
              onOpenActivity={openActivity}
              numbersHref={numbersHref}
              scope="account"
              voice={admin ? 'staff' : 'tenant'}
              order={1}
            />

            <div className="ad-grid">
              <NumbersCard
                entries={entries}
                loading={numbers.isLoading}
                error={numbers.isError && !numbers.data}
                onRetry={() => void numbers.refetch()}
                stats={stats}
                canEdit={canEdit}
                total={totalNumbers}
                requestLabel={canRequest ? 'Request numbers' : null}
                onRequest={openNumbers}
                order={7}
                title={admin ? 'Numbers' : 'Your numbers'}
                isAdmin={admin}
                allHref={numbersHref}
              />
              <VolumeCard
                activity={activity}
                onOpen={openActivity}
                order={8}
                emptyText={admin ? 'No calls reached this customer’s numbers in the last 7 days.' : undefined}
              />
              <QualityCard activity={activity} onOpen={openActivity} order={9} />
              <RecentCard
                calls={recent}
                nowMs={recent.dataUpdatedAt}
                onOpen={openActivity}
                order={10}
                sub={admin ? 'The newest calls to this customer’s numbers' : undefined}
              />
              <TeamCard
                team={team}
                nowMs={team.dataUpdatedAt}
                order={11}
                link={admin ? null : MY_ACCOUNT}
                emptyText={admin ? 'No one on this account can sign in yet. People are added in TED.' : undefined}
              />
              <BusiestCard stats={stats} entries={entries} order={12} />
              <RequestsCard
                dids={dids}
                action={{ label: admin ? 'Manage numbers' : numbersLabel, onClick: openNumbers }}
                order={13}
                sub={admin ? 'Open requests on this account' : undefined}
                emptyText={admin ? 'No open number requests on this account.' : undefined}
              />
              <QuickActionsCard actions={quickActions} order={14} />
            </div>
          </>
        ) : (
          <>
            <section className="ad-card ad-prompt" aria-labelledby="ad-noproduct-title">
              <h2 id="ad-noproduct-title" className="ad-prompt-title">
                {admin ? 'No call forwarding on this account' : 'Your products are coming to the dashboard'}
              </h2>
              <p className="ad-quiet">
                {admin
                  ? `${accountName} doesn’t have call forwarding. SIP Trunking and Visual Voicemail get their own dashboard soon — the tools below still work.`
                  : 'This account doesn’t have call forwarding. SIP Trunking and Visual Voicemail get their own dashboard soon — until then, use the sidebar to reach them.'}
              </p>
            </section>
            {admin && (
              <div className="ad-grid">
                <QuickActionsCard actions={quickActions} order={2} />
              </div>
            )}
          </>
        )}
      </div>

      {overlay === 'activity' && (
        <DashboardOverlay
          title="Call activity"
          subtitle={
            admin
              ? `Every call to ${accountName}’s numbers. Pick a number or a time range to narrow it down.`
              : 'Every call to your numbers. Pick a number or a time range to narrow it down.'
          }
          onClose={closeOverlay}
        >
          <CallActivityTab customerId={customer.id} />
        </DashboardOverlay>
      )}

      {overlay === 'numbers' && (
        <DashboardOverlay
          title={canRequest ? 'Request and manage numbers' : admin ? 'Numbers and requests' : 'Your numbers'}
          subtitle={
            canRequest
              ? 'Request new numbers, or ask Granite to release ones you no longer need.'
              : admin
                ? `Numbers assigned to ${accountName} and any open requests.`
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
