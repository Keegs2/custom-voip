import { useState, useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { searchCdrs } from '../../api/cdrs';
import { listCustomers } from '../../api/customers';
import { Spinner } from '../../components/ui/Spinner';
import { Pagination } from '../../components/ui/Pagination';
import { TabBar } from '../../components/ui/TabBar';
import { exportCdrsCsv } from '../../utils/csv';
import { useToast } from '../../components/ui/Toast';
import { CdrFilterBar, defaultCdrFilters, filtersToParams } from './CdrFilterBar';
import { CdrStatsBar } from './CdrStatsBar';
import { CdrTable } from './CdrTable';
import { CdrSummaryView } from './CdrSummaryView';
import type { CdrFilters } from './CdrFilterBar';
import type { Cdr } from '../../types/cdr';

const PAGE_SIZE = 50;

const CDR_TABS = [
  { id: 'records', label: 'Records' },
  { id: 'summary', label: 'Summary' },
];

export function CdrsTab() {
  const { toastOk, toastErr } = useToast();

  // Filter state — only committed filters drive the query
  const [draftFilters, setDraftFilters] = useState<CdrFilters>(defaultCdrFilters);
  const [committedFilters, setCommittedFilters] = useState<CdrFilters>(defaultCdrFilters);

  // Pagination: accumulate records across load-more calls
  const [offset, setOffset] = useState(0);
  const [accumulatedCdrs, setAccumulatedCdrs] = useState<Cdr[]>([]);

  // Inner tab: Records vs Summary
  const [activeTab, setActiveTab] = useState('records');

  // Build search params from committed filters
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
    // Keep previous data visible while loading the next page
    placeholderData: (prev) => prev,
  });

  // Merge new page results into the accumulated list
  const allCdrs = useMemo(() => {
    if (!data) return accumulatedCdrs;
    if (offset === 0) {
      // Fresh search — replace everything
      return data.items;
    }
    // Load-more — append uniquely by uuid
    const uuids = new Set(accumulatedCdrs.map((c) => c.uuid));
    const newItems = data.items.filter((c) => !uuids.has(c.uuid));
    return [...accumulatedCdrs, ...newItems];
  }, [data, offset, accumulatedCdrs]);

  // Keep accumulated list in sync when new data arrives
  const [prevOffset, setPrevOffset] = useState(0);
  if (data && offset !== prevOffset) {
    setPrevOffset(offset);
    setAccumulatedCdrs(allCdrs);
  } else if (data && offset === 0 && accumulatedCdrs !== data.items) {
    setAccumulatedCdrs(data.items);
  }

  // Customer name map for the table
  const { data: customersData } = useQuery({
    queryKey: ['customers-all'],
    queryFn: () => listCustomers({ limit: 500 }),
    staleTime: 5 * 60 * 1000,
  });

  const customerNames = useMemo<Record<number, string>>(() => {
    const map: Record<number, string> = {};
    for (const c of customersData?.items ?? []) {
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

  return (
    <div>
      <CdrFilterBar
        filters={draftFilters}
        onChange={setDraftFilters}
        onSearch={handleSearch}
        onExport={handleExport}
        searching={isLoading}
      />

      {/* Stats bar — show after first successful search */}
      {allCdrs.length > 0 && (
        <CdrStatsBar cdrs={allCdrs} total={total} />
      )}

      {/* Inner tab switcher */}
      <TabBar
        tabs={CDR_TABS}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      />

      {/* Records tab */}
      {activeTab === 'records' && (
        <>
          {isLoading && offset === 0 && (
            <div className="flex items-center gap-2 text-[#718096] py-10">
              <Spinner /> Searching CDRs…
            </div>
          )}

          {isError && (
            <p className="text-red-400 text-sm py-4">
              Failed to load CDRs. Check your filters and try again.
            </p>
          )}

          {!isLoading && !isError && data && (
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

      {/* Summary tab */}
      {activeTab === 'summary' && (
        <CdrSummaryView customerId={committedFilters.customer_id} />
      )}
    </div>
  );
}
