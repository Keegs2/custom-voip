/**
 * CustomerDashboard — the customer's view of /rcf: one full-page panel where
 * they can see and do everything at once.
 *
 *   ┌─ OverviewBand (granite) ─────────────────────────────────────────────┐
 *   │ name · status · since                              [Request numbers] │
 *   │ numbers │ forwarding / paused │ calls │ answered │ sounded good │ team │
 *   └──────────────────────────────────────────────────────────────────────┘
 *   ┌─ RoutingBoard (≈ 2/3) ─────────────────┐ ┌─ Rail (≈ 1/3) ───────────┐
 *   │ search · All/Forwarding/Paused · sort   │ │ Calls, last 7 days        │
 *   │ number ━━━ destination  7-day  status   │ │ Team                      │
 *   │ (row → inline RowEditor)                │ │ Number requests           │
 *   └─────────────────────────────────────────┘ └───────────────────────────┘
 *
 * The deep tools are not rebuilt: "Open call activity" hosts the existing
 * CallActivityTab and "Request / Manage numbers" hosts the existing
 * DIDManagementTab, each in a DashboardOverlay.
 *
 * RcfPage renders this only for a non-admin viewer with a customer_id (a
 * tenant, or an admin in "View as Customer"); it is keyed by customerId.
 * Editing permissions are exactly the console's: readonly and support never
 * edit, only the tenant `user` role may request numbers.
 */
import { useCallback, useMemo, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { CallActivityTab } from './CallActivityTab';
import { DIDManagementTab } from './DidManagement';
import { DashboardOverlay } from './DashboardOverlay';
import { OverviewBand, type Feed, type NumberCounts } from './OverviewBand';
import { RoutingBoard, type NumberStats } from './RoutingBoard';
import { CallsPanel, RequestsPanel, TeamPanel } from './DashboardRail';
import { browserTimeZone } from './activityFormat';
import {
  RCF_LIST_CAP,
  fmtMonthYear,
  numberKey,
  useDashboardNumbers,
  useMyCustomer,
  useMyDids,
  useTeam,
  useWeekActivity,
  useWeekNumberStats,
} from './dashboardData';
import type { CdrActivityKpis } from '../../types/cdrActivity';
import type { ReportNumberRow } from '../../types/reports';
import '../../styles/rcf-dashboard.css';

type OverlayKind = 'activity' | 'numbers';

export interface CustomerDashboardProps {
  /** The viewer's own customer account. */
  customerId: number;
}

export function CustomerDashboard({ customerId }: CustomerDashboardProps) {
  // ── ALL hooks unconditionally at the top (React #310) ──
  const { user, isActualAdmin, isSupport } = useAuth();
  const [tz] = useState(browserTimeZone);
  const [overlay, setOverlay] = useState<OverlayKind | null>(null);

  const customer = useMyCustomer();
  const numbers = useDashboardNumbers(customerId);
  const activity = useWeekActivity(customerId, tz);
  const numberStats = useWeekNumberStats(customerId, tz);
  const team = useTeam();
  const dids = useMyDids(customerId);

  const closeOverlay = useCallback(() => setOverlay(null), []);
  const openNumbers = useCallback(() => setOverlay('numbers'), []);
  const openActivity = useCallback(() => setOverlay('activity'), []);

  const entries = useMemo(() => numbers.data?.items ?? [], [numbers.data]);

  const stats = useMemo<NumberStats>(() => {
    // Shape-guarded: per-row figures are an enhancement, so anything
    // unexpected degrades to "unavailable" instead of breaking the board.
    const rows = numberStats.data?.numbers;
    if (Array.isArray(rows)) {
      const byNumber = new Map<string, ReportNumberRow>();
      for (const row of rows) {
        if (row && typeof row.number === 'string') byNumber.set(numberKey(row.number), row);
      }
      return { state: 'ready', byNumber };
    }
    if (numberStats.data) return { state: 'unavailable' };
    return numberStats.isError ? { state: 'unavailable' } : { state: 'loading' };
  }, [numberStats.data, numberStats.isError]);

  const numberFeed = useMemo<Feed<NumberCounts>>(() => {
    if (numbers.isError) return { state: 'error' };
    if (!numbers.data) return { state: 'loading' };
    const forwarding = entries.filter((e) => e.enabled).length;
    const accountTotal = customer.data?.counts.rcf;
    const total = accountTotal !== undefined ? Math.max(accountTotal, entries.length) : entries.length;
    return {
      state: 'ready',
      value: {
        total,
        forwarding,
        paused: entries.length - forwarding,
        partial: entries.length >= RCF_LIST_CAP && total > entries.length,
      },
    };
  }, [numbers.isError, numbers.data, entries, customer.data]);

  // ── Derived values (after all hooks) ──
  const role = user?.role ?? 'user';
  // Same gates as the console: readonly + support never edit; only the
  // tenant `user` role may request numbers (the API 403s everyone else).
  const canEdit = role !== 'readonly' && role !== 'support';
  const canRequest = role === 'user';
  // GET /numbers/my is platform-wide for staff — narrow it when an admin
  // previews customer view. Tenants are already scoped by the API.
  const isStaff = isActualAdmin || isSupport;

  const activityFeed: Feed<CdrActivityKpis> = activity.data
    ? { state: 'ready', value: activity.data.kpis }
    : activity.isError
      ? { state: 'error' }
      : { state: 'loading' };
  const teamFeed: Feed<number> = team.data
    ? { state: 'ready', value: team.data.length }
    : team.isError
      ? { state: 'error' }
      : { state: 'loading' };

  const accountName = customer.data?.name ?? user?.customer_name ?? 'Your account';
  const partialOf = numberFeed.state === 'ready' && numberFeed.value.partial ? numberFeed.value.total : null;

  return (
    <div className="rcf-scope rcfd-scope">
      <div className="rcfd-shell">
        <OverviewBand
          name={accountName}
          status={customer.data?.status ?? null}
          since={fmtMonthYear(customer.data?.created_at)}
          numbers={numberFeed}
          activity={activityFeed}
          teamSize={teamFeed}
          actionLabel={canRequest ? 'Request numbers' : null}
          onAction={openNumbers}
          onRetryActivity={() => void activity.refetch()}
        />

        <div className="rcfd-grid">
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

          <aside className="rcfd-rail" aria-label="Activity, team and requests">
            <CallsPanel activity={activity} stats={stats} entries={entries} onOpen={openActivity} />
            <TeamPanel team={team} nowMs={team.dataUpdatedAt} />
            <RequestsPanel
              dids={dids}
              actionLabel={canRequest ? 'Manage numbers' : 'View numbers'}
              onOpen={openNumbers}
            />
          </aside>
        </div>
      </div>

      {overlay === 'activity' && (
        <DashboardOverlay
          title="Call activity"
          subtitle="Every call to your numbers. Pick a number or a time range to narrow it down."
          onClose={closeOverlay}
        >
          <CallActivityTab customerId={customerId} />
        </DashboardOverlay>
      )}

      {overlay === 'numbers' && (
        <DashboardOverlay
          title={canRequest ? 'Request and manage numbers' : 'Your numbers'}
          subtitle={
            canRequest
              ? 'Request new numbers, or ask Granite to release ones you no longer need.'
              : 'Numbers assigned to your account and any open requests.'
          }
          onClose={closeOverlay}
        >
          <DIDManagementTab
            customerId={customerId}
            filterToCustomer={isStaff ? customerId : undefined}
            onShowNumbers={closeOverlay}
          />
        </DashboardOverlay>
      )}
    </div>
  );
}
