/**
 * Data + logic layer for the Toll-Free / RespOrg admin feature.
 *
 * Per docs/FRONTEND_GLASS_REFACTOR.md the page does composition + top-level state
 * only; ALL data fetching, mutations, the load-more accumulation, and the import
 * batch polling live here. Built for scale — search + pagination are server-side.
 *
 * React #310: every hook below is called unconditionally at the top of its own
 * hook function — no early returns precede a hook.
 */

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listTfns,
  getTfnStats,
  getTfn,
  getTfnCrStatus,
  importTfns,
  getImportBatch,
  reassignCarrier,
  updateTfn,
  submitCr,
  type ListTfnParams,
} from '../../../api/tollFree';
import { listCustomers } from '../../../api/customers';
import { listCarriers } from '../../../api/carriers';
import { useToast } from '../../../components/ui/Toast';
import type { Tfn, TfnImportRequest, TfnUpdate } from '../../../types/tollFree';
import { PAGE_SIZE, type TfnFilters } from './types';

// ── Shared dropdown queries (shared cache keys) ───────────────────────────────

export function useCustomerOptions(enabled = true) {
  const { data } = useQuery({
    queryKey: ['customers-dropdown'],
    queryFn: () => listCustomers({ limit: 500 }),
    enabled,
    staleTime: 60_000,
  });
  return data?.items ?? [];
}

export function useCarrierOptions(enabled = true) {
  const { data } = useQuery({ queryKey: ['carriers'], queryFn: listCarriers, enabled, staleTime: 60_000 });
  return data ?? [];
}

// ── Stats ─────────────────────────────────────────────────────────────────────

export function useTfnStats(customerId: number | undefined) {
  return useQuery({
    queryKey: ['tfn-stats', { customerId: customerId ?? null }],
    queryFn: () => getTfnStats(customerId),
  });
}

// ── Filters → params ──────────────────────────────────────────────────────────

export function filtersToParams(filters: TfnFilters, limit: number, offset: number): ListTfnParams {
  const params: ListTfnParams = { limit, offset };
  if (filters.search) params.search = filters.search;
  if (filters.status) params.status = filters.status;
  if (filters.cr_status) params.cr_status = filters.cr_status;
  if (filters.carrier_id) params.carrier_id = Number(filters.carrier_id);
  if (filters.customer_id) params.customer_id = Number(filters.customer_id);
  return params;
}

// ── TFN list (paginated, accumulating) ────────────────────────────────────────

export interface UseTfnListArgs {
  committed: TfnFilters;
  offset: number;
  /** Bumped when a new search is committed → resets the accumulator. */
  resetKey: number;
}

export interface UseTfnListResult {
  items: Tfn[];
  total: number;
  shownCount: number;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  hasData: boolean;
}

export function useTfnList({ committed, offset, resetKey }: UseTfnListArgs): UseTfnListResult {
  const params = useMemo(() => filtersToParams(committed, PAGE_SIZE, offset), [committed, offset]);

  const { data, isLoading, isFetching, isError } = useQuery({
    queryKey: ['tfns', params],
    queryFn: () => listTfns(params),
    placeholderData: (prev) => prev,
  });

  const [accumulated, setAccumulated] = useState<Tfn[]>([]);
  const [prevOffset, setPrevOffset] = useState(0);
  const [prevResetKey, setPrevResetKey] = useState(resetKey);

  const items = useMemo(() => {
    if (!data) return accumulated;
    const page = data.items ?? [];
    if (offset === 0) return page;
    const seen = new Set(accumulated.map((t) => t.tfn));
    return [...accumulated, ...page.filter((t) => !seen.has(t.tfn))];
  }, [data, offset, accumulated]);

  // Render-phase sync (same accumulation contract as the CDR search).
  if (resetKey !== prevResetKey) {
    setPrevResetKey(resetKey);
    setPrevOffset(0);
    setAccumulated([]);
  } else if (data && offset !== prevOffset) {
    setPrevOffset(offset);
    setAccumulated(items);
  } else if (data && offset === 0 && accumulated !== (data.items ?? [])) {
    setAccumulated(data.items ?? []);
  }

  return {
    items,
    total: data?.total ?? 0,
    shownCount: items.length,
    isLoading,
    isFetching,
    isError,
    hasData: !!data,
  };
}

// ── Bulk import + batch polling ───────────────────────────────────────────────

export function useImportTfns(onBatch: (batchKey: string) => void) {
  const qc = useQueryClient();
  const { toastErr } = useToast();
  return useMutation({
    mutationFn: (body: TfnImportRequest) => importTfns(body),
    onSuccess: (batch) => {
      void qc.invalidateQueries({ queryKey: ['tfns'] });
      void qc.invalidateQueries({ queryKey: ['tfn-stats'] });
      onBatch(batch.batch_key);
    },
    onError: (err: Error) => toastErr(`Import failed: ${err.message}`),
  });
}

/** Poll a batch's progress until it completes. */
export function useImportBatch(batchKey: string | null) {
  return useQuery({
    queryKey: ['tfn-import-batch', batchKey],
    queryFn: () => getImportBatch(batchKey as string),
    enabled: batchKey !== null,
    refetchInterval: (query) => (query.state.data?.status === 'completed' ? false : 1200),
  });
}

// ── Bulk carrier reassignment ─────────────────────────────────────────────────

export function useReassignCarrier(onDone: () => void) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  return useMutation({
    mutationFn: ({ tfns, carrierId }: { tfns: string[]; carrierId: number }) =>
      reassignCarrier({ tfns, carrier_id: carrierId }),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ['tfns'] });
      toastOk(`Reassigned ${result.updated} of ${result.requested} to ${result.gateway_name}`);
      onDone();
    },
    onError: (err: Error) => toastErr(`Reassign failed: ${err.message}`),
  });
}

// ── Single-TFN detail + CR status ─────────────────────────────────────────────

export function useTfnDetail(tfn: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['tfn', tfn],
    queryFn: () => getTfn(tfn as string),
    enabled: enabled && tfn !== null,
  });
}

export function useTfnCrStatus(tfn: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['tfn-cr', tfn],
    queryFn: () => getTfnCrStatus(tfn as string),
    enabled: enabled && tfn !== null,
  });
}

export function useUpdateTfn(tfn: string, onDone: () => void) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  return useMutation({
    mutationFn: (body: TfnUpdate) => updateTfn(tfn, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tfns'] });
      void qc.invalidateQueries({ queryKey: ['tfn', tfn] });
      void qc.invalidateQueries({ queryKey: ['tfn-stats'] });
      toastOk('Toll-free number updated');
      onDone();
    },
    onError: (err: Error) => toastErr(`Update failed: ${err.message}`),
  });
}

export function useSubmitCr(tfn: string) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  return useMutation({
    mutationFn: () => submitCr(tfn),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['tfn', tfn] });
      void qc.invalidateQueries({ queryKey: ['tfn-cr', tfn] });
      void qc.invalidateQueries({ queryKey: ['tfns'] });
      toastOk(res.adapter.submitted ? 'CR submitted to RespOrg' : 'CR intent recorded (Somos adapter off)');
    },
    onError: (err: Error) => toastErr(`CR submit failed: ${err.message}`),
  });
}
