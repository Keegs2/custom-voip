/**
 * Data + logic layer for the production RCF page. Per the refactor convention
 * (docs/FRONTEND_GLASS_REFACTOR.md) the page does composition + top-level state
 * only; ALL queries, mutations and derived pipelines live here. Presentational
 * components stay dumb.
 *
 * React #310: every hook below is called unconditionally at the top of its hook
 * function — no early returns precede a hook.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listRcf, updateRcfEntry } from '../../api/rcf';
import { apiRequest } from '../../api/client';
import { searchCdrs } from '../../api/cdrs';
import { listAvailableDids, listMyDids, requestDid, unassignDid } from '../../api/didInventory';
import type { RcfEntry } from '../../types/rcf';
import type { DidInventoryItem } from '../../types/didInventory';
import { useToast } from '../../components/ui/Toast';
import { fmt } from '../../utils/format';
import type { SortField, SortDir } from './types';
import {
  sortEntries,
  extractNpa,
  computeQualityStats,
  buildDailyDots,
} from './utils';

// ── API helpers ──────────────────────────────────────────────────────────────

async function updateRcfForwardTo(did: string, forward_to: string): Promise<RcfEntry> {
  return apiRequest('PUT', `/rcf/${encodeURIComponent(did)}`, { forward_to });
}
async function updateRcfEnabled(id: number, enabled: boolean): Promise<RcfEntry> {
  return apiRequest('PATCH', `/rcf/${id}`, { enabled });
}
async function updateRcfPassCallerId(id: number, pass_caller_id: boolean): Promise<RcfEntry> {
  return apiRequest('PATCH', `/rcf/${id}`, { pass_caller_id });
}
async function updateRcfMaxChannels(id: number, max_channels: number): Promise<RcfEntry> {
  return apiRequest('PATCH', `/rcf/${id}`, { max_channels });
}
/** Customer-facing name for the unassign operation. */
const releaseDid = (did: string) => unassignDid(did);

// ── Numbers tab — list query + derived filter/sort pipeline ──────────────────

export interface UseRcfNumbersArgs {
  customerId: number | undefined;
  page: number;
  pageSize: number;
  searchQuery: string;
  npaFilter: string;
  sortField: SortField;
  sortDir: SortDir;
}

export function useRcfNumbers({
  customerId,
  page,
  pageSize,
  searchQuery,
  npaFilter,
  sortField,
  sortDir,
}: UseRcfNumbersArgs) {
  // SEARCH IS SERVER-SIDE: the `search` param goes to GET /rcf so matching runs
  // across the customer's FULL number set, not just the currently-fetched page
  // (2026-07 audit: client-only filtering silently dropped matches for any
  // customer with more than one page of DIDs). The query key includes the
  // search term so each term caches independently and page/search changes
  // never serve stale results. `searchQuery` is already debounced (250ms) and
  // page is reset to 1 on change by RcfPage.
  const { data, isLoading, isError } = useQuery({
    queryKey: ['rcf', customerId, page, pageSize, searchQuery],
    queryFn: () =>
      listRcf({
        limit: pageSize,
        offset: (page - 1) * pageSize,
        customer_id: customerId,
        search: searchQuery || undefined,
      }),
  });

  const rawEntries: RcfEntry[] = useMemo(() => data?.items ?? [], [data]);
  const serverTotal: number = data?.total ?? 0;

  const filteredEntries = useMemo(() => {
    let result = rawEntries;
    // NPA narrowing stays client-side (no server param for it yet) — it only
    // narrows within the server-filtered result set.
    if (npaFilter.length === 3) {
      result = result.filter((e) => extractNpa(e.did) === npaFilter);
    }
    // Defence-in-depth re-filter of the server result: a no-op once the API
    // applies `search` (this wave's backend change), and full protection for
    // the current page while any deployed API version still ignores the param.
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (e) =>
          e.did.includes(q) ||
          e.forward_to.toLowerCase().includes(q) ||
          (e.name ?? '').toLowerCase().includes(q) ||
          (e.customer_name ?? '').toLowerCase().includes(q),
      );
    }
    return result;
  }, [rawEntries, searchQuery, npaFilter]);

  const sortedEntries = useMemo(
    () => sortEntries(filteredEntries, sortField, sortDir),
    [filteredEntries, sortField, sortDir],
  );

  const activeCount = useMemo(() => rawEntries.filter((e) => e.enabled).length, [rawEntries]);
  const disabledCount = useMemo(() => rawEntries.filter((e) => !e.enabled).length, [rawEntries]);
  const totalPages = Math.max(1, Math.ceil(serverTotal / pageSize));

  return {
    isLoading,
    isError,
    rawEntries,
    serverTotal,
    filteredEntries,
    sortedEntries,
    activeCount,
    disabledCount,
    totalPages,
  };
}

// ── Inline forward_to editor (shared by table cell + card) ───────────────────

export interface UseForwardToEditorResult {
  editing: boolean;
  savedFlash: boolean;
  hovered: boolean;
  isDirty: boolean;
  isPending: boolean;
  setHovered: (h: boolean) => void;
  beginEdit: () => void;
  save: () => void;
  cancel: () => void;
}

export function useForwardToEditor(
  entry: RcfEntry,
  canEdit: boolean,
  pendingValue: string,
  onPendingChange: (did: string, value: string) => void,
): UseForwardToEditorResult {
  const queryClient = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const [editing, setEditing] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [hovered, setHovered] = useState(false);

  const isDirty = pendingValue !== entry.forward_to && pendingValue !== '';

  const mutation = useMutation({
    mutationFn: (newValue: string) => updateRcfForwardTo(entry.did, newValue.trim()),
    onSuccess: (_data, newValue) => {
      void queryClient.invalidateQueries({ queryKey: ['rcf'] });
      onPendingChange(entry.did, newValue.trim());
      setEditing(false);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1800);
      toastOk(`Saved — calls to ${fmt(entry.did)} now ring ${fmt(newValue.trim())}`);
    },
    onError: (error: Error) => toastErr(error.message ?? 'Failed to save'),
  });

  const beginEdit = useCallback(() => {
    if (canEdit) setEditing(true);
  }, [canEdit]);

  const save = useCallback(() => {
    const trimmed = pendingValue.trim();
    if (!trimmed) { toastErr('Destination cannot be empty'); return; }
    mutation.mutate(trimmed);
  }, [pendingValue, mutation, toastErr]);

  const cancel = useCallback(() => {
    onPendingChange(entry.did, entry.forward_to);
    setEditing(false);
  }, [entry.did, entry.forward_to, onPendingChange]);

  return {
    editing,
    savedFlash,
    hovered,
    isDirty,
    isPending: mutation.isPending,
    setHovered,
    beginEdit,
    save,
    cancel,
  };
}

// ── Enable / disable toggle ──────────────────────────────────────────────────

export function useEnableToggle(entry: RcfEntry) {
  const queryClient = useQueryClient();
  const { toastOk, toastErr } = useToast();

  const mutation = useMutation({
    mutationFn: (enabled: boolean) => updateRcfEnabled(entry.id, enabled),
    onSuccess: (_, enabled) => {
      void queryClient.invalidateQueries({ queryKey: ['rcf'] });
      toastOk(enabled ? `${fmt(entry.did)} enabled` : `${fmt(entry.did)} disabled`);
    },
    onError: (err: Error) => toastErr(err.message ?? 'Failed to update'),
  });

  return { enabled: entry.enabled, isPending: mutation.isPending, toggle: () => mutation.mutate(!entry.enabled) };
}

// ── Caller-ID pass-through toggle ────────────────────────────────────────────

export function useCallerIdToggle(entry: RcfEntry) {
  const queryClient = useQueryClient();
  const { toastOk, toastErr } = useToast();

  const mutation = useMutation({
    mutationFn: (pass: boolean) => updateRcfPassCallerId(entry.id, pass),
    onSuccess: (_, pass) => {
      void queryClient.invalidateQueries({ queryKey: ['rcf'] });
      toastOk(
        pass
          ? `Caller ID pass-through enabled for ${fmt(entry.did)}`
          : `Caller ID will show ${fmt(entry.did)} instead`,
      );
    },
    onError: (err: Error) => toastErr(err.message ?? 'Failed to update'),
  });

  return { passthrough: entry.pass_caller_id, isPending: mutation.isPending, toggle: () => mutation.mutate(!entry.pass_caller_id) };
}

// ── Max-channels inline editor ───────────────────────────────────────────────

export function useMaxChannelsEditor(entry: RcfEntry) {
  const queryClient = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(entry.max_channels));

  const mutation = useMutation({
    mutationFn: (v: number) => updateRcfMaxChannels(entry.id, v),
    onSuccess: (_, v) => {
      void queryClient.invalidateQueries({ queryKey: ['rcf'] });
      setEditing(false);
      toastOk(v === 0 ? `Concurrent call limit removed for ${fmt(entry.did)}` : `Max ${v} concurrent calls set for ${fmt(entry.did)}`);
    },
    onError: (err: Error) => toastErr(err.message ?? 'Failed to update'),
  });

  const begin = useCallback(() => { setValue(String(entry.max_channels)); setEditing(true); }, [entry.max_channels]);
  const cancel = useCallback(() => { setEditing(false); setValue(String(entry.max_channels)); }, [entry.max_channels]);
  const commit = useCallback(() => {
    const n = parseInt(value, 10);
    if (!isNaN(n) && n >= 0 && n <= 100) mutation.mutate(n);
  }, [value, mutation]);

  return { editing, value, setValue, isPending: mutation.isPending, begin, cancel, commit };
}

// ── Name (label) inline editor ───────────────────────────────────────────────

export function useNameEditor(entry: RcfEntry) {
  const queryClient = useQueryClient();
  const { toastErr } = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(entry.name ?? '');
  const [prevName, setPrevName] = useState(entry.name);

  // Sync external changes when not editing (render-phase sync, mirrors original).
  if (entry.name !== prevName) {
    setPrevName(entry.name);
    if (!editing) setValue(entry.name ?? '');
  }

  const mutation = useMutation({
    mutationFn: (name: string | null) => updateRcfEntry(entry.id, { name }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['rcf'] });
      setEditing(false);
    },
    onError: (err: Error) => toastErr(err.message),
  });

  const save = useCallback(() => {
    const trimmed = value.trim();
    const newName = trimmed === '' ? null : trimmed;
    if (newName === (entry.name ?? null)) { setEditing(false); return; }
    mutation.mutate(newName);
  }, [value, entry.name, mutation]);

  const cancel = useCallback(() => { setValue(entry.name ?? ''); setEditing(false); }, [entry.name]);

  return { editing, value, setValue, isPending: mutation.isPending, begin: () => setEditing(true), save, cancel };
}

// ── Call activity tab — CDR query + derived ──────────────────────────────────

export interface UseCallActivityArgs {
  customerId: number | undefined;
  selectedDid: string | null;
  activitySearch: string;
}

export function useCallActivity({ customerId, selectedDid, activitySearch }: UseCallActivityArgs) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['rcf-activity', customerId],
    queryFn: () =>
      searchCdrs({
        customer_id: customerId,
        product_type: 'rcf',
        limit: 200,
        sort_by: 'start_time',
        sort_dir: 'desc',
      }),
    enabled: true,
    staleTime: 60_000,
  });

  const { data: rcfData } = useQuery({
    queryKey: ['rcf-dids', customerId],
    queryFn: () => listRcf({ customer_id: customerId, limit: 500 }),
    staleTime: 60_000,
  });
  const rcfEntries: RcfEntry[] = rcfData?.items ?? [];

  const allCalls = useMemo(() => data?.items ?? [], [data]);

  const filteredCalls = useMemo(() => {
    if (!selectedDid) return allCalls;
    return allCalls.filter((c) => c.destination === selectedDid);
  }, [allCalls, selectedDid]);

  const stats = useMemo(() => computeQualityStats(filteredCalls), [filteredCalls]);
  const dailyDots = useMemo(() => buildDailyDots(filteredCalls), [filteredCalls]);

  const calls = useMemo(() => {
    if (!activitySearch.trim()) return filteredCalls;
    const q = activitySearch.trim().toLowerCase();
    return filteredCalls.filter((c) => {
      const fields = [
        c.caller_id, c.destination, c.hangup_cause, c.carrier_used, c.start_time,
        c.sip_code?.toString(), fmt(c.caller_id), fmt(c.destination),
      ];
      return fields.some((f) => f && f.toLowerCase().includes(q));
    });
  }, [filteredCalls, activitySearch]);

  return { isLoading, isError, allCalls, rcfEntries, stats, dailyDots, calls };
}

/** Close `open` when a mousedown lands outside `ref`. */
export function useOutsideClose(ref: React.RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [ref, open, onClose]);
}

// ── DID management tab — inventory queries + request/release mutations ────────

export function useDidManagement(customerId: number | undefined) {
  const queryClient = useQueryClient();
  const { toastOk, toastErr } = useToast();

  const [requestTarget, setRequestTarget] = useState<DidInventoryItem | null>(null);
  const [releaseTarget, setReleaseTarget] = useState<DidInventoryItem | null>(null);

  const { data: myDids, isLoading: myLoading, isError: myError } = useQuery({
    queryKey: ['my-dids', customerId],
    queryFn: () => listMyDids(),
    staleTime: 30_000,
  });

  const { data: availableDids, isLoading: availLoading, isError: availError } = useQuery({
    queryKey: ['available-dids'],
    queryFn: () => listAvailableDids({ limit: 200 }),
    staleTime: 30_000,
  });

  const requestMutation = useMutation({
    mutationFn: (did: string) => requestDid(did),
    onSuccess: (_data, did) => {
      void queryClient.invalidateQueries({ queryKey: ['my-dids'] });
      void queryClient.invalidateQueries({ queryKey: ['available-dids'] });
      setRequestTarget(null);
      toastOk(`Number requested — ${fmt(did)} is pending admin approval`);
    },
    onError: (err: Error) => { setRequestTarget(null); toastErr(err.message ?? 'Failed to request number'); },
  });

  const releaseMutation = useMutation({
    mutationFn: (did: string) => releaseDid(did),
    onSuccess: (_data, did) => {
      void queryClient.invalidateQueries({ queryKey: ['my-dids'] });
      void queryClient.invalidateQueries({ queryKey: ['available-dids'] });
      setReleaseTarget(null);
      toastOk(`Number released — ${fmt(did)} has returned to the pool`);
    },
    onError: (err: Error) => { setReleaseTarget(null); toastErr(err.message ?? 'Failed to release number'); },
  });

  const myItems = useMemo(() => myDids ?? [], [myDids]);
  const availItems = useMemo(() => availableDids ?? [], [availableDids]);

  const assignedItems = useMemo(() => myItems.filter((d) => d.status === 'assigned'), [myItems]);
  const pendingItems = useMemo(() => myItems.filter((d) => d.status === 'reserved'), [myItems]);

  return {
    myLoading, myError, availLoading, availError,
    assignedItems, pendingItems, availItems,
    requestTarget, setRequestTarget,
    releaseTarget, setReleaseTarget,
    requestPending: requestMutation.isPending,
    releasePending: releaseMutation.isPending,
    requestingDid: requestMutation.isPending ? (requestMutation.variables ?? null) : null,
    confirmRequest: (item: DidInventoryItem) => requestMutation.mutate(item.did),
    confirmRelease: (item: DidInventoryItem) => releaseMutation.mutate(item.did),
  };
}
