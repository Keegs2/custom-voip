/**
 * The paginated call list — newest first, start time only, whole-minute
 * lengths, plain-English outcome labels. Paging is server-side
 * (`limit`/`offset` on `/reports/calls`); the pager is the shared
 * CdrPaginationBar so it looks and behaves like Calls & Quality.
 *
 * Outcome / direction filters are owned by the page (the CSV export sends
 * the same ones); page + page size live here and reset whenever the page
 * remounts this component for a new report scope (keyed by the caller).
 */
import { useRef, useState } from 'react';
import { ListOrdered } from 'lucide-react';
import { CdrPaginationBar } from '../calls/CdrPaginationBar';
import type { DirectionFilter, OutcomeFilter, ReportScope } from '../../types/reports';
import { CardError, GradeBadge, OutcomeBadge, ReportCard, Skeleton } from './ReportBits';
import { fmtCallDate, fmtCallLength, fmtCallTime, fmtCount, fmtPhone } from './reportFormat';
import { useReportCalls } from './useReports';

const DEFAULT_PAGE_SIZE = 50;

export interface CallListFilters {
  outcome: OutcomeFilter;
  direction: DirectionFilter;
}

const OUTCOME_OPTIONS: ReadonlyArray<{ id: OutcomeFilter; label: string }> = [
  { id: 'all', label: 'All calls' },
  { id: 'answered', label: 'Answered' },
  { id: 'missed', label: 'Missed' },
];

const DIRECTION_OPTIONS: ReadonlyArray<{ id: DirectionFilter; label: string }> = [
  { id: 'all', label: 'Both ways' },
  { id: 'inbound', label: 'Incoming' },
  { id: 'outbound', label: 'Outgoing' },
];

interface CallListProps {
  scope: ReportScope;
  enabled: boolean;
  filters: CallListFilters;
  onFiltersChange: (filters: CallListFilters) => void;
}

export function CallList({ scope, enabled, filters, onFiltersChange }: CallListProps) {
  // ALL hooks unconditionally at the top (React #310 prevention).
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const topRef = useRef<HTMLDivElement | null>(null);

  const query = useReportCalls(
    scope,
    { outcome: filters.outcome, direction: filters.direction, limit: pageSize, offset: (page - 1) * pageSize },
    enabled,
  );

  const data = query.data;
  const rows = data?.calls ?? [];
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const paging = query.isFetching && query.isPlaceholderData;
  const rangeStart = rows.length > 0 ? (page - 1) * pageSize + 1 : 0;
  const rangeEnd = rows.length > 0 ? (page - 1) * pageSize + rows.length : 0;

  function scrollToTop(): void {
    topRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function changePage(next: number): void {
    setPage(next);
    scrollToTop();
  }

  function changePageSize(size: number): void {
    setPageSize(size);
    setPage(1);
    scrollToTop();
  }

  function setFilter<K extends keyof CallListFilters>(key: K, value: CallListFilters[K]): void {
    setPage(1);
    onFiltersChange({ ...filters, [key]: value });
  }

  const pager = data && total > 0 && (
    <CdrPaginationBar
      page={page}
      pageSize={pageSize}
      pageCount={pageCount}
      total={total}
      rangeStart={rangeStart}
      rangeEnd={rangeEnd}
      hasNext={page < pageCount}
      busy={query.isFetching}
      onPageChange={changePage}
      onPageSizeChange={changePageSize}
      ariaLabel="Call list pages"
    />
  );

  return (
    <div ref={topRef} style={{ scrollMarginTop: 12 }}>
      <ReportCard
        title="Every call"
        icon={<ListOrdered size={16} />}
        headExtra={data ? <span className="dl-count">{fmtCount(total)}</span> : undefined}
        explainer={
          <>
            <p>
              Every call in this period, newest first. <strong>From</strong> is who called and <strong>To</strong>{' '}
              is who they called. Times are the moment the call started, in your time zone.
            </p>
            <p>
              <strong>Length</strong> is how long an answered call lasted, rounded to whole minutes — so a short
              answered call shows as “about 1 min”. Missed calls have no length.
            </p>
          </>
        }
      >
        <div className="rpt-listfilters" style={{ margin: '-20px -20px 0' }}>
          <div className="rpt-listfilters-group">
            <span className="dl-flabel" id="rpt-f-outcome" style={{ margin: 0 }}>Show</span>
            <div className="dlx-seg" role="group" aria-labelledby="rpt-f-outcome">
              {OUTCOME_OPTIONS.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  aria-pressed={filters.outcome === o.id}
                  className={filters.outcome === o.id ? 'dlx-seg-btn dlx-seg-btn-active' : 'dlx-seg-btn'}
                  onClick={() => setFilter('outcome', o.id)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          <div className="rpt-listfilters-group">
            <span className="dl-flabel" id="rpt-f-direction" style={{ margin: 0 }}>Direction</span>
            <div className="dlx-seg" role="group" aria-labelledby="rpt-f-direction">
              {DIRECTION_OPTIONS.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  aria-pressed={filters.direction === o.id}
                  className={filters.direction === o.id ? 'dlx-seg-btn dlx-seg-btn-active' : 'dlx-seg-btn'}
                  onClick={() => setFilter('direction', o.id)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {query.isLoading && (
          <div role="status" aria-label="Loading calls" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} height={18} />)}
          </div>
        )}

        {!query.isLoading && query.error != null && !data && (
          <CardError error={query.error} onRetry={() => void query.refetch()} what="your calls" />
        )}

        {data && total === 0 && (
          <div className="dl-empty">
            {filters.outcome !== 'all' || filters.direction !== 'all'
              ? 'No calls match these filters. Try “All calls” and “Both ways”.'
              : 'No calls in this period yet.'}
          </div>
        )}

        {data && total > 0 && (
          <div className="dl-stack" style={{ gap: 12 }}>
            {pager}
            {query.error != null && (
              <div className="dl-banner dl-banner-err" role="alert">That page didn’t load — showing the last one. Try again in a moment.</div>
            )}
            <div
              className={paging ? 'dl-panel dlx4-fetchdim' : 'dl-panel'}
              style={{ boxShadow: 'none' }}
              aria-busy={paging || undefined}
            >
              <div className="dlx4-tablewrap">
                <table className="rpt-table" style={{ minWidth: 780 }}>
                  <caption className="rpt-sr">Calls, newest first</caption>
                  <thead>
                    <tr>
                      <th className="dl-th" scope="col">Date</th>
                      <th className="dl-th" scope="col">Time</th>
                      <th className="dl-th" scope="col">Direction</th>
                      <th className="dl-th" scope="col">From</th>
                      <th className="dl-th" scope="col">To</th>
                      <th className="dl-th" scope="col">What happened</th>
                      <th className="dl-th" scope="col">Length</th>
                      <th className="dl-th" scope="col">Quality</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((c) => (
                      <tr key={c.id} className="dl-row">
                        <td style={{ whiteSpace: 'nowrap' }}>{fmtCallDate(c.started_at, scope.tz)}</td>
                        <td style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{fmtCallTime(c.started_at, scope.tz)}</td>
                        <td className="rpt-dim">{c.direction === 'inbound' ? 'Incoming' : 'Outgoing'}</td>
                        <td><span className="rpt-mono">{fmtPhone(c.from)}</span></td>
                        <td><span className="rpt-mono">{fmtPhone(c.to)}</span></td>
                        <td><OutcomeBadge outcome={c.outcome} label={c.outcome_label} /></td>
                        <td style={{ whiteSpace: 'nowrap' }} className={c.length_minutes > 0 ? undefined : 'rpt-dim'}>
                          {fmtCallLength(c.length_minutes)}
                        </td>
                        <td><GradeBadge grade={c.quality} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            {pager}
          </div>
        )}
      </ReportCard>
    </div>
  );
}
