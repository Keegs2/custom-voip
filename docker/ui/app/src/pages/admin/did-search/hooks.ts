/**
 * Data + logic layer for the DID Search / Number Management feature.
 *
 * Per the refactor convention (docs/FRONTEND_GLASS_REFACTOR.md): the page +
 * tab components do composition and hold top-level state; ALL data fetching,
 * mutations, and derived state live here. Query keys + invalidation targets are
 * kept identical to the pre-refactor page so the React Query cache behaves the
 * same.
 *
 * React #310: every hook below is called unconditionally at the top of its
 * hook function — no early returns precede a hook.
 */

import { useCallback, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listDidInventory,
  listAvailableDids,
  listMyDids,
  getDidStats,
  syncDidInventory,
  assignDid,
  unassignDid,
  requestDid,
} from '../../../api/didInventory';
import { listCustomers } from '../../../api/customers';
import { useToast } from '../../../components/ui/Toast';
import { fmt } from '../../../utils/format';
import type { DidInventoryItem, DidStatus, DidAllocatedEnv } from '../../../types/didInventory';
import { PAGE_SIZE } from './types';

// Invalidate every DID-related cache after a write so all tabs refresh.
function invalidateDidQueries(qc: ReturnType<typeof useQueryClient>): void {
  void qc.invalidateQueries({ queryKey: ['did-inventory'] });
  void qc.invalidateQueries({ queryKey: ['did-stats'] });
  void qc.invalidateQueries({ queryKey: ['did-available'] });
  void qc.invalidateQueries({ queryKey: ['did-my'] });
}

// ── Stats ────────────────────────────────────────────────────────────────────

export function useDidStats() {
  return useQuery({ queryKey: ['did-stats'], queryFn: getDidStats });
}

// ── Inventory tab ──────────────────────────────────────────────────────────────

export interface UseInventoryArgs {
  search: string;
  statusFilter: DidStatus | '';
  stateFilter: string;
  envFilter: DidAllocatedEnv | '';
  offset: number;
}

export interface UseInventoryResult {
  items: DidInventoryItem[];
  /** Items after the client-side env filter (only narrows the current page). */
  filteredItems: DidInventoryItem[];
  total: number;
  isLoading: boolean;
  isFetching: boolean;
  hasFilters: boolean;
}

/**
 * Inventory list query + the client-side env filter pipeline. The
 * `/numbers/inventory` endpoint has no env query param, so env filtering is
 * applied over the already-fetched page (server `total` stays unfiltered).
 */
export function useInventoryData({
  search,
  statusFilter,
  stateFilter,
  envFilter,
  offset,
}: UseInventoryArgs): UseInventoryResult {
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['did-inventory', { search, statusFilter, stateFilter, offset }],
    queryFn: () =>
      listDidInventory({
        search: search || undefined,
        status: statusFilter || undefined,
        state: stateFilter || undefined,
        limit: PAGE_SIZE,
        offset,
      }),
    placeholderData: (prev) => prev,
  });

  const items = useMemo(() => data?.items ?? [], [data]);
  const total = data?.total ?? 0;

  const filteredItems = useMemo(
    () => (envFilter ? items.filter((it) => (it.allocated_env ?? 'prod') === envFilter) : items),
    [items, envFilter],
  );

  const hasFilters = Boolean(search || statusFilter || stateFilter || envFilter);

  return { items, filteredItems, total, isLoading, isFetching, hasFilters };
}

export function useSyncInventory() {
  const { toastOk, toastErr } = useToast();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: syncDidInventory,
    onSuccess: (result) => {
      toastOk(`Sync complete — ${result.synced} numbers updated`);
      invalidateDidQueries(qc);
    },
    onError: (err: Error) => toastErr(err.message ?? 'Sync failed'),
  });
}

// ── Available tab ─────────────────────────────────────────────────────────────

export function useAvailableData(search: string, stateFilter: string) {
  const { data, isLoading } = useQuery({
    queryKey: ['did-available', { search, stateFilter }],
    queryFn: () =>
      listAvailableDids({
        search: search || undefined,
        state: stateFilter || undefined,
        limit: 100,
      }),
    placeholderData: (prev) => prev,
  });
  return { items: data ?? [], isLoading };
}

export function useRequestDid() {
  const { toastOk, toastErr } = useToast();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (did: string) => requestDid(did),
    onSuccess: (_data, did) => {
      toastOk(`${fmt(did)} has been requested`);
      void qc.invalidateQueries({ queryKey: ['did-available'] });
      void qc.invalidateQueries({ queryKey: ['did-my'] });
    },
    onError: (err: Error) => toastErr(err.message ?? 'Request failed'),
  });
}

// ── Assignments tab ───────────────────────────────────────────────────────────

export interface CustomerGroup {
  name: string;
  dids: DidInventoryItem[];
}

export interface UseAssignmentsResult {
  groups: CustomerGroup[];
  count: number;
  isLoading: boolean;
  isFetching: boolean;
}

export function useAssignmentsData(search: string, stateFilter: string): UseAssignmentsResult {
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['did-inventory', { search, stateFilter, statusFilter: 'assigned', offset: 0 }],
    queryFn: () =>
      listDidInventory({
        status: 'assigned',
        search: search || undefined,
        state: stateFilter || undefined,
        limit: 200,
        offset: 0,
      }),
    placeholderData: (prev) => prev,
  });

  const items = useMemo(() => data?.items ?? [], [data]);

  const groups = useMemo<CustomerGroup[]>(() => {
    const byCustomer = items.reduce<Record<string, DidInventoryItem[]>>((acc, item) => {
      const key = item.customer_name ?? `Customer #${item.customer_id ?? '?'}`;
      (acc[key] ??= []).push(item);
      return acc;
    }, {});
    return Object.entries(byCustomer)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, dids]) => ({ name, dids }));
  }, [items]);

  return { groups, count: items.length, isLoading, isFetching };
}

// ── My Numbers tab ─────────────────────────────────────────────────────────────

export function useMyNumbersData() {
  const { data, isLoading } = useQuery({ queryKey: ['did-my'], queryFn: listMyDids });
  return { items: data ?? [], isLoading };
}

// ── Assign modal — form state + live mutation ────────────────────────────────────

export interface UseAssignFormResult {
  customerId: string;
  setCustomerId: (v: string) => void;
  productType: string;
  setProductType: (v: string) => void;
  notes: string;
  setNotes: (v: string) => void;
  customers: { id: number; name: string }[];
  customersLoading: boolean;
  isPending: boolean;
  submit: () => void;
}

/**
 * Owns the assign-modal form fields + customer dropdown query + the live POST
 * /assign mutation. Saving persists, invalidates the DID caches, resets the
 * form, and calls `onDone`. The dropdown query only runs while `open`.
 */
export function useAssignForm(
  did: DidInventoryItem | null,
  open: boolean,
  onDone: () => void,
): UseAssignFormResult {
  const [customerId, setCustomerId] = useState('');
  const [productType, setProductType] = useState('rcf');
  const [notes, setNotes] = useState('');
  const { toastOk, toastErr } = useToast();
  const qc = useQueryClient();

  const { data: customersData, isLoading: customersLoading } = useQuery({
    queryKey: ['customers-dropdown'],
    queryFn: () => listCustomers({ limit: 500 }),
    enabled: open,
  });

  const mutation = useMutation({
    mutationFn: () =>
      assignDid(did!.did, {
        customer_id: Number(customerId),
        product_type: productType,
        notes: notes.trim() || undefined,
      }),
    onSuccess: () => {
      toastOk(`${fmt(did!.did)} assigned successfully`);
      invalidateDidQueries(qc);
      setCustomerId('');
      setProductType('rcf');
      setNotes('');
      onDone();
    },
    onError: (err: Error) => toastErr(err.message ?? 'Failed to assign number'),
  });

  const submit = useCallback(() => mutation.mutate(), [mutation]);

  return {
    customerId,
    setCustomerId,
    productType,
    setProductType,
    notes,
    setNotes,
    customers: customersData?.items ?? [],
    customersLoading,
    isPending: mutation.isPending,
    submit,
  };
}

// ── Unassign modal — live mutation ───────────────────────────────────────────────

export interface UseUnassignResult {
  isPending: boolean;
  submit: () => void;
}

/**
 * Owns the live POST /unassign mutation. On success it toasts, invalidates the
 * DID caches, and calls `onDone` (the assignments tab passes a callback that
 * additionally re-fetches; the extra invalidate is harmless/idempotent).
 */
export function useUnassignAction(did: DidInventoryItem | null, onDone: () => void): UseUnassignResult {
  const { toastOk, toastErr } = useToast();
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => unassignDid(did!.did),
    onSuccess: () => {
      toastOk(`${fmt(did!.did)} unassigned`);
      invalidateDidQueries(qc);
      onDone();
    },
    onError: (err: Error) => toastErr(err.message ?? 'Failed to unassign number'),
  });
  return { isPending: mutation.isPending, submit: () => mutation.mutate() };
}
