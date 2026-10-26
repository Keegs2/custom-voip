/**
 * AccountDashboardView — one customer account's dashboard, as cards:
 *
 *   ┌ Granite header: name · status · since     [ product switcher ] [action] ┐
 *   ┌KPI┐┌KPI┐┌KPI┐┌KPI┐┌KPI┐┌KPI┐   ONE row at desktop: numbers · forwarding · calls · answered · sounded good · team
 *   ┌ Numbers (8) ──────────────────┐ ┌ Call volume (4) ┐   one row, one height: the numbers card shows
 *   │ every product's numbers;      │ │  (absorbs slack) │   8 rows ("Show all" scrolls inside); the
 *   │ rcf row → RowEditor,          │ ├ Call quality (4) ┤   column's Call volume grows to match
 *   │ voicemail row → /voicemail    │ └──────────────────┘
 *   ┌ Recent calls (8) ─────────────┐ ┌ Team (4) ┐            Team follows Recent's height (scrolls inside)
 *   ┌ Busiest (4) ┐ ┌ Requests (4) ┐ ┌ Quick actions (4) ┐  equal heights
 *
 *   admin (seven quick actions):
 *   ┌ Recent calls (8) ─────────────┐ ┌ Requests ┐ + Team (follows)
 *   ┌ Busiest (4) ┐ ┌ Quick actions (8, two columns) ──────┐
 *
 * Layout rules: docker/ui/CLAUDE.md §20 (layout kit).
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
 * Holistic: the numbers card, the Numbers KPI, every call card and the
 * Call activity overlay cover EVERY product on the account (call
 * forwarding, voicemail, SIP trunk, future products via
 * config/products.ts). A call-forwarding-only account looks exactly as it
 * did before; if the every-product list is unavailable (an older API) the
 * view falls back to the call forwarding entries.
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
import { rcfConsoleHref, voicemailConsoleHref } from './adminLinks';
import { DASHBOARD_PRODUCTS, isProductAvailable, type DashboardProductId } from './products';
import { staffScope, tenantScope, useVoicemailSummary } from '../voicemail/voicemailData';
import {
  RCF_LIST_CAP,
  fmtMonthYear,
  numberMix,
  toNumberRows,
  toNumberStats,
  useAccountAllNumbers,
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
  const allNumbers = useAccountAllNumbers(scope);
  const activity = useWeekActivity(customer.id, tz);
  const numberStats = useWeekNumberStats(customer.id, tz);
  const recent = useRecentCalls(customer.id);
  const team = useAccountTeam(scope);
  const dids = useAccountDids(scope);
  // Visual Voicemail is switched on per account: the same summary query and
  // cache key as the sidebar (tenant = own account, no customer_id; staff =
  // this customer's id). Support has no voicemail access (API 403).
  const voicemailScope = useMemo(
    () => (staff ? staffScope(customer.id) : tenantScope(customer.id)),
    [staff, customer.id],
  );
  const voicemail = useVoicemailSummary(voicemailScope, user?.role !== 'support');

  const closeOverlay = useCallback(() => setOverlay(null), []);
  const openNumbers = useCallback(() => setOverlay('numbers'), []);
  const openActivity = useCallback(() => setOverlay('activity'), []);

  const admin = viewer === 'admin';
  // A voicemail number's row opens its voicemail: the customer's own page
  // (tenant, staff preview) or the admin console scoped to this customer.
  const voicemailHref = admin ? voicemailConsoleHref(customer.id) : '/voicemail';
  const entries = useMemo(() => numbers.data?.items ?? [], [numbers.data]);
  const numberRows = useMemo(
    () => toNumberRows(allNumbers.data, entries, { voicemailHref }),
    [allNumbers.data, entries, voicemailHref],
  );
  const rows = numberRows.rows;
  const stats = useMemo(() => toNumberStats(numberStats.data, numberStats.isError), [numberStats.data, numberStats.isError]);

  // The every-product list is still on its (single) way — wait for it rather
  // than flash the call-forwarding-only fallback first.
  const listPending = allNumbers.isPending;
  const holistic = numberRows.source === 'all';
  const accountTotal = summary.data?.rcfCount ?? null;
  const numberFeed = useMemo<Feed<NumberCounts>>(() => {
    if (listPending) return { state: 'loading' };
    if (holistic) {
      // Exact: the list is every number on the account (/rcf only adds editability).
      const rcf = rows.filter((r) => r.product === 'rcf');
      const forwarding = rcf.filter((r) => r.enabled).length;
      return {
        state: 'ready',
        value: { total: rows.length, forwarding, paused: rcf.length - forwarding, partial: false, mix: numberMix(rows) },
      };
    }
    // Fallback (list unavailable): today's call-forwarding-only counts.
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
  }, [listPending, holistic, rows, numbers.isError, numbers.data, entries, accountTotal]);

  // ── Derived values (after all hooks) ──
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
  const voicemailOn = voicemail.data?.enabled === true;
  // Admins land on the voicemail console scoped to this customer.
  const productLinks = voicemailOn ? { voicemail: voicemailHref } : undefined;
  const totalNumbers = numberFeed.state === 'ready' ? numberFeed.value.total : null;
  const numbersHref = admin ? rcfConsoleHref(customer.id) : '/rcf';
  const multiProduct = rows.some((r) => r.product !== 'rcf');
  // Loading until both sources settle (an rcf row without its /rcf entry is
  // read-only, so don't flash that while /rcf is still on its way); an
  // error only when neither source can fill the card.
  const numbersLoading = listPending || numbers.isLoading;
  const numbersError = !numbersLoading && !holistic && numbers.isError && !numbers.data;

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
        voicemailOn,
      })
    : customerQuickActions({
        numbersLabel,
        onNumbers: openNumbers,
        onActivity: openActivity,
        showReports: canSeeReporting(user),
        multiProduct,
        voicemailHref: voicemailOn ? voicemailHref : null,
      });

  return (
    <div className="rcf-scope ad-scope">
      <div className="ad-shell">
        <DashboardHeader
          name={accountName}
          status={summary.data?.status ?? null}
          since={fmtMonthYear(summary.data?.created_at)}
          tag={viewer === 'preview' ? 'Staff preview' : admin ? 'Staff' : null}
          scope={scopePicker}
          products={{ accountType, active: activeProduct, onSelect: setPickedProduct, links: productLinks }}
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
                rows={rows}
                loading={numbersLoading}
                error={numbersError}
                onRetry={() => {
                  void numbers.refetch();
                  void allNumbers.refetch();
                }}
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
              <div className="ad-span-4 ad-col">
                <VolumeCard
                  activity={activity}
                  onOpen={openActivity}
                  order={8}
                  emptyText={admin ? 'No calls reached this customer’s numbers in the last 7 days.' : undefined}
                />
                <QualityCard activity={activity} onOpen={openActivity} order={9} />
              </div>
              <RecentCard
                calls={recent}
                nowMs={recent.dataUpdatedAt}
                onOpen={openActivity}
                order={10}
                sub={admin ? 'The newest calls to this customer’s numbers' : undefined}
              />
              {admin ? (
                // Admin: seven quick actions — a wide two-column slot beside
                // Busiest; the open requests (admin to-dos) and the read-only
                // team share the column beside Recent calls.
                <>
                  <div className="ad-span-4 ad-col">
                    <RequestsCard
                      dids={dids}
                      action={null}
                      order={11}
                      sub="Open requests on this account"
                      emptyText="No open number requests on this account."
                    />
                    <TeamCard
                      team={team}
                      nowMs={team.dataUpdatedAt}
                      order={12}
                      follow
                      link={null}
                      emptyText="No one on this account can sign in yet. People are added in TED."
                    />
                  </div>
                  <BusiestCard stats={stats} rows={rows} order={13} />
                  <QuickActionsCard actions={quickActions} order={14} columns={2} className="ad-span-8 ad-qa-wide" />
                </>
              ) : (
                <>
                  <TeamCard team={team} nowMs={team.dataUpdatedAt} order={11} follow link={MY_ACCOUNT} />
                  <BusiestCard stats={stats} rows={rows} order={12} />
                  <RequestsCard dids={dids} action={{ label: numbersLabel, onClick: openNumbers }} order={13} />
                  <QuickActionsCard actions={quickActions} order={14} />
                </>
              )}
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
                  ? voicemailOn
                    ? `${accountName} doesn’t have call forwarding. Visual Voicemail is on — open it from the switcher above. SIP Trunking gets its own dashboard soon; the tools below still work.`
                    : `${accountName} doesn’t have call forwarding. SIP Trunking and Visual Voicemail get their own dashboard soon — the tools below still work.`
                  : voicemailOn
                    ? 'This account doesn’t have call forwarding. Visual Voicemail is on — open it from the switcher above or the sidebar. SIP Trunking gets its own dashboard soon.'
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
          <CallActivityTab customerId={customer.id} scope="account" numbers={rows} />
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
