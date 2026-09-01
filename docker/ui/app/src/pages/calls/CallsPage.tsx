/**
 * CallsPage — the merged Calls & Quality page. One page replaces the old CDR
 * Search (/cdrs) and Call Quality (/call-quality) pages; BOTH routes render
 * it so bookmarks keep working.
 *
 * Composition (top → bottom):
 *   1. Quiet daylight header (role-aware copy).
 *   2. Filter slab — the CDR Search committed-search filter bar (the dynamic
 *      one), extended with the quality page's trunk selector + the newly
 *      exposed server params (zone, trunk_id). See CallsFilterBar.
 *   3. KPI strip — union of both pages' figures (page-scoped, honest).
 *   4. Quality Trends — the three polished charts, collapsible, own
 *      window-wide fetch gated on expansion. See QualityTrendsSection.
 *   5. Records / Summary segmented control (Summary is staff-only — it
 *      exposes cost).
 *   6. Server-paginated results table; row click opens CdrDetailModal.
 *
 * Search model (inherited verbatim from CdrsTab — the part that was once
 * broken and then fixed):
 * - Filters are edited as DRAFT state. Clicking Search serializes them ONCE
 *   via filtersToParams() — relative presets resolve to concrete UTC
 *   instants at that moment — and commits `{ params, nonce }`.
 * - The committed params + nonce form the react-query key, so every Search
 *   click provably re-runs the request (nonce bumps even when the params are
 *   value-identical), and page navigation reuses the exact frozen window —
 *   offsets stay consistent because the window never moves under them.
 * - Records, Summary, CSV export, and the trend charts ALL consume the same
 *   committed params object → identical filter set on the wire for all four.
 *
 * Pagination model (PR #84 mechanics, verbatim):
 * - Plain useQuery keyed on { committedParams, nonce, page, pageSize }. A
 *   new Search resets to page 1; page/size changes reuse the frozen window.
 * - placeholderData carries the previous page's rows ONLY within the same
 *   committed search (reference-compared params + nonce from the previous
 *   query key): page flips keep the table mounted at stable height, dimmed
 *   via `dlx4-fetchdim`, while a NEW search gets the full loading state.
 * - Every pagination interaction instantly realigns the viewport to the top
 *   of the results block.
 * - Until the API ships `total`, the pager runs a degraded mode (First /
 *   Prev / "Page N" / Next on a full-page heuristic) — see CdrPaginationBar.
 *
 * Role gating (presentation only — the API tenant-scopes data server-side):
 * staff = admin (incl. support: today's /cdrs audience). Staff-only:
 * customer + zone filters, Customer + Cost columns, money KPIs, Billing
 * modal section, Summary tab, CSV export. The Rate CDR write inside the
 * modal is strictly admin. Tenants see their own calls with full quality
 * depth and zero money.
 *
 * React #310: every hook is called unconditionally at the top.
 */
import { useState, useCallback, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { searchCdrs } from '../../api/cdrs';
import { listCustomers } from '../../api/customers';
import { listTrunks } from '../../api/trunks';
import { carrierLabel } from './callsFormat';
import { useAuth } from '../../contexts/AuthContext';
import { Spinner } from '../../components/ui/Spinner';
import { exportCdrsCsv } from '../../utils/csv';
import { useToast } from '../../components/ui/Toast';
import { CallsFilterBar } from './CallsFilterBar';
import { defaultCallsFilters, filtersToParams, validateCallsFilters } from './callsFilters';
import { CdrPaginationBar } from './CdrPaginationBar';
import { CallsKpiStrip } from './CallsKpiStrip';
import { CallsTable } from './CallsTable';
import { CdrSummaryView } from './CdrSummaryView';
import { CdrDetailModal } from './CdrDetailModal';
import { QualityTrendsSection } from './QualityTrendsSection';
import type { CallsFilters } from './callsFilters';
import type { Cdr, CdrSearchParams } from '../../types/cdr';
import '../../styles/dl-admin.css';
import '../../styles/dl-platform.css';
import '../../styles/dl-platform-b.css';
import '../../styles/dl-call-quality.css';

/** Initial rows per page — must be one of CdrPaginationBar's size options. */
const DEFAULT_PAGE_SIZE = 50;

/** The API caps `limit` at 1000 (Query(le=1000)) — one export request max. */
const EXPORT_LIMIT = 1000;

const VIEW_TABS = [
  { id: 'records', label: 'Records' },
  { id: 'summary', label: 'Summary' },
];

interface CommittedSearch {
  /** Concrete query params, frozen at Search time (no limit/offset). */
  params: CdrSearchParams;
  /** Bumps on every Search click so identical params still re-fetch. */
  nonce: number;
}

export function CallsPage() {
  // ALL hooks unconditionally at the top — React #310 prevention.
  const { isAdmin, isSupport } = useAuth();
  const { toastOk, toastErr } = useToast();

  // Staff = platform read scope (admin + support). All money/fleet gating
  // keys off this; the Rate CDR write additionally requires isAdmin.
  const isStaff = isAdmin || isSupport;

  const [draftFilters, setDraftFilters] = useState<CallsFilters>(defaultCallsFilters);
  const [committed, setCommitted] = useState<CommittedSearch>(() => ({
    params: filtersToParams(defaultCallsFilters()),
    nonce: 0,
  }));
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [activeTab, setActiveTab] = useState('records');
  const [exporting, setExporting] = useState(false);
  const [quickFilter, setQuickFilter] = useState('');
  const [selectedCdr, setSelectedCdr] = useState<Cdr | null>(null);

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

  // Customer names for the staff-only Customer column. Tenants never fetch
  // /customers (and never render the column).
  const { data: customersData } = useQuery({
    queryKey: ['customers-all'],
    queryFn: () => listCustomers({ limit: 500 }),
    staleTime: 5 * 60 * 1000,
    enabled: isStaff,
  });

  const customerNames = useMemo<Record<number, string>>(() => {
    const map: Record<number, string> = {};
    for (const c of (customersData?.items ?? [])) {
      map[c.id] = c.name;
    }
    return map;
  }, [customersData]);

  // Trunk names for the Trunk column + CSV. Same query key + fn as the
  // filter bar's UNSCOPED trunks fetch (['trunks-for-cdr-filter', '']), so
  // React Query dedupes them into one request in the default "All Customers"
  // state — NO per-row fetches. Tenants only ever get their own trunks
  // (listTrunks is tenant-scoped server-side).
  const { data: trunksData } = useQuery({
    queryKey: ['trunks-for-cdr-filter', ''],
    queryFn: () => listTrunks({ limit: 500 }),
    staleTime: 2 * 60 * 1000,
  });

  const trunkNames = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const t of (trunksData?.items ?? [])) {
      map[String(t.id)] = t.trunk_name;
    }
    return map;
  }, [trunksData]);

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
    if (validateCallsFilters(draftFilters) !== null) return;
    setCommitted((prev) => ({
      params: filtersToParams(draftFilters),
      nonce: prev.nonce + 1,
    }));
    setPage(1); // a new frozen window always starts on page 1
    setQuickFilter(''); // page-scoped quick filter resets with the result set
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
   * not just the client-side loaded page. Staff only (the button is hidden
   * for tenants).
   */
  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const result = await searchCdrs({ ...committed.params, limit: EXPORT_LIMIT, offset: 0 });
      if (result.items.length === 0) {
        toastErr('No CDRs match the current filters — nothing to export.');
        return;
      }
      exportCdrsCsv(result.items, trunkNames);
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
  }, [committed.params, trunkNames, toastOk, toastErr]);

  const handleSelect = useCallback((cdr: Cdr) => {
    setSelectedCdr(cdr);
  }, []);

  const handleCloseModal = useCallback(() => setSelectedCdr(null), []);

  /* ── Derived pagination state (no effects, no clamping loops) ────────── */

  const cdrs = useMemo(() => data?.items ?? [], [data]);

  // Page-scoped quick filter (the Call Quality page's free-text search).
  // Deliberately CLIENT-SIDE over the loaded page — the table toolbar labels
  // it as such; server-side narrowing is the filter bar's job.
  const visibleCdrs = useMemo(() => {
    const q = quickFilter.trim().toLowerCase();
    if (!q) return cdrs;
    return cdrs.filter((c) =>
      c.caller_id.toLowerCase().includes(q) ||
      c.destination.toLowerCase().includes(q) ||
      (c.hangup_cause ?? '').toLowerCase().includes(q) ||
      c.uuid.toLowerCase().includes(q) ||
      c.direction.includes(q) ||
      (c.read_codec ?? '').toLowerCase().includes(q) ||
      (customerNames[c.customer_id] ?? '').toLowerCase().includes(q) ||
      // Carrier: both the rendered label ("bw·dallas", "on-net") and the raw
      // stored values, so either vocabulary matches.
      carrierLabel(c).toLowerCase().includes(q) ||
      (c.carrier_used ?? '').toLowerCase().includes(q) ||
      (c.inbound_carrier ?? '').toLowerCase().includes(q) ||
      // Trunk: resolved name (or the raw id for unresolved trunks).
      (c.trunk_id != null
        ? (trunkNames[String(c.trunk_id)] ?? String(c.trunk_id)).toLowerCase().includes(q)
        : false),
    );
  }, [cdrs, quickFilter, customerNames, trunkNames]);

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
    <div className="dl-scope">
      {/* dlx4-shell-wide: page-scoped 1800px cap (vs the shared 1200px
          .dl-shell) so the CDR table gets real width — see dl-platform-b.css */}
      <div className="dl-shell dlx4-shell-wide">
        {/* ── Quiet page header ─────────────────────────────────────── */}
        <header className="dl-header fx-load">
          <div className="dl-header-id">
            <div className="dl-crumb">
              <span>{isStaff ? 'Support' : 'Voice'}</span>
              <span className="dl-crumb-sep" aria-hidden="true">/</span>
              <span>Granite CRAG</span>
            </div>
            <h1 className="dl-title">Calls &amp; Quality</h1>
            <p className="dl-sub">
              {isStaff
                ? 'Call detail records with voice-quality diagnostics — search, inspect, export.'
                : 'Your call history with voice-quality diagnostics — MOS, packet loss, jitter, and RTP detail for every call.'}
            </p>
          </div>
        </header>

        <div className="dl-stack fx-load fx-load-d1" style={{ paddingBottom: 24 }}>
          <CallsFilterBar
            filters={draftFilters}
            onChange={setDraftFilters}
            onSearch={handleSearch}
            onExport={() => void handleExport()}
            searching={isLoading}
            exporting={exporting}
            isStaff={isStaff}
          />

          {isError && (
            <div className="dl-banner dl-banner-err">
              Failed to load CDRs. Check your filters and try again.
            </div>
          )}

          {activeTab === 'records' && !isLoading && !isError && cdrs.length > 0 && (
            <CallsKpiStrip cdrs={cdrs} total={total} isStaff={isStaff} />
          )}

          {/* Quality trends — collapsible, own window-wide fetch */}
          <QualityTrendsSection params={committed.params} nonce={committed.nonce} />

          {/* Records / Summary segmented control — Summary exposes cost, so
              it is staff-only; tenants get the Records view directly. */}
          {isStaff && (
            <div className="dlx-seg" role="tablist" aria-label="CDR views" style={{ alignSelf: 'flex-start' }}>
              {VIEW_TABS.map((tab) => (
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
          )}

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
                      <CallsTable
                        cdrs={visibleCdrs}
                        pageRowCount={cdrs.length}
                        customerNames={isStaff ? customerNames : undefined}
                        trunkNames={trunkNames}
                        quickFilter={quickFilter}
                        onQuickFilterChange={setQuickFilter}
                        onSelect={handleSelect}
                        selectedUuid={selectedCdr?.uuid ?? null}
                        isStaff={isStaff}
                      />
                    )}
                  </div>

                  {showPager && <CdrPaginationBar {...pagerProps} />}
                </div>
              )}
            </>
          )}

          {activeTab === 'summary' && isStaff && (
            <CdrSummaryView params={committed.params} nonce={committed.nonce} />
          )}
        </div>
      </div>

      {/* The call-detail modal — the merged expanded-row + quality sheet */}
      {selectedCdr && (
        <CdrDetailModal
          cdr={selectedCdr}
          onClose={handleCloseModal}
          isStaff={isStaff}
          isAdmin={isAdmin}
        />
      )}
    </div>
  );
}
