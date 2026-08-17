/**
 * CdrsTab — full CDR search across all customers (/admin/platform/cdrs).
 *
 * Styling: the shared DAYLIGHT CONSOLE system (`dl-*` in index.css, plus the
 * admin `dlx-*` layer in styles/dl-admin.css, the platform `dlx2-*` layer in
 * styles/dl-platform.css, and the page-scoped `dlx4-*` layer in
 * styles/dl-platform-b.css). Renders INSIDE the PlatformManagementPage shell,
 * which owns the paper canvas (`dl-scope`) — this page contributes only the
 * filter slab, the stat strip, the Records/Summary segmented control, and the
 * results table. All search/accumulation/export logic is unchanged.
 *
 * React #310: every hook is called unconditionally at the top.
 */
import { useState, useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { searchCdrs } from '../../api/cdrs';
import { listCustomers } from '../../api/customers';
import { Spinner } from '../../components/ui/Spinner';
import { exportCdrsCsv } from '../../utils/csv';
import { useToast } from '../../components/ui/Toast';
import { CdrFilterBar, defaultCdrFilters, filtersToParams } from './CdrFilterBar';
import { CdrStatsBar } from './CdrStatsBar';
import { CdrTable } from './CdrTable';
import { CdrSummaryView } from './CdrSummaryView';
import type { CdrFilters } from './CdrFilterBar';
import type { Cdr } from '../../types/cdr';
import '../../styles/dl-admin.css';
import '../../styles/dl-platform.css';
import '../../styles/dl-platform-b.css';

const PAGE_SIZE = 50;

const CDR_TABS = [
  { id: 'records', label: 'Records' },
  { id: 'summary', label: 'Summary' },
];

export function CdrsTab() {
  const { toastOk, toastErr } = useToast();

  const [draftFilters, setDraftFilters] = useState<CdrFilters>(defaultCdrFilters);
  const [committedFilters, setCommittedFilters] = useState<CdrFilters>(defaultCdrFilters);
  const [offset, setOffset] = useState(0);
  const [accumulatedCdrs, setAccumulatedCdrs] = useState<Cdr[]>([]);
  const [activeTab, setActiveTab] = useState('records');

  const searchParams = useMemo(
    () => filtersToParams(committedFilters, PAGE_SIZE, offset),
    [committedFilters, offset],
  );

  const { data, isLoading, isFetching, isError } = useQuery({
    queryKey: ['cdrs', searchParams],
    queryFn: async () => {
      const result = await searchCdrs(searchParams);
      return result;
    },
    placeholderData: (prev) => prev,
  });

  const allCdrs = useMemo(() => {
    if (!data) return accumulatedCdrs;
    const pageItems = data.items ?? [];
    if (offset === 0) return pageItems;
    const uuids = new Set(accumulatedCdrs.map((c) => c.uuid));
    const newItems = pageItems.filter((c) => !uuids.has(c.uuid));
    return [...accumulatedCdrs, ...newItems];
  }, [data, offset, accumulatedCdrs]);

  const [prevOffset, setPrevOffset] = useState(0);
  if (data && offset !== prevOffset) {
    setPrevOffset(offset);
    setAccumulatedCdrs(allCdrs);
  } else if (data && offset === 0 && accumulatedCdrs !== (data.items ?? [])) {
    setAccumulatedCdrs(data.items ?? []);
  }

  const { data: customersData } = useQuery({
    queryKey: ['customers-all'],
    queryFn: () => listCustomers({ limit: 500 }),
    staleTime: 5 * 60 * 1000,
  });

  const customerNames = useMemo<Record<number, string>>(() => {
    const map: Record<number, string> = {};
    for (const c of (customersData?.items ?? [])) {
      map[c.id] = c.name;
    }
    return map;
  }, [customersData]);

  const handleSearch = useCallback(() => {
    setCommittedFilters(draftFilters);
    setOffset(0);
    setAccumulatedCdrs([]);
    setActiveTab('records');
  }, [draftFilters]);

  const handleLoadMore = useCallback(() => {
    setOffset((prev) => prev + PAGE_SIZE);
  }, []);

  const handleExport = useCallback(() => {
    if (allCdrs.length === 0) {
      toastErr('No CDRs to export — run a search first.');
      return;
    }
    exportCdrsCsv(allCdrs);
    toastOk('CDR export downloaded');
  }, [allCdrs, toastOk, toastErr]);

  const total = data?.total ?? 0;
  const shownCount = allCdrs.length;
  const loadingMore = isFetching && offset > 0;

  return (
    <div className="dl-stack">
      {/* ── Section identity ── */}
      <div style={{ marginBottom: 0 }}>
        <h2
          style={{
            fontFamily: '"Archivo", "IBM Plex Sans", sans-serif',
            fontSize: '0.95rem',
            fontWeight: 700,
            letterSpacing: '-0.01em',
            color: 'var(--rcf-ink)',
            margin: 0,
          }}
        >
          Call Detail Records
        </h2>
        <p style={{ fontSize: '0.78rem', color: 'var(--rcf-ink-dim)', margin: '3px 0 0' }}>
          Search, inspect, and export platform CDRs across all customers.
        </p>
      </div>

      <CdrFilterBar
        filters={draftFilters}
        onChange={setDraftFilters}
        onSearch={handleSearch}
        onExport={handleExport}
        searching={isLoading}
      />

      {allCdrs.length > 0 && (
        <CdrStatsBar cdrs={allCdrs} total={total} />
      )}

      {/* Records / Summary segmented control */}
      <div className="dlx-seg" role="tablist" aria-label="CDR views" style={{ alignSelf: 'flex-start' }}>
        {CDR_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            className={activeTab === tab.id ? 'dlx-seg-btn dlx-seg-btn-active' : 'dlx-seg-btn'}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'records' && (
        <>
          {isLoading && offset === 0 && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                color: 'var(--rcf-ink-dim)',
                fontSize: '0.85rem',
                padding: '40px 0',
              }}
            >
              <Spinner /> Searching CDRs…
            </div>
          )}

          {isError && (
            <div className="dl-banner dl-banner-err">
              Failed to load CDRs. Check your filters and try again.
            </div>
          )}

          {!isLoading && !isError && data && (
            <>
              <CdrTable cdrs={allCdrs} customerNames={customerNames} />

              {/* Load-more pagination (daylight) */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  fontSize: '0.78rem',
                  color: 'var(--rcf-ink-dim)',
                }}
              >
                <span>
                  Showing{' '}
                  <strong style={{ color: 'var(--rcf-ink)', fontVariantNumeric: 'tabular-nums' }}>
                    {shownCount.toLocaleString()}
                  </strong>{' '}
                  of{' '}
                  <strong style={{ color: 'var(--rcf-ink)', fontVariantNumeric: 'tabular-nums' }}>
                    {total.toLocaleString()}
                  </strong>
                </span>
                {shownCount < total && (
                  <button
                    type="button"
                    className="dl-btn dl-btn-ghost"
                    disabled={loadingMore}
                    onClick={handleLoadMore}
                  >
                    {loadingMore ? 'Loading…' : 'Load More'}
                  </button>
                )}
              </div>
            </>
          )}
        </>
      )}

      {activeTab === 'summary' && (
        <CdrSummaryView customerId={committedFilters.customer_id} />
      )}
    </div>
  );
}
