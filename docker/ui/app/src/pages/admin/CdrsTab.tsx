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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
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

      <TabBar
        tabs={CDR_TABS}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      />

      {activeTab === 'records' && (
        <>
          {isLoading && offset === 0 && (
            <div className="flex items-center gap-2.5 text-[#718096] py-12">
              <Spinner /> Searching CDRs…
            </div>
          )}

          {isError && (
            <div
              style={{
                padding: '16px 20px',
                borderRadius: 12,
                background: 'rgba(239,68,68,0.08)',
                border: '1px solid rgba(239,68,68,0.2)',
                color: '#f87171',
                fontSize: '0.875rem',
              }}
            >
              Failed to load CDRs. Check your filters and try again.
            </div>
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

      {activeTab === 'summary' && (
        <CdrSummaryView customerId={committedFilters.customer_id} />
      )}
    </div>
  );
}
