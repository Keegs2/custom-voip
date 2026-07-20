/**
 * Data + logic layer for the CDRs admin feature.
 *
 * Per the glass refactor convention: the page does composition + top-level state
 * only; ALL data fetching, mutations, derived state, and the filter→param mapping
 * live here. Presentational components stay dumb.
 *
 * React #310: every hook below is called unconditionally at the top of its own
 * hook function — no early returns precede a hook.
 */

import { useCallback, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { searchCdrs, getCdrSummary, rateCdr } from '../../../api/cdrs';
import { listCustomers } from '../../../api/customers';
import type {
  Cdr,
  CdrSearchParams,
  ProductType,
  CallDirection,
} from '../../../types/cdr';
import type { CdrSummaryResponse } from '../../../types/rate';
import { useToast } from '../../../components/ui/Toast';
import type { CdrFilters, GroupBy } from './types';
import { PAGE_SIZE } from './types';

// ── Filter helpers (pure) ────────────────────────────────────────────────────

function toDatetimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** Fresh default filters — last 24h window. */
export function defaultCdrFilters(): CdrFilters {
  return {
    customer_id: '',
    product_type: '',
    direction: '',
    start_from: toDatetimeLocal(new Date(Date.now() - 24 * 60 * 60 * 1000)),
    start_to: toDatetimeLocal(new Date()),
    destination: '',
    rated_only: false,
    sbc_id: '',
  };
}

/** Map the filter form into the API search params. */
export function filtersToParams(filters: CdrFilters, limit: number, offset: number): CdrSearchParams {
  const params: CdrSearchParams = { limit, offset };
  if (filters.customer_id) params.customer_id = Number(filters.customer_id);
  if (filters.product_type) params.product_type = filters.product_type as ProductType;
  if (filters.direction) params.direction = filters.direction as CallDirection;
  if (filters.start_from) params.start_from = new Date(filters.start_from).toISOString();
  if (filters.start_to) params.start_to = new Date(filters.start_to).toISOString();
  if (filters.destination) params.destination = filters.destination;
  if (filters.sbc_id) params.sbc_id = filters.sbc_id;
  return params;
}

// ── CDR search (paginated, accumulating) ─────────────────────────────────────

export interface UseCdrsSearchArgs {
  committedFilters: CdrFilters;
  offset: number;
  /** Resets the accumulator when a new search is committed. */
  resetKey: number;
}

export interface UseCdrsSearchResult {
  allCdrs: Cdr[];
  total: number;
  shownCount: number;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  hasData: boolean;
}

/**
 * Owns the `['cdrs', params]` query plus the load-more accumulation. New pages
 * are appended (dedup by uuid); committing a new search resets the accumulator.
 */
export function useCdrsSearch({ committedFilters, offset, resetKey }: UseCdrsSearchArgs): UseCdrsSearchResult {
  const searchParams = useMemo(
    () => filtersToParams(committedFilters, PAGE_SIZE, offset),
    [committedFilters, offset],
  );

  const { data, isLoading, isFetching, isError } = useQuery({
    queryKey: ['cdrs', searchParams],
    queryFn: () => searchCdrs(searchParams),
    placeholderData: (prev) => prev,
  });

  const [accumulatedCdrs, setAccumulatedCdrs] = useState<Cdr[]>([]);
  const [prevOffset, setPrevOffset] = useState(0);
  const [prevResetKey, setPrevResetKey] = useState(resetKey);

  const allCdrs = useMemo(() => {
    if (!data) return accumulatedCdrs;
    const pageItems = data.items ?? [];
    if (offset === 0) return pageItems;
    const uuids = new Set(accumulatedCdrs.map((c) => c.uuid));
    const newItems = pageItems.filter((c) => !uuids.has(c.uuid));
    return [...accumulatedCdrs, ...newItems];
  }, [data, offset, accumulatedCdrs]);

  // Render-phase state sync (preserves the original accumulation behaviour).
  if (resetKey !== prevResetKey) {
    setPrevResetKey(resetKey);
    setPrevOffset(0);
    setAccumulatedCdrs([]);
  } else if (data && offset !== prevOffset) {
    setPrevOffset(offset);
    setAccumulatedCdrs(allCdrs);
  } else if (data && offset === 0 && accumulatedCdrs !== (data.items ?? [])) {
    setAccumulatedCdrs(data.items ?? []);
  }

  return {
    allCdrs,
    total: data?.total ?? 0,
    shownCount: allCdrs.length,
    isLoading,
    isFetching,
    isError,
    hasData: !!data,
  };
}

// ── Customer name lookup ─────────────────────────────────────────────────────

export function useCustomerNames(): Record<number, string> {
  const { data } = useQuery({
    queryKey: ['customers-all'],
    queryFn: () => listCustomers({ limit: 500 }),
    staleTime: 5 * 60 * 1000,
  });

  return useMemo<Record<number, string>>(() => {
    const map: Record<number, string> = {};
    for (const c of data?.items ?? []) map[c.id] = c.name;
    return map;
  }, [data]);
}

/** Lightweight customer list for the filter-bar dropdown. */
export function useCustomerOptions(): Array<{ id: number; name: string }> {
  const { data } = useQuery({
    queryKey: ['customers-all'],
    queryFn: () => listCustomers({ limit: 500 }),
    staleTime: 5 * 60 * 1000,
  });
  return data?.items ?? [];
}

// ── CDR summary (grouped) ────────────────────────────────────────────────────

export interface UseCdrSummaryResult {
  data: CdrSummaryResponse | undefined;
  isLoading: boolean;
  isError: boolean;
}

export function useCdrSummary(customerId: string | undefined, groupBy: GroupBy): UseCdrSummaryResult {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['cdr-summary', { customerId, groupBy }],
    queryFn: () =>
      getCdrSummary({
        customer_id: customerId ? Number(customerId) : undefined,
        group_by: groupBy,
      }),
  });
  return { data, isLoading, isError };
}

// ── Rate a single CDR (expanded row action) ──────────────────────────────────

export interface UseRateCdrResult {
  rate: () => void;
  isRating: boolean;
}

export function useRateCdr(uuid: string, onRated: (uuid: string) => void): UseRateCdrResult {
  const { toastOk, toastErr } = useToast();
  const queryClient = useQueryClient();
  const [isRating, setIsRating] = useState(false);

  const mutation = useMutation({
    mutationFn: () => rateCdr(uuid),
    onMutate: () => setIsRating(true),
    onSuccess: () => {
      toastOk('CDR rated successfully');
      onRated(uuid);
      void queryClient.invalidateQueries({ queryKey: ['cdrs'] });
    },
    onError: (err: Error) => toastErr(`Rating failed: ${err.message}`),
    onSettled: () => setIsRating(false),
  });

  const rate = useCallback(() => mutation.mutate(), [mutation]);
  return { rate, isRating };
}
