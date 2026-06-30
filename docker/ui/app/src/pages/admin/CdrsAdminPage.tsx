/**
 * CdrsAdminPage — the routed CDRs admin page (`/admin/platform/cdrs`).
 *
 * THIN page: composition + top-level state only. All data fetching, mutations,
 * and the filter→param mapping live in `./cdrs/hooks`; presentation lives in
 * `./cdrs/components`; styles in `./cdrs/styles`. Mirrors the glass refactor
 * convention (docs/FRONTEND_GLASS_REFACTOR.md) and pages/rcf-glass.
 *
 * The ambient GlassBackground is mounted app-wide by AppLayout — this page only
 * builds glass surfaces on top.
 *
 * React #310: every hook sits unconditionally at the top, before any return.
 */

import { useCallback, useState } from 'react';
import { TabBar } from '../../components/ui/TabBar';
import { Pagination } from '../../components/ui/Pagination';
import { useToast } from '../../components/ui/Toast';
import { exportCdrsCsv } from '../../utils/csv';
import { CdrFilterBar } from './cdrs/components/CdrFilterBar';
import { CdrStatsBar } from './cdrs/components/CdrStatsBar';
import { CdrTable } from './cdrs/components/CdrTable';
import { CdrSummaryView } from './cdrs/components/CdrSummaryView';
import { LoadingRow, StateCard } from './cdrs/components/states';
import { IconError } from './cdrs/components/icons';
import { useCdrsSearch, useCustomerNames, defaultCdrFilters } from './cdrs/hooks';
import { GLASS } from '../../components/glass/glass';
import { CDR_TABS, type CdrFilters, type CdrTabId } from './cdrs/types';
import { PAGE_SIZE } from './cdrs/types';

export function CdrsAdminPage() {
  // ── ALL hooks first (React #310) ──────────────────────────────────────────
  const { toastOk, toastErr } = useToast();

  const [draftFilters, setDraftFilters] = useState<CdrFilters>(defaultCdrFilters);
  const [committedFilters, setCommittedFilters] = useState<CdrFilters>(defaultCdrFilters);
  const [offset, setOffset] = useState(0);
  const [resetKey, setResetKey] = useState(0);
  const [activeTab, setActiveTab] = useState<CdrTabId>('records');

  const { allCdrs, total, shownCount, isLoading, isFetching, isError, hasData } = useCdrsSearch({
    committedFilters,
    offset,
    resetKey,
  });
  const customerNames = useCustomerNames();

  const handleSearch = useCallback(() => {
    setCommittedFilters(draftFilters);
    setOffset(0);
    setResetKey((k) => k + 1);
    setActiveTab('records');
  }, [draftFilters]);

  const handleLoadMore = useCallback(() => setOffset((prev) => prev + PAGE_SIZE), []);

  const handleExport = useCallback(() => {
    if (allCdrs.length === 0) {
      toastErr('No CDRs to export — run a search first.');
      return;
    }
    exportCdrsCsv(allCdrs);
    toastOk('CDR export downloaded');
  }, [allCdrs, toastOk, toastErr]);

  // ── Composition only ───────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <CdrFilterBar
        filters={draftFilters}
        onChange={setDraftFilters}
        onSearch={handleSearch}
        onExport={handleExport}
        searching={isLoading}
      />

      {allCdrs.length > 0 && <CdrStatsBar cdrs={allCdrs} total={total} />}

      <TabBar tabs={CDR_TABS} activeTab={activeTab} onTabChange={(id) => setActiveTab(id as CdrTabId)} />

      {activeTab === 'records' && (
        <>
          {isLoading && offset === 0 && <LoadingRow label="Searching CDRs…" />}

          {isError && (
            <StateCard
              accent={GLASS.danger}
              icon={<IconError />}
              title="Failed to load CDRs"
              body="The CDR search failed. Check your filters and try again."
            />
          )}

          {!isLoading && !isError && hasData && (
            <>
              <CdrTable cdrs={allCdrs} customerNames={customerNames} />
              <Pagination
                shown={shownCount}
                total={total}
                onLoadMore={handleLoadMore}
                loading={isFetching && offset > 0}
              />
            </>
          )}
        </>
      )}

      {activeTab === 'summary' && <CdrSummaryView customerId={committedFilters.customer_id} />}
    </div>
  );
}
