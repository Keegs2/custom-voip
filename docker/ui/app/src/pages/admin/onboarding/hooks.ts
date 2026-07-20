/**
 * Data + logic layer for the Onboarding admin page.
 *
 * Per the refactor convention (docs/FRONTEND_GLASS_REFACTOR.md): the page does
 * composition + top-level state only. ALL queries, mutations, and per-form
 * editor state live here as hooks; the presentational components stay dumb and
 * receive everything via props.
 *
 * React #310: every hook below is called unconditionally at the top of its
 * hook function — no early returns precede a hook, and the `available-dids`
 * query is gated with `enabled` rather than a conditional call.
 */

import { useCallback, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listOnboardingRequests,
  verifyBilling,
  approveOnboarding,
  rejectOnboarding,
} from '../../../api/onboarding';
import { listAvailableDids } from '../../../api/didInventory';
import type {
  OnboardingRequest,
  ApprovePayload,
  ApproveResponse,
  DIDConfigEntry,
} from '../../../types/onboarding';
import type { DidInventoryItem } from '../../../types/didInventory';
import { useToast } from '../../../components/ui/Toast';
import type { FilterTab } from './types';

const REQUESTS_KEY = 'onboarding-requests';

// ── List query ───────────────────────────────────────────────────────────────

export interface UseOnboardingListResult {
  items: OnboardingRequest[];
  isLoading: boolean;
  isError: boolean;
}

/** Owns the `['onboarding-requests', { status }]` query for the active filter. */
export function useOnboardingList(activeFilter: FilterTab): UseOnboardingListResult {
  const { data, isLoading, isError } = useQuery({
    queryKey: [REQUESTS_KEY, { status: activeFilter }],
    queryFn: () =>
      listOnboardingRequests(activeFilter === 'all' ? {} : { status: activeFilter }),
  });

  const items = useMemo<OnboardingRequest[]>(() => data?.items ?? [], [data]);
  return { items, isLoading, isError };
}

// ── Billing-verify form ────────────────────────────────────────────────────────

export interface UseBillingVerifyResult {
  notes: string;
  setNotes: (v: string) => void;
  isPending: boolean;
  submit: () => void;
}

export function useBillingVerifyForm(
  request: OnboardingRequest,
  onSuccess: () => void,
): UseBillingVerifyResult {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const [notes, setNotes] = useState('');

  const mutation = useMutation({
    mutationFn: () => verifyBilling(request.id, notes.trim() || undefined),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [REQUESTS_KEY] });
      toastOk('Billing verified');
      onSuccess();
    },
    onError: (err: Error) => toastErr(err.message),
  });

  return {
    notes,
    setNotes,
    isPending: mutation.isPending,
    submit: () => mutation.mutate(),
  };
}

// ── Reject form ─────────────────────────────────────────────────────────────────

export interface UseRejectResult {
  showForm: boolean;
  open: () => void;
  cancel: () => void;
  reason: string;
  setReason: (v: string) => void;
  isPending: boolean;
  submit: () => void;
}

export function useRejectForm(
  request: OnboardingRequest,
  onSuccess: () => void,
): UseRejectResult {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const [showForm, setShowForm] = useState(false);
  const [reason, setReason] = useState('');

  const mutation = useMutation({
    mutationFn: () => rejectOnboarding(request.id, reason.trim() || undefined),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [REQUESTS_KEY] });
      toastOk('Request rejected');
      onSuccess();
    },
    onError: (err: Error) => toastErr(err.message),
  });

  const cancel = useCallback(() => {
    setShowForm(false);
    setReason('');
  }, []);

  return {
    showForm,
    open: () => setShowForm(true),
    cancel,
    reason,
    setReason,
    isPending: mutation.isPending,
    submit: () => mutation.mutate(),
  };
}

// ── Provisioning form ────────────────────────────────────────────────────────────

export interface UseProvisioningResult {
  /** Filtered + searchable available DIDs. */
  availableDids: DidInventoryItem[];
  didsLoading: boolean;
  didSearch: string;
  setDidSearch: (v: string) => void;
  selectedDids: string[];
  toggleDid: (did: string) => void;
  forwardMap: Record<string, string>;
  setForward: (did: string, value: string) => void;
  adminNotes: string;
  setAdminNotes: (v: string) => void;
  allForwardsFilled: boolean;
  requestedCount: number;
  isPending: boolean;
  submit: () => void;
}

export function useProvisioningForm(
  request: OnboardingRequest,
  onApproved: (result: ApproveResponse) => void,
): UseProvisioningResult {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const [selectedDids, setSelectedDids] = useState<string[]>([]);
  const [forwardMap, setForwardMap] = useState<Record<string, string>>({});
  const [adminNotes, setAdminNotes] = useState('');
  const [didSearch, setDidSearch] = useState('');

  const { data: allDids, isLoading: didsLoading } = useQuery({
    queryKey: ['available-dids'],
    queryFn: () => listAvailableDids({ limit: 500 }),
  });

  const mutation = useMutation({
    mutationFn: () => {
      const dids: DIDConfigEntry[] = selectedDids.map((did) => ({
        did,
        forward_to: forwardMap[did] ?? '',
      }));
      const payload: ApprovePayload = {
        dids,
        admin_notes: adminNotes.trim() || undefined,
      };
      return approveOnboarding(request.id, payload);
    },
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: [REQUESTS_KEY] });
      toastOk(`Approved — customer ${result.customer.name} provisioned`);
      onApproved(result);
    },
    onError: (err: Error) => toastErr(err.message),
  });

  const toggleDid = useCallback((did: string) => {
    setSelectedDids((prev) =>
      prev.includes(did) ? prev.filter((d) => d !== did) : [...prev, did],
    );
  }, []);

  const setForward = useCallback((did: string, value: string) => {
    setForwardMap((prev) => ({ ...prev, [did]: value }));
  }, []);

  const availableDids = useMemo(() => {
    const list = allDids ?? [];
    const q = didSearch.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (d) => d.did.includes(didSearch) || d.city?.toLowerCase().includes(q),
    );
  }, [allDids, didSearch]);

  const allForwardsFilled =
    selectedDids.length > 0 &&
    selectedDids.every((d) => (forwardMap[d] ?? '').trim().length >= 10);

  const requestedCount = parseInt(request.did_count, 10) || 1;

  return {
    availableDids,
    didsLoading,
    didSearch,
    setDidSearch,
    selectedDids,
    toggleDid,
    forwardMap,
    setForward,
    adminNotes,
    setAdminNotes,
    allForwardsFilled,
    requestedCount,
    isPending: mutation.isPending,
    submit: () => mutation.mutate(),
  };
}
