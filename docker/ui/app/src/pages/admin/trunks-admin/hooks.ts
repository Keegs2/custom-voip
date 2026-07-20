/**
 * Data + logic layer for the Trunks admin feature.
 *
 * Per the refactor convention (docs/FRONTEND_GLASS_REFACTOR.md): the page does
 * composition + top-level state only; ALL data fetching, mutations, and derived
 * per-item editor logic live here as hooks. Presentational components stay dumb.
 *
 * React #310: every hook below is called unconditionally at the top of its hook
 * function — no early returns precede a hook.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type RefObject,
} from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listTrunks,
  createTrunk,
  updateTrunk,
  deleteTrunk,
  getTrunkIps,
  addTrunkIp,
  deleteTrunkIp,
  getTrunkDids,
  addTrunkDid,
  deleteTrunkDid,
} from '../../../api/trunks';
import { listCustomers } from '../../../api/customers';
import { apiRequest } from '../../../api/client';
import { useToast } from '../../../components/ui/Toast';
import type { Trunk, TrunkIp, TrunkDid } from '../../../types/trunk';
import { INITIAL_CREATE, type AvailableTN, type CreateFormState, type EditFormState } from './types';

// ── Page-level trunks list + global mutations ────────────────────────────────

export interface UseTrunksAdminResult {
  trunks: Trunk[];
  data: { items: Trunk[] } | undefined;
  isLoading: boolean;
  isError: boolean;
  toggleEnabled: (trunk: Trunk) => void;
  remove: (trunk: Trunk) => void;
}

/**
 * Owns the `['trunks', { search }]` list query plus the enable/disable + delete
 * mutations. `clearExpanded` is invoked after a successful delete so the page can
 * collapse the removed row.
 */
export function useTrunksAdmin(committedSearch: string, clearExpanded: () => void): UseTrunksAdminResult {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();

  const { data, isLoading, isError } = useQuery({
    queryKey: ['trunks', { search: committedSearch }],
    queryFn: () => listTrunks({ search: committedSearch, limit: 500 }),
  });

  const toggleEnabledMutation = useMutation({
    mutationFn: (trunk: Trunk) => updateTrunk(trunk.id, { enabled: !trunk.enabled }),
    onSuccess: (updated) => {
      void qc.invalidateQueries({ queryKey: ['trunks'] });
      toastOk(`Trunk "${updated.trunk_name}" ${updated.enabled ? 'enabled' : 'disabled'}`);
    },
    onError: (err: Error) => toastErr(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteTrunk(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['trunks'] });
      clearExpanded();
      toastOk('Trunk deleted');
    },
    onError: (err: Error) => toastErr(err.message),
  });

  const trunks = data?.items ?? [];

  return {
    trunks,
    data,
    isLoading,
    isError,
    toggleEnabled: (trunk) => toggleEnabledMutation.mutate(trunk),
    remove: (trunk) => deleteMutation.mutate(trunk.id),
  };
}

// ── Create trunk ─────────────────────────────────────────────────────────────

export interface UseCreateTrunkResult {
  form: CreateFormState;
  setForm: React.Dispatch<React.SetStateAction<CreateFormState>>;
  customers: { id: number; name: string }[];
  isPending: boolean;
  submit: (e: React.FormEvent) => void;
  reset: () => void;
}

export function useCreateTrunk(onClose: () => void): UseCreateTrunkResult {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const [form, setForm] = useState<CreateFormState>(INITIAL_CREATE);

  const { data: customersData } = useQuery({
    queryKey: ['customers', { limit: 500 }],
    queryFn: () => listCustomers({ limit: 500 }),
  });

  const mutation = useMutation({
    mutationFn: () =>
      createTrunk({
        customer_id: parseInt(form.customer_id, 10),
        trunk_name: form.trunk_name.trim(),
        auth_type: form.auth_type,
        max_channels: parseInt(form.max_channels, 10) || 10,
        cps_limit: parseInt(form.cps_limit, 10) || 5,
      }),
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: ['trunks'] });
      setForm(INITIAL_CREATE);
      toastOk(`Trunk "${created.trunk_name}" created`);
      onClose();
    },
    onError: (err: Error) => toastErr(err.message),
  });

  const submit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!form.customer_id) { toastErr('Please select a customer'); return; }
      if (!form.trunk_name.trim()) { toastErr('Trunk name is required'); return; }
      mutation.mutate();
    },
    [form.customer_id, form.trunk_name, mutation, toastErr],
  );

  const reset = useCallback(() => {
    setForm(INITIAL_CREATE);
    onClose();
  }, [onClose]);

  const customers = (customersData?.items ?? []).map((c) => ({ id: c.id, name: c.name }));

  return { form, setForm, customers, isPending: mutation.isPending, submit, reset };
}

// ── Edit trunk ───────────────────────────────────────────────────────────────

export interface UseEditTrunkResult {
  form: EditFormState;
  setForm: React.Dispatch<React.SetStateAction<EditFormState>>;
  isPending: boolean;
  submit: (e: React.FormEvent) => void;
}

export function useEditTrunk(trunk: Trunk, onSaved: () => void): UseEditTrunkResult {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();

  const [form, setForm] = useState<EditFormState>({
    trunk_name: trunk.trunk_name,
    max_channels: String(trunk.max_channels),
    cps_limit: String(trunk.cps_limit),
    enabled: trunk.enabled,
  });

  const mutation = useMutation({
    mutationFn: () =>
      updateTrunk(trunk.id, {
        trunk_name: form.trunk_name.trim(),
        max_channels: parseInt(form.max_channels, 10) || 10,
        cps_limit: parseInt(form.cps_limit, 10) || 5,
        enabled: form.enabled,
      }),
    onSuccess: (updated) => {
      void qc.invalidateQueries({ queryKey: ['trunks'] });
      toastOk(`Trunk "${updated.trunk_name}" updated`);
      onSaved();
    },
    onError: (err: Error) => toastErr(err.message),
  });

  const submit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!form.trunk_name.trim()) { toastErr('Trunk name is required'); return; }
      mutation.mutate();
    },
    [form.trunk_name, mutation, toastErr],
  );

  return { form, setForm, isPending: mutation.isPending, submit };
}

// ── Inline trunk-name rename ─────────────────────────────────────────────────

export interface UseInlineTrunkNameResult {
  editing: boolean;
  value: string;
  hovered: boolean;
  isPending: boolean;
  setValue: (v: string) => void;
  setHovered: (h: boolean) => void;
  beginEdit: () => void;
  save: () => void;
  cancel: () => void;
}

export function useInlineTrunkName(trunkId: number, name: string): UseInlineTrunkNameResult {
  const qc = useQueryClient();
  const { toastErr } = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [hovered, setHovered] = useState(false);

  // Keep the local value in sync when the underlying name changes externally
  // (e.g. after a refetch) while not actively editing.
  const [prev, setPrev] = useState(name);
  if (name !== prev) {
    setPrev(name);
    if (!editing) setValue(name);
  }

  const mutation = useMutation({
    mutationFn: (n: string) => updateTrunk(trunkId, { trunk_name: n }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin-trunks'] });
      setEditing(false);
    },
    onError: (err: Error) => toastErr(err.message),
  });

  const cancel = useCallback(() => {
    setValue(name);
    setEditing(false);
  }, [name]);

  const save = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed) { cancel(); return; }
    if (trimmed === name) { setEditing(false); return; }
    mutation.mutate(trimmed);
  }, [value, name, mutation, cancel]);

  return {
    editing,
    value,
    hovered,
    isPending: mutation.isPending,
    setValue,
    setHovered,
    beginEdit: () => setEditing(true),
    save,
    cancel,
  };
}

// ── IP management ────────────────────────────────────────────────────────────

export interface UseIpManagerResult {
  ips: TrunkIp[] | undefined;
  isLoading: boolean;
  newIp: string;
  newIpDesc: string;
  isAdding: boolean;
  isDeleting: boolean;
  setNewIp: (v: string) => void;
  setNewIpDesc: (v: string) => void;
  add: (e: React.FormEvent) => void;
  remove: (ipId: number) => void;
}

export function useIpManager(trunkId: number): UseIpManagerResult {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const [newIp, setNewIp] = useState('');
  const [newIpDesc, setNewIpDesc] = useState('');

  const { data: ips, isLoading } = useQuery<TrunkIp[]>({
    queryKey: ['trunk-ips', trunkId],
    queryFn: () => getTrunkIps(trunkId),
  });

  const addMutation = useMutation({
    mutationFn: () => addTrunkIp(trunkId, newIp.trim(), newIpDesc.trim() || undefined),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['trunk-ips', trunkId] });
      void qc.invalidateQueries({ queryKey: ['trunks'] });
      setNewIp('');
      setNewIpDesc('');
      toastOk('IP address added');
    },
    onError: (err: Error) => toastErr(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (ipId: number) => deleteTrunkIp(trunkId, ipId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['trunk-ips', trunkId] });
      void qc.invalidateQueries({ queryKey: ['trunks'] });
      toastOk('IP address removed');
    },
    onError: (err: Error) => toastErr(err.message),
  });

  const add = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!newIp.trim()) { toastErr('IP address is required'); return; }
      addMutation.mutate();
    },
    [newIp, addMutation, toastErr],
  );

  return {
    ips,
    isLoading,
    newIp,
    newIpDesc,
    isAdding: addMutation.isPending,
    isDeleting: deleteMutation.isPending,
    setNewIp,
    setNewIpDesc,
    add,
    remove: (ipId) => deleteMutation.mutate(ipId),
  };
}

// ── DID management (list + add w/ confirm + searchable available-TN dropdown) ─

export interface UseDidManagerResult {
  dids: TrunkDid[] | undefined;
  isLoading: boolean;
  isDeleting: boolean;
  isAdding: boolean;

  // input + dropdown
  inputValue: string;
  dropdownOpen: boolean;
  highlightedIndex: number;
  loadingTNs: boolean;
  options: AvailableTN[];

  // confirmation
  showConfirm: boolean;
  pendingLabel: string;

  // handlers
  onInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onInputFocus: () => void;
  onInputKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  selectOption: (tn: AvailableTN) => void;
  stageAdd: (e: React.FormEvent) => void;
  confirmAdd: () => void;
  cancelConfirm: () => void;
  remove: (didId: number) => void;
}

/**
 * @param wrapperRef ref to the input+dropdown wrapper `<div>`, OWNED BY THE
 *   COMPONENT that renders it and passed in for the click-outside behaviour.
 *   Returning a ref inside this hook's (large, mixed) result object makes the
 *   react-hooks/refs inference treat every `result.*` read during render as a
 *   potential ref access — keep refs out of the return value.
 */
export function useDidManager(
  trunkId: number,
  wrapperRef: RefObject<HTMLDivElement | null>,
): UseDidManagerResult {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();

  const [inputValue, setInputValue] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [selectedTN, setSelectedTN] = useState<AvailableTN | null>(null);

  const [pendingDid, setPendingDid] = useState('');
  const [pendingTN, setPendingTN] = useState<AvailableTN | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);

  const { data: dids, isLoading } = useQuery<TrunkDid[]>({
    queryKey: ['trunk-dids', trunkId],
    queryFn: () => getTrunkDids(trunkId),
  });

  const addMutation = useMutation({
    mutationFn: (did: string) => addTrunkDid(trunkId, did),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['trunk-dids', trunkId] });
      void qc.invalidateQueries({ queryKey: ['trunks'] });
      setInputValue('');
      setSelectedTN(null);
      setShowConfirm(false);
      setPendingDid('');
      setPendingTN(null);
      toastOk('DID added');
    },
    onError: (err: Error) => toastErr(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (didId: number) => deleteTrunkDid(trunkId, didId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['trunk-dids', trunkId] });
      void qc.invalidateQueries({ queryKey: ['trunks'] });
      toastOk('DID removed');
    },
    onError: (err: Error) => toastErr(err.message),
  });

  // Available inventory numbers for the dropdown. React Query (not a manual
  // fetch-in-effect, which set state synchronously in the effect body —
  // react-hooks/set-state-in-effect) also dedupes the request across every
  // mounted DID section via the shared key. Failure is non-fatal: options stay
  // empty and the user can still type a number manually, so no error surface.
  const { data: availableTNs, isLoading: loadingTNs } = useQuery<AvailableTN[]>({
    queryKey: ['available-tns'],
    queryFn: () => apiRequest<AvailableTN[]>('GET', '/numbers/available'),
    retry: false,
  });

  // Click-outside closes the dropdown. `wrapperRef` is a stable useRef object
  // from the owning component, so this effect runs once in practice — it is
  // listed as a dep because it arrives as a parameter (react-hooks/exhaustive-deps).
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
        setHighlightedIndex(-1);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [wrapperRef]);

  const options = useMemo<AvailableTN[]>(() => {
    const all = availableTNs ?? [];
    const q = inputValue.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (t) =>
        t.tn.toLowerCase().includes(q) ||
        t.city.toLowerCase().includes(q) ||
        t.state.toLowerCase().includes(q),
    );
  }, [inputValue, availableTNs]);

  const selectOption = useCallback((tn: AvailableTN) => {
    setInputValue(tn.tn);
    setSelectedTN(tn);
    setDropdownOpen(false);
    setHighlightedIndex(-1);
  }, []);

  const onInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setInputValue(val);
    setSelectedTN(null);
    setDropdownOpen(true);
    setHighlightedIndex(-1);
    setShowConfirm((prev) => {
      if (prev) { setPendingDid(''); setPendingTN(null); }
      return false;
    });
  }, []);

  const onInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlightedIndex((i) => Math.min(i + 1, options.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlightedIndex((i) => Math.max(i - 1, -1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (highlightedIndex >= 0 && options[highlightedIndex]) {
          selectOption(options[highlightedIndex]);
        }
      } else if (e.key === 'Escape') {
        setDropdownOpen(false);
        setHighlightedIndex(-1);
      }
    },
    [options, highlightedIndex, selectOption],
  );

  const stageAdd = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const value = inputValue.trim();
      if (!value) { toastErr('DID is required'); return; }
      setPendingDid(value);
      setPendingTN(selectedTN);
      setShowConfirm(true);
      setDropdownOpen(false);
    },
    [inputValue, selectedTN, toastErr],
  );

  const cancelConfirm = useCallback(() => {
    setShowConfirm(false);
    setPendingDid('');
    setPendingTN(null);
  }, []);

  const pendingLabel = pendingTN
    ? `${pendingTN.tn} (${pendingTN.city}, ${pendingTN.state})`
    : pendingDid;

  return {
    dids,
    isLoading,
    isDeleting: deleteMutation.isPending,
    isAdding: addMutation.isPending,
    inputValue,
    dropdownOpen,
    highlightedIndex,
    loadingTNs,
    options,
    showConfirm,
    pendingLabel,
    onInputChange,
    onInputFocus: () => setDropdownOpen(true),
    onInputKeyDown,
    selectOption,
    stageAdd,
    confirmAdd: () => addMutation.mutate(pendingDid),
    cancelConfirm,
    remove: (didId) => deleteMutation.mutate(didId),
  };
}
