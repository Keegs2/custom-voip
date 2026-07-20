/**
 * Data + logic layer for the SIP Trunks glass page.
 *
 * Per the refactor convention (docs/FRONTEND_GLASS_REFACTOR.md): the page does
 * composition + top-level state only; all data fetching, mutations, and derived
 * state live here. Presentational components stay dumb.
 *
 * React #310: every hook below is called unconditionally at the top of its
 * hook function — no early returns precede a hook.
 */

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listTrunks,
  createTrunk,
  deleteTrunk,
  getTrunkStats,
  getTrunkIps,
  addTrunkIp,
  deleteTrunkIp,
  getTrunkDids,
} from '../../api/trunks';
import { useToast } from '../../components/ui/Toast';
import type {
  Trunk,
  TrunkIp,
  TrunkDid,
  TrunkStats,
  TrunkAuthType,
} from '../../types/trunk';

// ── IP validation ────────────────────────────────────────────────────────────

/** Validates an IPv4 address, optionally with a CIDR suffix (e.g. 203.0.113.0/24). */
export function isValidIpv4(input: string): boolean {
  const [addr, mask, ...rest] = input.trim().split('/');
  if (rest.length > 0) return false;
  const parts = addr.split('.');
  if (parts.length !== 4) return false;
  const okAddr = parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
  if (!okAddr) return false;
  if (mask !== undefined) {
    if (!/^\d{1,2}$/.test(mask)) return false;
    const n = Number(mask);
    if (n < 0 || n > 32) return false;
  }
  return true;
}

// ── Trunk list + derived totals/filter ───────────────────────────────────────

export interface TrunkTotals {
  active: number;
  channels: number;
  dids: number;
}

export interface UseTrunksDataResult {
  trunks: Trunk[];
  filtered: Trunk[];
  totals: TrunkTotals;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  refetch: () => void;
}

export function useTrunksData(customerId: number | undefined, search: string): UseTrunksDataResult {
  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ['trunks', { customerId }],
    queryFn: () => listTrunks({ customer_id: customerId, limit: 200 }),
  });

  const trunks = useMemo(() => data?.items ?? [], [data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return trunks;
    return trunks.filter(
      (t) =>
        t.trunk_name.toLowerCase().includes(q) ||
        (t.customer_name ?? '').toLowerCase().includes(q) ||
        t.auth_type.toLowerCase().includes(q),
    );
  }, [trunks, search]);

  const totals = useMemo<TrunkTotals>(() => {
    const active = trunks.filter((t) => t.enabled).length;
    const channels = trunks.reduce((sum, t) => sum + (t.max_channels || 0), 0);
    const dids = trunks.reduce((sum, t) => sum + (t.did_count ?? 0), 0);
    return { active, channels, dids };
  }, [trunks]);

  return { trunks, filtered, totals, isLoading, isError, isFetching, refetch: () => void refetch() };
}

// ── Delete trunk ─────────────────────────────────────────────────────────────

/** The delete mutation; the page wraps it with a confirm() guard. */
export function useDeleteTrunk() {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  return useMutation({
    mutationFn: (trunk: Trunk) => deleteTrunk(trunk.id),
    onSuccess: (_data, trunk) => {
      void qc.invalidateQueries({ queryKey: ['trunks'] });
      toastOk(`Trunk "${trunk.trunk_name}" deleted`);
    },
    onError: (err: Error) => toastErr(err.message),
  });
}

// ── Live stats (per-trunk, polled) ───────────────────────────────────────────

export function useTrunkLiveStats(trunkId: number) {
  return useQuery<TrunkStats>({
    queryKey: ['trunk-stats', trunkId],
    queryFn: () => getTrunkStats(trunkId),
    refetchInterval: 15_000,
    staleTime: 5_000,
  });
}

// ── DIDs (per-trunk) ─────────────────────────────────────────────────────────

export function useTrunkDids(trunkId: number) {
  return useQuery<TrunkDid[]>({
    queryKey: ['trunk-dids', trunkId],
    queryFn: () => getTrunkDids(trunkId),
    staleTime: 30_000,
  });
}

// ── Authorized-IP manager (query + add/delete + form state) ──────────────────

export interface UseTrunkIpManagerResult {
  ips: TrunkIp[];
  isLoading: boolean;
  newIp: string;
  setNewIp: (v: string) => void;
  newDesc: string;
  setNewDesc: (v: string) => void;
  setTouched: (v: boolean) => void;
  showError: boolean;
  addPending: boolean;
  handleAdd: (e: React.FormEvent) => void;
  handleDelete: (ip: TrunkIp) => void;
}

export function useTrunkIpManager(trunkId: number): UseTrunkIpManagerResult {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const [newIp, setNewIp] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [touched, setTouched] = useState(false);

  const ipsQuery = useQuery<TrunkIp[]>({
    queryKey: ['trunk-ips', trunkId],
    queryFn: () => getTrunkIps(trunkId),
    staleTime: 30_000,
  });

  const addMutation = useMutation({
    mutationFn: () => addTrunkIp(trunkId, newIp.trim(), newDesc.trim() || undefined),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['trunk-ips', trunkId] });
      void qc.invalidateQueries({ queryKey: ['trunks'] });
      setNewIp('');
      setNewDesc('');
      setTouched(false);
      toastOk('Authorized IP added');
    },
    onError: (err: Error) => toastErr(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (ipId: number) => deleteTrunkIp(trunkId, ipId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['trunk-ips', trunkId] });
      void qc.invalidateQueries({ queryKey: ['trunks'] });
      toastOk('IP removed');
    },
    onError: (err: Error) => toastErr(err.message),
  });

  const ipValid = isValidIpv4(newIp);
  const showError = touched && newIp.trim().length > 0 && !ipValid;

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!ipValid) {
      toastErr('Enter a valid IPv4 address (optionally with a CIDR mask)');
      return;
    }
    addMutation.mutate();
  }

  function handleDelete(ip: TrunkIp) {
    if (!confirm(`Remove ${ip.ip_address} from the authorized IP list? Calls from this address will be rejected.`)) return;
    deleteMutation.mutate(ip.id);
  }

  return {
    ips: ipsQuery.data ?? [],
    isLoading: ipsQuery.isLoading,
    newIp,
    setNewIp,
    newDesc,
    setNewDesc,
    setTouched,
    showError,
    addPending: addMutation.isPending,
    handleAdd,
    handleDelete,
  };
}

// ── Create trunk (modal form + mutation) ─────────────────────────────────────

export interface UseCreateTrunkResult {
  name: string;
  setName: (v: string) => void;
  authType: TrunkAuthType;
  setAuthType: (v: TrunkAuthType) => void;
  maxChannels: string;
  setMaxChannels: (v: string) => void;
  cps: string;
  setCps: (v: string) => void;
  pending: boolean;
  handleSubmit: () => void;
}

export function useCreateTrunk(customerId: number, onClose: () => void): UseCreateTrunkResult {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const [name, setName] = useState('');
  const [authType, setAuthType] = useState<TrunkAuthType>('ip');
  const [maxChannels, setMaxChannels] = useState('10');
  const [cps, setCps] = useState('5');

  const mutation = useMutation({
    mutationFn: () =>
      createTrunk({
        customer_id: customerId,
        trunk_name: name.trim(),
        auth_type: authType,
        max_channels: Number(maxChannels) || 1,
        cps_limit: Number(cps) || 1,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['trunks'] });
      toastOk(`Trunk "${name.trim()}" created`);
      setName('');
      setAuthType('ip');
      setMaxChannels('10');
      setCps('5');
      onClose();
    },
    onError: (err: Error) => toastErr(err.message),
  });

  function handleSubmit() {
    if (!name.trim()) {
      toastErr('Trunk name is required');
      return;
    }
    mutation.mutate();
  }

  return {
    name,
    setName,
    authType,
    setAuthType,
    maxChannels,
    setMaxChannels,
    cps,
    setCps,
    pending: mutation.isPending,
    handleSubmit,
  };
}
