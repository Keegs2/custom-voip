/**
 * Data + logic layer for the Customer Account (customer 360) page.
 *
 * Per the refactor convention (docs/FRONTEND_GLASS_REFACTOR.md): the page does
 * composition + top-level state only; ALL queries, mutations, and derived state
 * live here. Presentational components stay dumb.
 *
 * React #310: every hook below is called unconditionally at the top of its hook
 * function — no early returns precede a hook.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { getCustomer, deleteCustomer } from '../../../api/customers';
import { getCustomerTier } from '../../../api/tiers';
import { apiRequest } from '../../../api/client';
import { getCustomerRecentCdrs, getCustomerCdrDailySummary } from '../../../api/cdrs';
import { useToast } from '../../../components/ui/ToastContext';
import type { Customer } from '../../../types/customer';
import type { CdrSummaryRow } from '../../../types/rate';
import type { AddCreditResponse, UsageSummary } from './types';

// ── Pure helpers (kept local for exact parity with the original page) ─────────

export function computeSummary(rows: CdrSummaryRow[]): UsageSummary {
  let totalCalls = 0;
  let answeredCalls = 0;
  let totalDurationSec = 0;
  let totalCost = 0;

  for (const row of rows) {
    totalCalls += row.total_calls;
    answeredCalls += row.answered_calls;
    totalDurationSec += row.total_duration_sec;
    totalCost += row.total_cost ?? 0;
  }

  const asr = totalCalls > 0 ? Math.round((answeredCalls / totalCalls) * 100) : 0;
  const avgDurationSec = answeredCalls > 0 ? totalDurationSec / answeredCalls : 0;

  return {
    totalCalls,
    answeredCalls,
    asr,
    totalMinutes: Math.round(totalDurationSec / 60),
    avgDurationSec,
    totalCost,
  };
}

export function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// ── Page-level data: the customer + delete ───────────────────────────────────

export function useCustomerAccount(customerId: number) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();

  const query = useQuery({
    queryKey: ['customer', customerId],
    queryFn: () => getCustomer(customerId),
    enabled: !isNaN(customerId),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteCustomer(customerId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customers'] });
      toastOk('Customer deleted');
      navigate('/admin/customers', { replace: true });
    },
    onError: (err: Error) => toastErr(err.message),
  });

  return { query, deleteMutation };
}

// ── Tier line ────────────────────────────────────────────────────────────────

export function useCustomerTierLine(customerId: number) {
  return useQuery({
    queryKey: ['customerTier', customerId],
    queryFn: () => getCustomerTier(customerId),
  });
}

// ── Account actions: add-credit, UCaaS toggle, Voicemail toggle ───────────────

export function useAccountActions(customer: Customer) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const [creditAmount, setCreditAmount] = useState('');

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['customer', customer.id] });
    qc.invalidateQueries({ queryKey: ['customers'] });
  };

  const addCreditMutation = useMutation({
    mutationFn: (amount: number) =>
      apiRequest<AddCreditResponse>('POST', `/customers/${customer.id}/credit?amount=${amount}`),
    onSuccess: (data) => {
      invalidate();
      toastOk(
        `Added $${parseFloat(creditAmount).toFixed(2)} credit. New balance: $${data.balance.toFixed(2)}`,
      );
      setCreditAmount('');
    },
    onError: (err: Error) => toastErr(err.message),
  });

  const ucaasMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      apiRequest<Customer>('PUT', `/customers/${customer.id}`, { ucaas_enabled: enabled }),
    onSuccess: () => {
      invalidate();
      toastOk(`UCaaS add-on ${!customer.ucaas_enabled ? 'enabled' : 'disabled'}`);
    },
    onError: (err: Error) => toastErr(err.message),
  });

  const voicemailMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      apiRequest<Customer>('PUT', `/customers/${customer.id}`, { voicemail_enabled: enabled }),
    onSuccess: () => {
      invalidate();
      toastOk(`Voicemail add-on ${!customer.voicemail_enabled ? 'enabled' : 'disabled'}`);
    },
    onError: (err: Error) => toastErr(err.message),
  });

  function submitCredit(e: React.FormEvent) {
    e.preventDefault();
    const amount = parseFloat(creditAmount);
    if (!amount || amount <= 0) {
      toastErr('Enter a valid amount');
      return;
    }
    addCreditMutation.mutate(amount);
  }

  return {
    creditAmount,
    setCreditAmount,
    submitCredit,
    addCreditMutation,
    ucaasMutation,
    voicemailMutation,
  };
}

// ── Usage & analytics: recent CDRs + daily summary ────────────────────────────

export function useCustomerUsage(customerId: number) {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const recent = useQuery({
    queryKey: ['customerCdrs', customerId, 'recent'],
    queryFn: () => getCustomerRecentCdrs(customerId, 20, thirtyDaysAgo),
    staleTime: 60_000,
  });

  const summary = useQuery({
    queryKey: ['customerCdrs', customerId, 'daily'],
    queryFn: () => getCustomerCdrDailySummary(customerId),
    staleTime: 60_000,
  });

  const summaryRows = summary.data?.summary ?? [];
  const recentCdrs = recent.data?.items ?? [];

  return {
    isLoading: recent.isLoading || summary.isLoading,
    isError: recent.isError || summary.isError,
    summaryRows,
    recentCdrs,
    computedSummary: computeSummary(summaryRows),
  };
}
