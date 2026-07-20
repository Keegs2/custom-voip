/**
 * Data + logic layer for the Call Quality page.
 *
 * Per the refactor convention (docs/FRONTEND_GLASS_REFACTOR.md): the page does
 * composition + top-level state only; ALL data fetching, mutations, and derived
 * pipelines live here. Presentational components stay dumb.
 *
 * React #310: every hook below is called unconditionally at the top of its hook
 * function — no early return precedes a hook.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { searchCdrs, getCdr } from '../../api/cdrs';
import { listCustomers } from '../../api/customers';
import { listTrunks } from '../../api/trunks';
import type { Cdr } from '../../types/cdr';
import type { Customer } from '../../types/customer';
import type { Trunk } from '../../types/trunk';
import { buildDailyQuality, computeOverviewStats } from './quality';
import type { FilterState, OverviewStats, SortKey, SortState, TrendPoint } from './types';
import { TABLE_PAGE_SIZE } from './types';

// ── Reference data (dropdowns) ───────────────────────────────────────────────

export interface UseReferenceDataResult {
  customers: Customer[];
  trunks: Trunk[];
}

/**
 * Customers list (static) + trunks scoped to the live customer selection. The
 * trunk dropdown follows the *live* (un-applied) customer so it updates as the
 * user changes the filter, matching the original page behaviour.
 */
export function useReferenceData(liveCustomerId: number | null): UseReferenceDataResult {
  const { data: customersData } = useQuery({
    queryKey: ['customers', 'all'],
    queryFn: () => listCustomers({ limit: 500 }),
    staleTime: 120_000,
  });

  const { data: trunksData } = useQuery({
    queryKey: ['trunks', 'all', liveCustomerId],
    queryFn: () => listTrunks({ customer_id: liveCustomerId ?? undefined, limit: 500 }),
    staleTime: 120_000,
  });

  return {
    customers: customersData?.items ?? [],
    trunks: trunksData?.items ?? [],
  };
}

// ── CDR query + derived analytics ────────────────────────────────────────────

export interface UseCallQualityResult {
  /** Raw query envelope (for the "x of y records" footer). */
  cdrData: { total: number } | undefined;
  /** Trunk + number filtered CDR set. */
  allCdrs: Cdr[];
  overviewStats: OverviewStats;
  mosPts: TrendPoint[];
  plPts: TrendPoint[];
  jPts: TrendPoint[];
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

/**
 * Owns the `['callQualityCdrs', params]` query plus the whole derived analytics
 * pipeline (trunk/number client filter → overview stats → daily trend points).
 * Driven entirely by the page's `appliedFilters`.
 */
export function useCallQuality(appliedFilters: FilterState): UseCallQualityResult {
  const searchParams = useMemo(() => ({
    customer_id: appliedFilters.customerId ?? undefined,
    direction: appliedFilters.direction !== 'all' ? appliedFilters.direction : undefined,
    start_from: `${appliedFilters.startDate}T00:00:00`,
    start_to: `${appliedFilters.endDate}T23:59:59`,
    product_type: appliedFilters.productType !== 'all' ? appliedFilters.productType : undefined,
    limit: 1000,
  }), [appliedFilters]);

  const { data: cdrData, isLoading, isError, refetch } = useQuery({
    queryKey: ['callQualityCdrs', searchParams],
    queryFn: () => searchCdrs(searchParams),
    staleTime: 60_000,
  });

  const allCdrs = useMemo<Cdr[]>(() => {
    let items = cdrData?.items ?? [];

    if (appliedFilters.trunkId != null) {
      const trunkStr = String(appliedFilters.trunkId);
      items = items.filter((c) => c.trunk_id === trunkStr);
    }

    if (appliedFilters.numberSearch.trim()) {
      const q = appliedFilters.numberSearch.trim().toLowerCase();
      items = items.filter((c) => c.caller_id.includes(q) || c.destination.includes(q));
    }

    return items;
  }, [cdrData, appliedFilters.trunkId, appliedFilters.numberSearch]);

  const overviewStats = useMemo(() => computeOverviewStats(allCdrs), [allCdrs]);

  const startDateObj = useMemo(() => new Date(`${appliedFilters.startDate}T00:00:00`), [appliedFilters.startDate]);
  const endDateObj = useMemo(() => new Date(`${appliedFilters.endDate}T23:59:59`), [appliedFilters.endDate]);

  const dailyQuality = useMemo(() => buildDailyQuality(allCdrs, startDateObj, endDateObj), [allCdrs, startDateObj, endDateObj]);

  const mosPts = useMemo<TrendPoint[]>(() => dailyQuality.map((d) => ({ date: d.date, label: d.label, value: d.avgMos })), [dailyQuality]);
  const plPts = useMemo<TrendPoint[]>(() => dailyQuality.map((d) => ({ date: d.date, label: d.label, value: d.avgPacketLossPct })), [dailyQuality]);
  const jPts = useMemo<TrendPoint[]>(() => dailyQuality.map((d) => ({ date: d.date, label: d.label, value: d.avgJitterMs })), [dailyQuality]);

  return {
    cdrData: cdrData ? { total: cdrData.total } : undefined,
    allCdrs,
    overviewStats,
    mosPts,
    plPts,
    jPts,
    isLoading,
    isError,
    refetch: () => void refetch(),
  };
}

// ── CDR table view state (search / sort / page) ──────────────────────────────

export interface UseCdrTableViewResult {
  search: string;
  setSearch: (v: string) => void;
  sort: SortState;
  toggleSort: (key: SortKey) => void;
  page: number;
  setPage: (p: number) => void;
  customerMap: Map<number, string>;
  filteredCount: number;
  pageItems: Cdr[];
  pageCount: number;
}

/**
 * Encapsulates the CDR table's independent search/sort/pagination pipeline so
 * the table component stays presentational. PAGE_SIZE-sliced and reset-aware.
 */
export function useCdrTableView(cdrs: Cdr[], customers: Customer[]): UseCdrTableViewResult {
  const [search, setSearchRaw] = useState('');
  const [sort, setSort] = useState<SortState>({ key: 'start_time', dir: 'desc' });
  const [page, setPage] = useState(0);

  const customerMap = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of customers) m.set(c.id, c.name);
    return m;
  }, [customers]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return cdrs;
    return cdrs.filter((c) =>
      c.caller_id.toLowerCase().includes(q) ||
      c.destination.toLowerCase().includes(q) ||
      (c.hangup_cause ?? '').toLowerCase().includes(q) ||
      c.uuid.toLowerCase().includes(q) ||
      c.direction.includes(q) ||
      (c.read_codec ?? '').toLowerCase().includes(q) ||
      (customerMap.get(c.customer_id) ?? '').toLowerCase().includes(q),
    );
  }, [cdrs, search, customerMap]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      let av: number | string | null;
      let bv: number | string | null;
      switch (sort.key) {
        case 'start_time': av = a.start_time; bv = b.start_time; break;
        case 'duration_seconds': av = a.duration_seconds; bv = b.duration_seconds; break;
        case 'mos': av = a.mos ?? -1; bv = b.mos ?? -1; break;
        case 'packet_loss_pct': av = a.packet_loss_pct ?? -1; bv = b.packet_loss_pct ?? -1; break;
        case 'jitter_avg_ms': av = a.jitter_avg_ms ?? -1; bv = b.jitter_avg_ms ?? -1; break;
        case 'r_factor': av = a.r_factor ?? -1; bv = b.r_factor ?? -1; break;
        default: av = a.start_time; bv = b.start_time;
      }
      const cmp = av! < bv! ? -1 : av! > bv! ? 1 : 0;
      return sort.dir === 'asc' ? cmp : -cmp;
    });
  }, [filtered, sort]);

  const pageCount = Math.ceil(sorted.length / TABLE_PAGE_SIZE);
  const pageItems = useMemo(
    () => sorted.slice(page * TABLE_PAGE_SIZE, (page + 1) * TABLE_PAGE_SIZE),
    [sorted, page],
  );

  function setSearch(v: string) {
    setSearchRaw(v);
    setPage(0);
  }

  function toggleSort(key: SortKey) {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }));
    setPage(0);
  }

  return {
    search,
    setSearch,
    sort,
    toggleSort,
    page,
    setPage,
    customerMap,
    filteredCount: filtered.length,
    pageItems,
    pageCount,
  };
}

// ── Single CDR detail ────────────────────────────────────────────────────────

export function useCdrDetail(cdr: Cdr): { detail: Cdr; isLoading: boolean } {
  const { data, isLoading } = useQuery({
    queryKey: ['cdr', cdr.uuid],
    queryFn: () => getCdr(cdr.uuid),
    initialData: cdr,
    staleTime: 30_000,
  });
  return { detail: data ?? cdr, isLoading };
}
