/**
 * Data + logic layer for the Least-Cost Outbound admin feature.
 *
 * Per docs/FRONTEND_GLASS_REFACTOR.md the page + tab components do composition and
 * hold top-level state; ALL data fetching, mutations, the deck load-more
 * accumulation, and the streaming billing export live here.
 *
 * React #310: every hook below is called unconditionally at the top of its own
 * hook function — no early returns precede a hook.
 */

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getLcoRoute,
  listDecks,
  createDeck,
  updateDeck,
  deleteDeck,
  importDeck,
  listPolicy,
  upsertPolicy,
  deletePolicy,
  getSavings,
  downloadBillingExport,
  type ListDecksParams,
} from '../../../api/lco';
import { listCustomers } from '../../../api/customers';
import { listCarriers } from '../../../api/carriers';
import { useToast } from '../../../components/ui/Toast';
import type {
  RateDeck,
  RateDeckCreate,
  RateDeckUpdate,
  RateDeckImportRequest,
  CarrierPolicyUpsert,
} from '../../../types/lco';
import { PAGE_SIZE } from './types';

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

// ── Route preview ─────────────────────────────────────────────────────────────

export function useLcoRoute(destination: string, customerId: number | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['lco-route', { destination, customerId: customerId ?? null }],
    queryFn: () => getLcoRoute(destination, customerId),
    enabled: enabled && destination.trim().length > 0,
  });
}

// ── Rate decks (paginated, accumulating) ──────────────────────────────────────

export interface UseDecksArgs {
  carrierId: string;
  search: string;
  offset: number;
  resetKey: number;
}

export interface UseDecksResult {
  items: RateDeck[];
  total: number;
  shownCount: number;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  hasData: boolean;
}

export function useDecks({ carrierId, search, offset, resetKey }: UseDecksArgs): UseDecksResult {
  const params = useMemo<ListDecksParams>(() => {
    const p: ListDecksParams = { limit: PAGE_SIZE, offset };
    if (carrierId) p.carrier_id = Number(carrierId);
    if (search) p.search = search;
    return p;
  }, [carrierId, search, offset]);

  const { data, isLoading, isFetching, isError } = useQuery({
    queryKey: ['lco-decks', params],
    queryFn: () => listDecks(params),
    placeholderData: (prev) => prev,
  });

  const [accumulated, setAccumulated] = useState<RateDeck[]>([]);
  const [prevOffset, setPrevOffset] = useState(0);
  const [prevResetKey, setPrevResetKey] = useState(resetKey);

  const items = useMemo(() => {
    if (!data) return accumulated;
    const page = data.items ?? [];
    if (offset === 0) return page;
    const seen = new Set(accumulated.map((d) => d.id));
    return [...accumulated, ...page.filter((d) => !seen.has(d.id))];
  }, [data, offset, accumulated]);

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

export function useCreateDeck(onDone: () => void) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  return useMutation({
    mutationFn: (data: RateDeckCreate) => createDeck(data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['lco-decks'] });
      toastOk('Rate added');
      onDone();
    },
    onError: (err: Error) => toastErr(`Add failed: ${err.message}`),
  });
}

export function useUpdateDeck(onDone: () => void) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: RateDeckUpdate }) => updateDeck(id, data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['lco-decks'] });
      toastOk('Rate updated');
      onDone();
    },
    onError: (err: Error) => toastErr(`Save failed: ${err.message}`),
  });
}

export function useDeleteDeck() {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  return useMutation({
    mutationFn: (id: number) => deleteDeck(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['lco-decks'] });
      toastOk('Rate deleted');
    },
    onError: (err: Error) => toastErr(`Delete failed: ${err.message}`),
  });
}

export function useImportDeck(onDone: () => void) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  return useMutation({
    mutationFn: (data: RateDeckImportRequest) => importDeck(data),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['lco-decks'] });
      toastOk(`Imported ${res.processed} rates (${res.skipped} skipped)`);
      onDone();
    },
    onError: (err: Error) => toastErr(`Import failed: ${err.message}`),
  });
}

// ── Per-customer carrier policy ──────────────────────────────────────────────

export function usePolicy(customerId: number | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['lco-policy', { customerId: customerId ?? null }],
    queryFn: () => listPolicy(customerId),
    enabled,
  });
}

export function useUpsertPolicy(onDone: () => void) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  return useMutation({
    mutationFn: (data: CarrierPolicyUpsert) => upsertPolicy(data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['lco-policy'] });
      toastOk('Policy saved');
      onDone();
    },
    onError: (err: Error) => toastErr(`Save failed: ${err.message}`),
  });
}

export function useDeletePolicy() {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  return useMutation({
    mutationFn: (id: number) => deletePolicy(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['lco-policy'] });
      toastOk('Policy removed');
    },
    onError: (err: Error) => toastErr(`Delete failed: ${err.message}`),
  });
}

// ── Savings report ────────────────────────────────────────────────────────────

export function useSavings(start: string, end: string, customerId: number | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['lco-savings', { start, end, customerId: customerId ?? null }],
    queryFn: () => getSavings({ start, end, customer_id: customerId, limit: 25 }),
    enabled,
  });
}

// ── Streaming billing export ──────────────────────────────────────────────────

export function useBillingExport() {
  const { toastOk, toastErr } = useToast();
  const [isExporting, setIsExporting] = useState(false);

  const download = async (start: string, end: string, customerId: number | undefined) => {
    setIsExporting(true);
    try {
      await downloadBillingExport({ start, end, customer_id: customerId, fmt: 'csv' });
      toastOk('Billing export downloaded');
    } catch (err) {
      toastErr(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setIsExporting(false);
    }
  };

  return { download: (start: string, end: string, customerId: number | undefined) => void download(start, end, customerId), isExporting };
}
