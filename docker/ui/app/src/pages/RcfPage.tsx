/**
 * RcfPage — the production /rcf page. THIN composition layer only: it owns the
 * top-level UI state (tab, admin scope, pagination, search, sort, inline-edit
 * buffer) and wires the feature folder together. All data/mutations live in
 * `rcf/hooks`, all presentation in `rcf/components`, all styling in
 * `rcf/styles`, all pure helpers in `rcf/utils`. See docs/FRONTEND_GLASS_REFACTOR.md.
 *
 * The ambient liquid-glass backdrop is mounted app-wide by AppLayout; this page
 * builds frosted glass surfaces (blue accent) on top and adds NO top padding —
 * the layout owns the spacing standard.
 *
 * React #310: every hook is called unconditionally at the top, before any early
 * return or conditional.
 *
 * NOTE: `PortalHeader` is re-exported here (it lives in `rcf/PortalHeader`)
 * because four other pages import it from `./RcfPage` — keep that path stable.
 */

import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { AdminCustomerSelector } from '../components/AdminCustomerSelector';
import type { RcfEntry } from '../types/rcf';
import { RcfCard } from './RcfCard';
import { useRcfNumbers } from './rcf/hooks';
import { DEFAULT_PAGE_SIZE } from './rcf/types';
import type { SortField, SortDir, DashboardTab } from './rcf/types';
import { RcfPageHeader } from './rcf/components/RcfPageHeader';
import { RcfTabBar } from './rcf/components/RcfTabBar';
import { EmptyState, SearchEmptyState, LoadingState, ErrorState } from './rcf/components/states';
import { NumbersToolbar } from './rcf/components/numbers/NumbersToolbar';
import { NumbersTable } from './rcf/components/numbers/NumbersTable';
import { PaginationControls } from './rcf/components/numbers/PaginationControls';
import { CallActivityTab } from './rcf/components/activity/CallActivityTab';
import { DIDManagementTab } from './rcf/components/dids/DidManagementTab';
import { GlassPanel } from '../components/glass/GlassCard';

export { PortalHeader } from './rcf/PortalHeader';

export function RcfPage() {
  // ── All hooks unconditionally at top (React #310) ───────────────────────────
  const { user, isAdmin } = useAuth();

  const [activeTab, setActiveTab] = useState<DashboardTab>('numbers');
  const [adminSelectedCustomer, setAdminSelectedCustomer] = useState<number | undefined>(undefined);
  const customerId = isAdmin ? adminSelectedCustomer : (user?.customer_id ?? undefined);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sortField, setSortField] = useState<SortField>('did');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [pendingEdits, setPendingEdits] = useState<Record<string, string>>({});
  const [npaFilter, setNpaFilter] = useState('');

  const {
    isLoading,
    isError,
    rawEntries,
    serverTotal,
    filteredEntries,
    sortedEntries,
    activeCount,
    disabledCount,
    totalPages,
  } = useRcfNumbers({ customerId, page, pageSize, searchQuery, npaFilter, sortField, sortDir });

  // Cleanup debounce on unmount
  useEffect(() => () => { if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current); }, []);

  // ── Derived (non-hook) ──────────────────────────────────────────────────────
  const role = user?.role ?? 'user';
  const canEdit = role !== 'readonly';
  const useCardView = !isAdmin && role !== 'readonly' && serverTotal <= 10;
  const filterActive = !!(searchQuery || npaFilter.length === 3);
  const pageTitle = user?.customer_name ? `${user.customer_name}'s Numbers` : 'Remote Call Forwarding';

  // ── Handlers ────────────────────────────────────────────────────────────────
  function handleSearchInput(value: string) {
    setSearchInput(value);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => { setSearchQuery(value.trim()); setPage(1); }, 250);
  }

  function handleClearSearch() { setSearchInput(''); setSearchQuery(''); }

  function handleCustomerSelect(id: number | undefined) {
    setAdminSelectedCustomer(id);
    setPage(1);
    setSearchInput('');
    setSearchQuery('');
    setNpaFilter('');
  }

  function handlePendingChange(did: string, value: string) {
    setPendingEdits((prev) => ({ ...prev, [did]: value }));
  }

  function resolveValue(entry: RcfEntry): string {
    return pendingEdits[entry.did] !== undefined ? pendingEdits[entry.did] : entry.forward_to;
  }

  function handleSort(field: SortField) {
    if (sortField === field) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortField(field); setSortDir('asc'); }
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <RcfPageHeader
        title={pageTitle}
        subtitle="Manage your Remote Call Forwarding numbers and monitor call health — all in one place."
        totalNumbers={isLoading ? 0 : serverTotal}
        activeCount={isLoading ? 0 : activeCount}
        disabledCount={isLoading ? 0 : disabledCount}
      />

      {isAdmin && (
        <AdminCustomerSelector
          selectedCustomerId={adminSelectedCustomer}
          onSelect={handleCustomerSelect}
          accent="#3b82f6"
          accountTypes={['rcf', 'hybrid']}
        />
      )}

      <RcfTabBar active={activeTab} onChange={setActiveTab} />

      {/* ── Numbers tab ── */}
      {activeTab === 'numbers' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {!isLoading && !isError && (
            <NumbersToolbar
              searchInput={searchInput}
              onSearchInput={handleSearchInput}
              onClearSearch={handleClearSearch}
              npaFilter={npaFilter}
              onNpaChange={(v) => { setNpaFilter(v); setPage(1); }}
              onClearNpa={() => { setNpaFilter(''); setPage(1); }}
              serverTotal={serverTotal}
              filteredCount={filteredEntries.length}
              rawCount={rawEntries.length}
              filterActive={filterActive}
            />
          )}

          {isLoading && <LoadingState label="Loading your numbers…" />}
          {isError && <ErrorState message="Unable to load RCF numbers. Please try refreshing the page." />}
          {!isLoading && !isError && rawEntries.length === 0 && <EmptyState />}
          {!isLoading && !isError && rawEntries.length > 0 && sortedEntries.length === 0 && searchQuery && (
            <SearchEmptyState query={searchQuery} onClear={handleClearSearch} />
          )}

          {/* Card view (small customer accounts) */}
          {!isLoading && !isError && sortedEntries.length > 0 && useCardView && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                {sortedEntries.map((entry) => (
                  <RcfCard key={entry.id} entry={entry} pendingValue={resolveValue(entry)} onPendingChange={handlePendingChange} />
                ))}
              </div>
              {serverTotal > pageSize && (
                <GlassPanel padding={0}>
                  <PaginationControls
                    currentPage={page}
                    totalPages={totalPages}
                    pageSize={pageSize}
                    totalItems={serverTotal}
                    onPageChange={setPage}
                    onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
                  />
                </GlassPanel>
              )}
            </>
          )}

          {/* Table view */}
          {!isLoading && !isError && sortedEntries.length > 0 && !useCardView && (
            <NumbersTable
              entries={sortedEntries}
              isAdmin={isAdmin}
              canEdit={canEdit}
              sortField={sortField}
              sortDir={sortDir}
              onSort={handleSort}
              resolveValue={resolveValue}
              onPendingChange={handlePendingChange}
              showPagination={serverTotal > pageSize}
              page={page}
              totalPages={totalPages}
              pageSize={pageSize}
              serverTotal={serverTotal}
              onPageChange={setPage}
              onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
            />
          )}
        </div>
      )}

      {/* ── Call Activity tab ── */}
      {activeTab === 'activity' && <CallActivityTab customerId={customerId} />}

      {/* ── DID Management tab ── */}
      {activeTab === 'dids' && <DIDManagementTab customerId={customerId} onSwitchTab={setActiveTab} />}
    </div>
  );
}
