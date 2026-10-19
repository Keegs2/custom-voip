/**
 * AccountDashboard — `/dashboard`, the customer's account home: everything
 * they need at a glance, as cards.
 *
 *   ┌ Granite header: name · status · since     [ product switcher ] [Request numbers] ┐
 *   ┌KPI┐┌KPI┐┌KPI┐┌KPI┐┌KPI┐┌KPI┐   numbers · forwarding · calls · answered · sounded good · team
 *   ┌ Your numbers (8) ─────────────┐ ┌ Call volume (4) ┐
 *   │ small table, row → RowEditor  │ ├ Call quality (4) ┤
 *   ┌ Recent calls (8) ─────────────┐ ┌ Team (4) ┐
 *   ┌ Busiest (4) ┐ ┌ Requests (4) ┐ ┌ Quick actions (4) ┐
 *
 * Which account: AuthContext.effectiveCustomer — the tenant's own, or the
 * customer an admin previews in "View as Customer". The view is keyed on
 * that id so switching the preview remounts it (hook order never changes).
 * Which endpoints: accountData.ts (self-scoped for tenants, admin
 * equivalents for a staff preview).
 *
 * The deep tools are not rebuilt: "Open call activity" hosts the existing
 * CallActivityTab and "Request / Manage numbers" the existing
 * DIDManagementTab, each in a DashboardOverlay. Editing permissions are the
 * console's: readonly and support never edit, only the tenant `user` role
 * may request numbers. No money anywhere.
 */
import { useCallback, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth, type EffectiveCustomer } from '../../contexts/AuthContext';
import { productHome } from '../../utils/productHome';
import { canSeeReporting } from '../../utils/reportingAccess';
import { CallActivityTab } from '../rcf/CallActivityTab';
import { DIDManagementTab } from '../rcf/DidManagement';
import { DashboardOverlay } from '../rcf/DashboardOverlay';
import { browserTimeZone } from '../rcf/activityFormat';
import { DashboardHeader } from './DashboardHeader';
import { KpiRow, type NumberCounts, type TeamCounts } from './KpiCards';
import { NumbersCard } from './NumbersCard';
import { BusiestCard, QualityCard, RecentCard, VolumeCard } from './CallCards';
import { QuickActionsCard, RequestsCard, TeamCard } from './AccountCards';
import { PreviewPrompt } from './PreviewPrompt';
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

/** Route entry: picks the account, or explains why there isn't one. */
export function AccountDashboard() {
  const { user, isAdmin, isActualAdmin, isSupport, customerViewMode, effectiveCustomer } = useAuth();
  if (effectiveCustomer) {
    return (
      <AccountDashboardView
        key={effectiveCustomer.id}
        customer={effectiveCustomer}
        staff={isActualAdmin || isSupport}
      />
    );
  }
  if (isActualAdmin && customerViewMode) return <PreviewPrompt />;
  // Admins (normal view), support, and logins without an account have no
  // dashboard; productHome never points any of them back here.
  return <Navigate to={productHome(user, isAdmin)} replace />;
}

type OverlayKind = 'activity' | 'numbers';

interface AccountDashboardViewProps {
  customer: EffectiveCustomer;
  /** The viewer is staff (an admin previewing this customer). */
  staff: boolean;
}

function AccountDashboardView({ customer, staff }: AccountDashboardViewProps) {
  // ── ALL hooks unconditionally at the top (React #310) ──
  const { user } = useAuth();
  const [tz] = useState(browserTimeZone);
  const [overlay, setOverlay] = useState<OverlayKind | null>(null);
  const [pickedProduct, setPickedProduct] = useState<DashboardProductId | null>(null);
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
        // Without an account count (staff preview) a full first page means
        // "at least this many".
        partial: accountTotal === null && entries.length >= RCF_LIST_CAP,
      },
    };
  }, [numbers.isError, numbers.data, entries, accountTotal]);

  // ── Derived values (after all hooks) ──
  const role = user?.role ?? 'user';
  const canEdit = role !== 'readonly' && role !== 'support';
  const canRequest = role === 'user';
  const numbersLabel = canRequest ? 'Request numbers' : canEdit ? 'Manage numbers' : 'View numbers';
  const headerAction = canRequest ? 'Request numbers' : staff ? 'Manage numbers' : null;

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

  const accountName = summary.data?.name ?? (customer.name || 'Your account');
  const totalNumbers = numberFeed.state === 'ready' ? numberFeed.value.total : null;

  return (
    <div className="rcf-scope ad-scope">
      <div className="ad-shell">
        <DashboardHeader
          name={accountName}
          status={summary.data?.status ?? null}
          since={fmtMonthYear(summary.data?.created_at)}
          accountType={accountType}
          previewing={staff}
          activeProduct={activeProduct}
          onSelectProduct={setPickedProduct}
          actionLabel={activeProduct === 'rcf' ? headerAction : null}
          onAction={openNumbers}
        />

        {activeProduct === 'rcf' ? (
          <>
            <KpiRow numbers={numberFeed} activity={activityFeed} team={teamFeed} onOpenActivity={openActivity} order={1} />

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
              />
              <VolumeCard activity={activity} onOpen={openActivity} order={8} />
              <QualityCard activity={activity} onOpen={openActivity} order={9} />
              <RecentCard calls={recent} nowMs={recent.dataUpdatedAt} onOpen={openActivity} order={10} />
              <TeamCard team={team} nowMs={team.dataUpdatedAt} order={11} />
              <BusiestCard stats={stats} entries={entries} order={12} />
              <RequestsCard dids={dids} actionLabel={numbersLabel} onOpen={openNumbers} order={13} />
              <QuickActionsCard
                numbersLabel={numbersLabel}
                onNumbers={openNumbers}
                onActivity={openActivity}
                showReports={canSeeReporting(user)}
                order={14}
              />
            </div>
          </>
        ) : (
          <section className="ad-card ad-prompt" aria-labelledby="ad-noproduct-title">
            <h2 id="ad-noproduct-title" className="ad-prompt-title">Your products are coming to the dashboard</h2>
            <p className="ad-quiet">
              This account doesn’t have call forwarding. SIP Trunking and Visual Voicemail get their own dashboard
              soon — until then, use the sidebar to reach them.
            </p>
          </section>
        )}
      </div>

      {overlay === 'activity' && (
        <DashboardOverlay
          title="Call activity"
          subtitle="Every call to your numbers. Pick a number or a time range to narrow it down."
          onClose={closeOverlay}
        >
          <CallActivityTab customerId={customer.id} />
        </DashboardOverlay>
      )}

      {overlay === 'numbers' && (
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
