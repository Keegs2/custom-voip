/**
 * Data + mutation hooks for the Rates admin feature. The page/components stay
 * presentational; every `useQuery`/`useMutation` and the query-key wiring lives
 * here (see docs/FRONTEND_GLASS_REFACTOR.md §1).
 */

import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listRates, getMarginsData, createRate, updateRate, deleteRate } from '../../../../api/rates';
import { useToast } from '../../../../components/ui/Toast';
import type { Rate, RateCreate, RateUpdate } from '../../../../types/rate';
import { RATES_LIMIT } from './types';

/** Top-level rate-deck + margins query bundle for the Rates tab. */
export function useRatesData() {
  const ratesQuery = useQuery({
    queryKey: ['rates'],
    queryFn: () => listRates({ limit: RATES_LIMIT }),
  });

  const marginsQuery = useQuery({
    queryKey: ['margins'],
    queryFn: getMarginsData,
  });

  // Several list endpoints return either an array or { rates } / { items }.
  const rates: Rate[] = useMemo(() => {
    const data = ratesQuery.data as unknown;
    if (Array.isArray(data)) return data as Rate[];
    const obj = data as { rates?: Rate[]; items?: Rate[] } | undefined;
    return obj?.rates ?? obj?.items ?? [];
  }, [ratesQuery.data]);

  return {
    rates,
    margins: marginsQuery.data,
    isLoading: ratesQuery.isLoading || marginsQuery.isLoading,
    isError: ratesQuery.isError,
  };
}

function invalidateRates(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ['rates'] });
  void qc.invalidateQueries({ queryKey: ['margins'] });
}

/** Inline edit (update) + delete mutations for a rates row. */
export function useRateRowMutations() {
  const { toastOk, toastErr } = useToast();
  const queryClient = useQueryClient();

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: RateUpdate }) => updateRate(id, data),
    onSuccess: (_, { id }) => {
      toastOk(`Rate #${id} updated`);
      invalidateRates(queryClient);
    },
    onError: (err: Error) => toastErr(`Update failed: ${err.message}`),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteRate(id),
    onSuccess: (_, id) => {
      toastOk(`Rate #${id} deleted`);
      invalidateRates(queryClient);
    },
    onError: (err: Error) => toastErr(`Delete failed: ${err.message}`),
  });

  return { updateMutation, deleteMutation };
}

/** Create mutation for the add-rate form. */
export function useRateCreate(onCreated: () => void) {
  const { toastOk, toastErr } = useToast();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: RateCreate) => createRate(data),
    onSuccess: (_, data) => {
      toastOk(`Rate ${data.prefix} added`);
      invalidateRates(queryClient);
      onCreated();
    },
    onError: (err: Error) => toastErr(err.message),
  });
}
