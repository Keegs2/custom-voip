/**
 * Shared TanStack Query hooks + query keys for the payments demo.
 *
 * Centralising the query keys and the polling cadences here keeps the "numbers
 * move live" behaviour consistent across the customer page, the machine view,
 * and the admin dashboards: a presenter fires a scenario in the control panel
 * and every mounted surface refetches on its own poll interval and visibly
 * reacts. Invalidation helpers let a mutation force an immediate refresh across
 * the whole family.
 *
 * These are READ hooks only. Mutations live in each feature folder's `hooks.ts`
 * so page-specific side-effects (toasts, optimistic streams) stay local.
 */

import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  getAutoRecharge,
  getBalance,
  getComplianceStatus,
  getDemoState,
  getLedger,
  getPaymentsSummary,
  getUsage,
  listInvoices,
  listMppSessions,
  listPaymentMethods,
} from '../../api/payments';

/** Namespaced query keys — one root so the whole family invalidates together. */
export const paymentsKeys = {
  all: ['payments'] as const,
  balance: ['payments', 'balance'] as const,
  ledger: (limit: number) => ['payments', 'ledger', limit] as const,
  methods: ['payments', 'methods'] as const,
  autoRecharge: ['payments', 'auto-recharge'] as const,
  invoices: ['payments', 'invoices'] as const,
  usage: ['payments', 'usage'] as const,
  mppSessions: ['payments', 'mpp-sessions'] as const,
  summary: ['payments', 'summary'] as const,
  compliance: ['payments', 'compliance'] as const,
  demoState: ['payments', 'demo-state'] as const,
};

/**
 * Invalidate the entire payments query family. Call after any demo scenario or
 * money-moving mutation so every mounted dashboard refreshes at once.
 */
export function invalidatePayments(qc: QueryClient): Promise<void> {
  return qc.invalidateQueries({ queryKey: paymentsKeys.all });
}

// Polling cadences — brisk enough that the demo feels alive, gentle on the API.
const FAST_POLL = 3000; // balance / ledger / MPP tabs during active scenarios
const MED_POLL = 6000; // summary / usage / demo-state
const SLOW_POLL = 15000; // compliance / invoices (rarely change)

export function useBalance(enabled = true) {
  return useQuery({
    queryKey: paymentsKeys.balance,
    queryFn: getBalance,
    refetchInterval: FAST_POLL,
    enabled,
  });
}

export function useLedger(limit = 40, enabled = true) {
  return useQuery({
    queryKey: paymentsKeys.ledger(limit),
    queryFn: () => getLedger(limit),
    refetchInterval: FAST_POLL,
    enabled,
  });
}

export function usePaymentMethods(enabled = true) {
  return useQuery({
    queryKey: paymentsKeys.methods,
    queryFn: listPaymentMethods,
    enabled,
  });
}

export function useAutoRecharge(enabled = true) {
  return useQuery({
    queryKey: paymentsKeys.autoRecharge,
    queryFn: getAutoRecharge,
    refetchInterval: MED_POLL,
    enabled,
  });
}

export function useInvoices(enabled = true) {
  return useQuery({
    queryKey: paymentsKeys.invoices,
    queryFn: listInvoices,
    refetchInterval: SLOW_POLL,
    enabled,
  });
}

export function useUsage(enabled = true) {
  return useQuery({
    queryKey: paymentsKeys.usage,
    queryFn: getUsage,
    refetchInterval: MED_POLL,
    enabled,
  });
}

export function useMppSessions(enabled = true) {
  return useQuery({
    queryKey: paymentsKeys.mppSessions,
    queryFn: listMppSessions,
    refetchInterval: FAST_POLL,
    enabled,
  });
}

export function usePaymentsSummary(enabled = true) {
  return useQuery({
    queryKey: paymentsKeys.summary,
    // Wrap so the react-query context isn't passed as the `scope` arg.
    queryFn: () => getPaymentsSummary('demo'),
    refetchInterval: MED_POLL,
    enabled,
  });
}

export function useComplianceStatus(enabled = true) {
  return useQuery({
    queryKey: paymentsKeys.compliance,
    queryFn: getComplianceStatus,
    refetchInterval: SLOW_POLL,
    enabled,
  });
}

export function useDemoState(enabled = true) {
  return useQuery({
    queryKey: paymentsKeys.demoState,
    queryFn: getDemoState,
    refetchInterval: MED_POLL,
    enabled,
  });
}

/** Re-export the invalidation helper for callers that already have the client. */
export function usePaymentsInvalidate(): () => Promise<void> {
  const qc = useQueryClient();
  return () => invalidatePayments(qc);
}
