/**
 * CallActivityTab — RCF console "Call Activity": one filter row (DID +
 * time range) scoping a KPI tile row, a full-range chart and a paginated
 * call log.
 *
 * Data:
 *   - KPIs + chart  → GET /cdrs/activity (server-aggregated over EVERY call in
 *     the range, fixed zero-filled buckets in the viewer's zone). The old tab
 *     aggregated the latest 200 CDRs client-side, so its "7-day" chart only
 *     ever covered the last day or two on a busy account.
 *   - Recent calls  → GET /cdrs over the SAME window (the activity response's
 *     `start`/`end`), server-paginated, so table and chart always agree.
 *     If the activity endpoint is unavailable the table falls back to a
 *     rolling client-computed window rather than going blank.
 *
 * Refetches keep the previous frame on screen (dimmed) — no layout jump when
 * the range or DID changes. RcfPage remounts this tab per customer scope
 * (`key`), so a DID picked under one customer never leaks into another.
 */
import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import { listRcf } from '../../api/rcf';
import { getCdrActivity, searchCdrs } from '../../api/cdrs';
import type { RcfEntry } from '../../types/rcf';
import type { ActivityRange } from '../../types/cdrActivity';
import { Spinner } from '../../components/ui/Spinner';
import { Reveal } from '../../components/fx/Reveal';
import { DEFAULT_PAGE_SIZE } from './theme';
import {
  browserTimeZone, DEFAULT_RANGE, didLabel, fallbackWindow, RANGE_PRESETS, rangePreset,
} from './activityFormat';
import { ActivityDidPicker } from './ActivityDidPicker';
import { ActivityKpis } from './ActivityKpis';
import { ActivityChart } from './ActivityChart';
import { RecentCallsTable } from './RecentCallsTable';

export interface CallActivityTabProps {
  /**
   * Customer filter for /rcf and /cdrs — the admin's selected customer, the
   * tenant's own id, or undefined for "All Customers" (server-scoped).
   */
  customerId: number | undefined;
}

const BUCKET_NOUN = { hour: 'hour', day: 'day', week: 'week' } as const;

export function CallActivityTab({ customerId }: CallActivityTabProps) {
  // ALL hooks unconditionally at top — rules of hooks (#310 prevention)
  const { isAdmin, isSupport } = useAuth();
  // Carrier routing is a platform internal — the API withholds carrier_used
  // from tenant rows, so the Carrier Trunk column is staff-only.
  const showCarrier = isAdmin || isSupport;
  const [range, setRange] = useState<ActivityRange>(DEFAULT_RANGE);
  const [selectedDid, setSelectedDid] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [search, setSearch] = useState('');
  const [tz] = useState(browserTimeZone);

  const { data: rcfData } = useQuery({
    queryKey: ['rcf-dids', customerId],
    queryFn: () => listRcf({ customer_id: customerId, limit: 500 }),
    staleTime: 60_000,
  });
  const rcfEntries: RcfEntry[] = useMemo(() => rcfData?.items ?? [], [rcfData]);

  // Tenants are scoped server-side — only an admin's explicit customer pick
  // is sent to /cdrs/activity ("All Customers" omits it).
  const activityCustomerId = isAdmin ? customerId : undefined;
  const activity = useQuery({
    queryKey: ['rcf-activity', activityCustomerId ?? 'all', range, tz, selectedDid],
    queryFn: () =>
      getCdrActivity({
        range,
        tz,
        customer_id: activityCustomerId,
        product_type: 'rcf',
        destination: selectedDid ?? undefined,
      }),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });
  const activityData = activity.data;
  const activityFresh = activityData !== undefined && !activity.isPlaceholderData;

  // Table window: exactly the activity response's window; a rolling fallback
  // only when the activity endpoint failed; null (wait) while it resolves.
  const errorAt = activity.errorUpdatedAt;
  const callWindow = useMemo<{ start: string; end: string } | null>(() => {
    if (activityFresh && activityData) return { start: activityData.start, end: activityData.end };
    // errorUpdatedAt is the failure instant — stable across renders, so the
    // fallback window (and the table's query key) doesn't churn.
    if (activity.isError) return fallbackWindow(range, errorAt);
    return null;
  }, [activityFresh, activityData, activity.isError, range, errorAt]);

  const calls = useQuery({
    queryKey: ['rcf-activity-calls', customerId ?? 'all', selectedDid, callWindow?.start, callWindow?.end, page, pageSize],
    queryFn: () => {
      if (!callWindow) throw new Error('Call window not resolved');
      return searchCdrs({
        customer_id: customerId,
        product_type: 'rcf',
        destination: selectedDid ?? undefined,
        start_date: callWindow.start,
        end_date: callWindow.end,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
    },
    enabled: callWindow !== null,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });

  const preset = rangePreset(range);
  const selectedLabel = didLabel(rcfEntries, selectedDid);

  function handleRange(next: ActivityRange): void {
    setRange(next);
    setPage(1);
  }

  function handleDid(did: string | null): void {
    setSelectedDid(did);
    setPage(1);
  }

  const chartRefreshing = activity.isFetching && activityData !== undefined;

  return (
    <div className="rcf-act">
      {/* ── Filter row: DID + time range — scopes everything below ── */}
      <div className={`rcf-panel rcf-act-bar fx-load${selectedDid ? ' rcf-act-bar-scoped' : ''}`}>
        {rcfEntries.length > 0 ? (
          <ActivityDidPicker entries={rcfEntries} selectedDid={selectedDid} onChange={handleDid} />
        ) : (
          <div className="rcf-act-didpick">
            <span className="rcf-act-bar-label">Viewing</span>
            <span className="rcf-act-bar-static">All Numbers</span>
          </div>
        )}

        <div className="rcf-seg" role="radiogroup" aria-label="Time range">
          {RANGE_PRESETS.map((r) => (
            <button
              key={r.id}
              type="button"
              role="radio"
              aria-checked={range === r.id}
              title={r.title}
              className={range === r.id ? 'rcf-seg-btn rcf-seg-btn-active' : 'rcf-seg-btn'}
              onClick={() => handleRange(r.id)}
            >
              {r.short}
            </button>
          ))}
        </div>
      </div>

      {/* ── KPI tiles + chart (GET /cdrs/activity) ── */}
      {activity.isError && activityData === undefined ? (
        <div className="rcf-panel rcf-act-state rcf-act-state-error" role="alert">
          Unable to load call activity totals for {preset.phrase}.
          <button type="button" className="rcf-btn rcf-btn-ghost" onClick={() => void activity.refetch()}>
            Try again
          </button>
        </div>
      ) : (
        <>
          <ActivityKpis
            kpis={activityData?.kpis}
            loading={activityData === undefined}
            refreshing={chartRefreshing}
            rangePhrase={preset.phrase}
          />

          <Reveal>
            <div className="rcf-panel">
              <div className="rcf-panel-head">
                <span className="rcf-panel-title">{preset.title}</span>
                {selectedLabel && <span className="rcf-act-chip rcf-act-chip-did">{selectedLabel}</span>}
                <span className="rcf-act-head-sub">
                  Calls per {BUCKET_NOUN[activityData?.bucket ?? 'day']} · answered vs missed, with answer rate and
                  share that sounded good or better · {tz.replace(/_/g, ' ')} time
                </span>
              </div>
              <div className="rcf-act-chart-body">
                {activityData === undefined ? (
                  <div className="rcf-act-state rcf-act-chart-loading">
                    <Spinner size="sm" />
                    <span>Loading call activity…</span>
                  </div>
                ) : (
                  <ActivityChart
                    bucket={activityData.bucket}
                    points={activityData.points}
                    windowEnd={activityData.end}
                    tz={activityData.tz || tz}
                    rangePhrase={rangePreset(activityData.range).phrase}
                    refreshing={chartRefreshing}
                  />
                )}
                {activity.isError && activityData !== undefined && (
                  <div className="rcf-act-inline-error" role="status">
                    Couldn’t refresh — showing the last loaded data.
                  </div>
                )}
              </div>
            </div>
          </Reveal>
        </>
      )}

      {/* ── Recent calls (GET /cdrs over the same window) ── */}
      <Reveal delay={90}>
        <RecentCallsTable
          rows={calls.data?.items ?? []}
          total={calls.data?.total}
          page={page}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
          loading={calls.data === undefined && !calls.isError}
          refreshing={calls.isFetching && calls.data !== undefined}
          isError={calls.isError && calls.data === undefined}
          onRetry={() => void calls.refetch()}
          showCarrier={showCarrier}
          selectedLabel={selectedLabel}
          rangeTitle={preset.title}
          search={search}
          onSearchChange={setSearch}
        />
      </Reveal>
    </div>
  );
}
