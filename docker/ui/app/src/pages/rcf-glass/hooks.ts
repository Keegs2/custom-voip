/**
 * Data + logic layer for the RCF glass reference page.
 *
 * Per the refactor convention (docs/FRONTEND_GLASS_REFACTOR.md): the page does
 * composition + top-level state only; ALL data fetching, mutations, and derived
 * state live here as hooks. Presentational components stay dumb.
 *
 * React #310: every hook below is called unconditionally at the top of its
 * hook function — no early returns precede a hook.
 */

import { useCallback, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listRcf } from '../../api/rcf';
import { apiRequest } from '../../api/client';
import type { RcfEntry } from '../../types/rcf';
import { useToast } from '../../components/ui/Toast';
import { fmt } from '../../utils/format';
import type { SortField } from './types';

// ── Live mutation — identical endpoint to the production RcfCard ─────────────
async function updateRcfForwardTo(did: string, forward_to: string): Promise<RcfEntry> {
  return apiRequest('PUT', `/rcf/${encodeURIComponent(did)}`, { forward_to });
}

/** Stable sort by the chosen field (numeric-aware, case-insensitive). */
function sortEntries(entries: RcfEntry[], field: SortField): RcfEntry[] {
  return [...entries].sort((a, b) => {
    const av =
      field === 'did' ? a.did
      : field === 'forward_to' ? a.forward_to
      : field === 'customer' ? a.customer_name ?? ''
      : a.name ?? '';
    const bv =
      field === 'did' ? b.did
      : field === 'forward_to' ? b.forward_to
      : field === 'customer' ? b.customer_name ?? ''
      : b.name ?? '';
    return av.localeCompare(bv, undefined, { numeric: true });
  });
}

export interface UseRcfGlassDataArgs {
  customerId: number | undefined;
  search: string;
  sort: SortField;
  visible: number;
}

export interface UseRcfGlassDataResult {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  isFetching: boolean;
  refetch: () => void;
  /** Filtered + sorted entries (full set). */
  filtered: RcfEntry[];
  /** The currently-visible page slice. */
  shown: RcfEntry[];
}

/**
 * Owns the `['rcf', { customerId }]` query plus the derived filter/sort/slice
 * pipeline. The page passes its top-level state in and renders the result.
 */
export function useRcfGlassData({ customerId, search, sort, visible }: UseRcfGlassDataArgs): UseRcfGlassDataResult {
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['rcf', { customerId }],
    queryFn: () => listRcf(customerId !== undefined ? { customer_id: customerId } : {}),
  });

  const allEntries = useMemo(() => data?.items ?? [], [data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matched = q
      ? allEntries.filter((e) =>
          [e.did, e.forward_to, e.name ?? '', e.customer_name ?? ''].some((f) => f.toLowerCase().includes(q)),
        )
      : allEntries;
    return sortEntries(matched, sort);
  }, [allEntries, search, sort]);

  const shown = useMemo(() => filtered.slice(0, visible), [filtered, visible]);

  return { isLoading, isError, error, isFetching, refetch: () => void refetch(), filtered, shown };
}

export interface UseForwardToEditorResult {
  editing: boolean;
  value: string;
  hovered: boolean;
  flash: boolean;
  isPending: boolean;
  setValue: (v: string) => void;
  setHovered: (h: boolean) => void;
  beginEdit: () => void;
  save: () => void;
  cancel: () => void;
}

/**
 * All state + the real PUT mutation for one inline forward_to editor. Saving
 * persists and invalidates the ['rcf'] query, then flashes the value.
 */
export function useForwardToEditor(entry: RcfEntry, canEdit: boolean): UseForwardToEditorResult {
  const queryClient = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(entry.forward_to);
  const [hovered, setHovered] = useState(false);
  const [flash, setFlash] = useState(false);

  const mutation = useMutation({
    mutationFn: (next: string) => updateRcfForwardTo(entry.did, next),
    onSuccess: (_data, next) => {
      void queryClient.invalidateQueries({ queryKey: ['rcf'] });
      setEditing(false);
      setFlash(true);
      setTimeout(() => setFlash(false), 1600);
      toastOk(`Saved — ${fmt(entry.did)} now rings ${fmt(next)}`);
    },
    onError: (err: Error) => toastErr(err.message ?? 'Failed to save'),
  });

  const beginEdit = useCallback(() => {
    if (!canEdit) return;
    setValue(entry.forward_to);
    setEditing(true);
  }, [canEdit, entry.forward_to]);

  const save = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed) {
      toastErr('Destination cannot be empty');
      return;
    }
    if (trimmed === entry.forward_to) {
      setEditing(false);
      return;
    }
    mutation.mutate(trimmed);
  }, [value, entry.forward_to, mutation, toastErr]);

  const cancel = useCallback(() => {
    setValue(entry.forward_to);
    setEditing(false);
  }, [entry.forward_to]);

  return {
    editing,
    value,
    hovered,
    flash,
    isPending: mutation.isPending,
    setValue,
    setHovered,
    beginEdit,
    save,
    cancel,
  };
}
