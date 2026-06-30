/**
 * Data + logic layer for the Customers admin page.
 *
 * Per the refactor convention (docs/FRONTEND_GLASS_REFACTOR.md) the page does
 * composition + top-level state only; the customer list query and the create
 * mutation (plus its form state) live here.
 *
 * React #310: every hook below is called unconditionally at the top of its hook
 * function — no early returns precede a hook.
 */

import { useCallback, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listCustomers, createCustomer } from '../../../api/customers';
import { useToast } from '../../../components/ui/ToastContext';
import type { Customer } from '../../../types/customer';
import { type CreateFormState, INITIAL_CREATE, PAGE_SIZE } from './types';

export interface UseCustomersListArgs {
  search: string;
  offset: number;
}

export interface UseCustomersListResult {
  items: Customer[];
  total: number;
  isLoading: boolean;
  isError: boolean;
  hasData: boolean;
}

/** Owns the paginated `['customers', { search, offset }]` query. */
export function useCustomersList({ search, offset }: UseCustomersListArgs): UseCustomersListResult {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['customers', { search, offset }],
    queryFn: () => listCustomers({ search, limit: PAGE_SIZE, offset }),
  });

  return {
    items: data?.items ?? [],
    total: data?.total ?? 0,
    isLoading,
    isError,
    hasData: data !== undefined,
  };
}

export interface UseCreateCustomerResult {
  form: CreateFormState;
  isPending: boolean;
  updateField: <K extends keyof CreateFormState>(key: K, value: CreateFormState[K]) => void;
  submit: (e: React.FormEvent) => void;
  reset: () => void;
}

/**
 * Owns the inline create-form state plus the real `POST /customers` mutation.
 * On success it invalidates the customer list, resets the form, toasts, and
 * calls `onCreated` (the page closes the form). Mirrors the encapsulated
 * per-item editor pattern from the RCF glass reference.
 */
export function useCreateCustomer(onCreated: () => void): UseCreateCustomerResult {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const [form, setForm] = useState<CreateFormState>(INITIAL_CREATE);

  const updateField = useCallback(
    <K extends keyof CreateFormState>(key: K, value: CreateFormState[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const reset = useCallback(() => setForm(INITIAL_CREATE), []);

  const mutation = useMutation({
    mutationFn: () =>
      createCustomer({
        name: form.name.trim(),
        account_type: form.account_type,
        traffic_grade: form.traffic_grade,
        credit_limit: parseFloat(form.credit_limit) || 0,
        daily_limit: parseFloat(form.daily_limit) || 0,
        cpm_limit: parseInt(form.cpm_limit, 10) || 0,
        // Only send ucaas_enabled for account types where it's meaningful
        ...(form.account_type !== 'rcf' && form.account_type !== 'ucaas'
          ? { ucaas_enabled: form.ucaas_enabled }
          : {}),
        // Voicemail is account-type-orthogonal — always send it
        voicemail_enabled: form.voicemail_enabled,
      }),
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: ['customers'] });
      setForm(INITIAL_CREATE);
      onCreated();
      toastOk(`Customer "${created.name}" created`);
    },
    onError: (err: Error) => toastErr(err.message),
  });

  const submit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!form.name.trim()) {
        toastErr('Name is required');
        return;
      }
      mutation.mutate();
    },
    [form.name, mutation, toastErr],
  );

  return { form, isPending: mutation.isPending, updateField, submit, reset };
}
