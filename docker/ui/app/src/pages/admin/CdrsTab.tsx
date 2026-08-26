/**
 * CdrsTab — platform CDR search (standalone /cdrs, admin + support).
 *
 * Styling: the shared DAYLIGHT CONSOLE system (`dl-*` in index.css, plus the
 * admin `dlx-*` layer in styles/dl-admin.css and the page-scoped `dlx4-*`
 * layer in styles/dl-platform-b.css). The page shell (CdrsAdminPage) owns the
 * canvas and the single quiet header — this component contributes the filter
 * slab, the stat strip, the Records/Summary segmented control, and results.
 *
 * Search model (the part that was broken):
 * - Filters are edited as DRAFT state. Clicking Search serializes them ONCE
 *   via filtersToParams() — relative presets resolve to concrete UTC instants
 *   at that moment — and commits `{ params, nonce }`.
 * - The committed params + nonce form the react-query key, so every Search
 *   click provably re-runs the request (nonce bumps even when the params are
 *   value-identical), and Load More pages reuse the exact frozen window.
 * - Records (useInfiniteQuery), Summary, and CSV export ALL consume the same
 *   committed params object → identical filter set on the wire for all three.
 *
 * React #310: every hook is called unconditionally at the top.
 */
import { useState, useCallback, useMemo } from 'react';
import { useQuery, useInfiniteQuery } from '@tanstack/react-query';
import { searchCdrs } from '../../api/cdrs';
import { listCustomers } from '../../api/customers';
import { Spinner } from '../../components/ui/Spinner';
import { exportCdrsCsv } from '../../utils/csv';
import { useToast } from '../../components/ui/Toast';
import { CdrFilterBar } from './CdrFilterBar';
import { defaultCdrFilters, filtersToParams, validateCdrFilters } from './cdrFilters';
import { CdrStatsBar } from './CdrStatsBar';
import { CdrTable } from './CdrTable';
import { CdrSummaryView } from './CdrSummaryView';
import type { CdrFilters } from './cdrFilters';
import type { Cdr, CdrSearchParams } from '../../types/cdr';
import '../../styles/dl-admin.css';
import '../../styles/dl-platform.css';
import '../../styles/dl-platform-b.css';

const PAGE_SIZE = 50;

/** The API caps `limit` at 1000 (Query(le=1000)) — one export request max. */
const EXPORT_LIMIT = 1000;

const CDR_TABS = [
  { id: 'records', label: 'Records' },
  { id: 'summary', label: 'Summary' },
];

interface CommittedSearch {
  /** Concrete query params, frozen at Search time (no limit/offset). */
  params: CdrSearchParams;
  /** Bumps on every Search click so identical params still re-fetch. */
  nonce: number;
}

export function CdrsTab() {
  const { toastOk, toastErr } = useToast();

  const [draftFilters, setDraftFilters] = useState<CdrFilters>(defaultCdrFilters);
  const [committed, setCommitted] = useState<CommittedSearch>(() => ({
    params: filtersToParams(defaultCdrFilters()),
    nonce: 0,
  }));
  const [activeTab, setActiveTab] = useState('records');
  const [exporting, setExporting] = useState(false);

  const {
    data,
    isLoading,
    isError,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useInfiniteQuery({
    queryKey: ['cdrs', committed.params, committed.nonce],
    queryFn: ({ pageParam }) =>
      searchCdrs({ ...committed.params, limit: PAGE_SIZE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.items.length, 0);
      if (lastPage.items.length === 0 || loaded >= lastPage.total) return undefined;
      return loaded;
    },
  });

  // Flatten pages, de-duplicating by uuid (fresh CDRs arriving between page
  // fetches shift OFFSET-based pages, so boundaries can overlap).
  const allCdrs = useMemo<Cdr[]>(() => {
    const pages = data?.pages ?? [];
    const seen = new Set<string>();
    const merged: Cdr[] = [];
    for (const page of pages) {
      for (const cdr of page.items) {
        if (!seen.has(cdr.uuid)) {
          seen.add(cdr.uuid);
          merged.push(cdr);
        }
      }
    }
    return merged;
  }, [data]);

  const total = useMemo(() => {
    const pages = data?.pages ?? [];
    return pages.length > 0 ? pages[pages.length - 1].total : 0;
  }, [data]);

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
    // The filter bar disables Search on invalid input; guard anyway.
    if (validateCdrFilters(draftFilters) !== null) return;
    setCommitted((prev) => ({
      params: filtersToParams(draftFilters),
      nonce: prev.nonce + 1,
    }));
  }, [draftFilters]);

  const handleLoadMore = useCallback(() => {
    void fetchNextPage();
  }, [fetchNextPage]);

  /**
   * CSV export — fetches from the API with the EXACT committed filter set
   * (same serializer, same params object as the Records/Summary queries),
   * not just the client-side loaded pages.
   */
  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const result = await searchCdrs({ ...committed.params, limit: EXPORT_LIMIT, offset: 0 });
      if (result.items.length === 0) {
        toastErr('No CDRs match the current filters — nothing to export.');
        return;
      }
      exportCdrsCsv(result.items);
      if (result.total > result.items.length) {
        toastOk(
          `Exported first ${result.items.length.toLocaleString()} of ` +
          `${result.total.toLocaleString()} matching CDRs — narrow the date range for a full export.`,
        );
      } else {
        toastOk(`Exported ${result.items.length.toLocaleString()} CDRs`);
      }
    } catch {
      toastErr('Export failed — try again.');
    } finally {
      setExporting(false);
    }
  }, [committed.params, toastOk, toastErr]);

  const shownCount = allCdrs.length;

  return (
    <div className="dl-stack">
      <CdrFilterBar
        filters={draftFilters}
        onChange={setDraftFilters}
        onSearch={handleSearch}
        onExport={handleExport}
        searching={isLoading}
        exporting={exporting}
      />

      {activeTab === 'records' && allCdrs.length > 0 && (
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
          {isLoading && (
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
                {hasNextPage && (
                  <button
                    type="button"
                    className="dl-btn dl-btn-ghost"
                    disabled={isFetchingNextPage}
                    onClick={handleLoadMore}
                  >
                    {isFetchingNextPage ? 'Loading…' : 'Load More'}
                  </button>
                )}
              </div>
            </>
          )}
        </>
      )}

      {activeTab === 'summary' && (
        <CdrSummaryView params={committed.params} nonce={committed.nonce} />
      )}
    </div>
  );
}
