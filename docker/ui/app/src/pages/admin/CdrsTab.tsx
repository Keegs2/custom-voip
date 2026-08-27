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
 *   value-identical), and page navigation reuses the exact frozen window —
 *   offsets stay consistent because the window never moves under them.
 * - Records, Summary, and CSV export ALL consume the same committed params
 *   object → identical filter set on the wire for all three.
 *
 * Pagination model (replaced the old load-more, which "maxed out at 50"
 * because the legacy API `count` field — the page row count — was read as a
 * match total, so the infinite query decided everything was loaded):
 * - Plain useQuery keyed on { committedParams, nonce, page, pageSize }. A
 *   new Search resets to page 1; page/size changes reuse the frozen window.
 * - placeholderData carries the previous page's rows ONLY within the same
 *   committed search (reference-compared params + nonce from the previous
 *   query key): page flips keep the table mounted at stable height, dimmed
 *   via `dlx4-fetchdim`, while a NEW search gets the full loading state so
 *   it is obvious the result set changed.
 * - Deliberate scroll behavior: every pagination interaction (page or size)
 *   instantly realigns the viewport to the top of the results block, so the
 *   operator reads the new page from row 1 — the bottom pager never leaves
 *   you staring past the end of a shorter page.
 * - Until the API ships `total`, the pager runs a degraded mode (First /
 *   Prev / "Page N" / Next on a full-page heuristic) — see CdrPaginationBar.
 *
 * React #310: every hook is called unconditionally at the top.
 */
import { useState, useCallback, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { searchCdrs } from '../../api/cdrs';
import { listCustomers } from '../../api/customers';
import { Spinner } from '../../components/ui/Spinner';
import { exportCdrsCsv } from '../../utils/csv';
import { useToast } from '../../components/ui/Toast';
import { CdrFilterBar } from './CdrFilterBar';
import { defaultCdrFilters, filtersToParams, validateCdrFilters } from './cdrFilters';
import { CdrPaginationBar } from './CdrPaginationBar';
import { CdrStatsBar } from './CdrStatsBar';
import { CdrTable } from './CdrTable';
import { CdrSummaryView } from './CdrSummaryView';
import type { CdrFilters } from './cdrFilters';
import type { CdrSearchParams } from '../../types/cdr';
import '../../styles/dl-admin.css';
import '../../styles/dl-platform.css';
import '../../styles/dl-platform-b.css';

/** Initial rows per page — must be one of CdrPaginationBar's size options. */
const DEFAULT_PAGE_SIZE = 50;

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
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [activeTab, setActiveTab] = useState('records');
  const [exporting, setExporting] = useState(false);

  /** Scroll target for pagination interactions — the results block. */
  const resultsRef = useRef<HTMLDivElement | null>(null);

  const { data, isLoading, isError, isFetching, isPlaceholderData } = useQuery({
    queryKey: ['cdrs', committed.params, committed.nonce, page, pageSize],
    queryFn: () =>
      searchCdrs({ ...committed.params, limit: pageSize, offset: (page - 1) * pageSize }),
    // Keep the previous page's rows mounted while the next page fetches —
    // but ONLY across page/size changes within the SAME committed search
    // (the frozen params object is reference-identical there). A new Search
    // commits a fresh params object, so this returns undefined and the
    // query shows the honest full loading state instead of stale rows.
    placeholderData: (prevData, prevQuery) => {
      if (prevQuery == null) return undefined;
      const [, prevParams, prevNonce] = prevQuery.queryKey;
      return prevParams === committed.params && prevNonce === committed.nonce
        ? prevData
        : undefined;
    },
  });

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

  /**
   * Deliberate, single scroll behavior for ALL pagination interactions:
   * instantly align the results block to the viewport top. Instant (not
   * smooth) so a 500-row page never animates for seconds; fired from the
   * interaction handlers (never an effect) so background refetches don't
   * yank the scroll position.
   */
  const scrollToResults = useCallback(() => {
    resultsRef.current?.scrollIntoView({ block: 'start' });
  }, []);

  const handleSearch = useCallback(() => {
    // The filter bar disables Search on invalid input; guard anyway.
    if (validateCdrFilters(draftFilters) !== null) return;
    setCommitted((prev) => ({
      params: filtersToParams(draftFilters),
      nonce: prev.nonce + 1,
    }));
    setPage(1); // a new frozen window always starts on page 1
  }, [draftFilters]);

  const handlePageChange = useCallback(
    (next: number) => {
      setPage(Math.max(1, next));
      scrollToResults();
    },
    [scrollToResults],
  );

  const handlePageSizeChange = useCallback(
    (next: number) => {
      // Position-preserving resize: keep the first visible record on screen
      // under the new window size (e.g. page 6 @ 50/page → page 2 @ 250/page,
      // both starting at record 251) instead of yanking back to page 1.
      setPage((prev) => Math.floor(((prev - 1) * pageSize) / next) + 1);
      setPageSize(next);
      scrollToResults();
    },
    [pageSize, scrollToResults],
  );

  /**
   * CSV export — fetches from the API with the EXACT committed filter set
   * (same serializer, same params object as the Records/Summary queries),
   * not just the client-side loaded page.
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
      const exported = result.items.length.toLocaleString();
      if (result.total != null && result.total > result.items.length) {
        toastOk(
          `Exported first ${exported} of ` +
          `${result.total.toLocaleString()} matching CDRs — narrow the date range for a full export.`,
        );
      } else if (result.total == null && result.items.length === EXPORT_LIMIT) {
        // Legacy API (no match total): a cap-sized export may be truncated.
        toastOk(`Exported first ${exported} CDRs (export cap) — narrow the date range for a full export.`);
      } else {
        toastOk(`Exported ${exported} CDRs`);
      }
    } catch {
      toastErr('Export failed — try again.');
    } finally {
      setExporting(false);
    }
  }, [committed.params, toastOk, toastErr]);

  /* ── Derived pagination state (no effects, no clamping loops) ────────── */

  const cdrs = data?.items ?? [];
  /** Full match count — undefined until the API ships `total`. */
  const total = data?.total;
  const pageCount = total != null ? Math.max(1, Math.ceil(total / pageSize)) : undefined;
  // Authoritative when the total is known; otherwise the full-page heuristic
  // (a page shorter than its limit is the last one).
  const hasNext =
    data != null &&
    (total != null ? data.offset + data.items.length < total : data.items.length >= data.limit);
  // The range readout describes the rows ACTUALLY on screen (data-derived) —
  // during a placeholder transition that is the outgoing page, which is the
  // honest reading while the table sits dimmed.
  const visibleFrom = data != null && data.items.length > 0 ? data.offset + 1 : 0;
  const visibleTo = data != null ? data.offset + data.items.length : 0;
  /** True only during a page/size transition (placeholder rows on screen). */
  const paging = isFetching && isPlaceholderData;
  // Hide the pager when the search legitimately matched nothing; keep it
  // when an unknown-total overrun landed past the end (page > 1, no rows) so
  // the operator can step back.
  const showPager = data != null && (cdrs.length > 0 || page > 1);

  const pagerProps = {
    page,
    pageSize,
    pageCount,
    total,
    rangeStart: visibleFrom,
    rangeEnd: visibleTo,
    hasNext,
    busy: isFetching,
    onPageChange: handlePageChange,
    onPageSizeChange: handlePageSizeChange,
  };

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

      {activeTab === 'records' && cdrs.length > 0 && (
        <CdrStatsBar cdrs={cdrs} total={total} />
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
            <div ref={resultsRef} className="dl-stack" style={{ scrollMarginTop: 12 }}>
              {showPager && <CdrPaginationBar {...pagerProps} />}

              <div
                aria-busy={paging || undefined}
                className={paging ? 'dlx4-fetchdim' : undefined}
              >
                {cdrs.length === 0 && page > 1 ? (
                  // Unknown-total overrun: one Next past the real end (the
                  // full-page heuristic can't see the boundary). Distinct
                  // from "no matches" — the search DID match rows.
                  <div className="dl-empty">
                    <p style={{ fontWeight: 600, margin: 0, color: 'var(--rcf-ink)' }}>
                      Nothing on this page
                    </p>
                    <p style={{ fontSize: '0.74rem', margin: '4px 0 0' }}>
                      The result set ends before page {page.toLocaleString()} — step back with Prev or First.
                    </p>
                  </div>
                ) : (
                  <CdrTable cdrs={cdrs} customerNames={customerNames} />
                )}
              </div>

              {showPager && <CdrPaginationBar {...pagerProps} />}
            </div>
          )}
        </>
      )}

      {activeTab === 'summary' && (
        <CdrSummaryView params={committed.params} nonce={committed.nonce} />
      )}
    </div>
  );
}
