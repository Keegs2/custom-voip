/**
 * usePreviewCustomers — the customer list an admin picks from in "View as
 * Customer" mode, plus the one-time default pick.
 *
 * Same query key + fetcher as the admin RCF console's scope selector
 * (['customers-dropdown'], GET /customers?limit=500), so React Query shares
 * the request. Only runs for a real admin in customer view.
 */
import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listCustomers } from '../../api/customers';
import { useAuth, type EffectiveCustomer } from '../../contexts/AuthContext';
import type { Customer } from '../../types/customer';

/** Account types that have the customer dashboard's live product (RCF). */
const DASHBOARD_TYPES: ReadonlyArray<Customer['account_type']> = ['rcf', 'hybrid'];

export function toEffectiveCustomer(c: Customer): EffectiveCustomer {
  return { id: c.id, name: c.name, account_type: c.account_type };
}

export function usePreviewCustomers() {
  const { isActualAdmin, customerViewMode, previewCustomer, setPreviewCustomer, user } = useAuth();
  const active = isActualAdmin && customerViewMode;

  const query = useQuery({
    queryKey: ['customers-dropdown'],
    queryFn: () => listCustomers({ limit: 500 }),
    enabled: active,
    staleTime: 60_000,
  });

  const customers = useMemo(
    () => [...(query.data?.items ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [query.data],
  );

  // Entering customer view with nothing picked: preview the admin's own
  // account if they have one, else the first RCF/hybrid customer by name, so
  // the Dashboard and RCF are populated straight away.
  const ownCustomerId = user?.customer_id ?? null;
  useEffect(() => {
    if (!active || previewCustomer || customers.length === 0) return;
    const pick =
      customers.find((c) => c.id === ownCustomerId) ??
      customers.find((c) => DASHBOARD_TYPES.includes(c.account_type)) ??
      customers[0];
    setPreviewCustomer(toEffectiveCustomer(pick));
  }, [active, previewCustomer, customers, ownCustomerId, setPreviewCustomer]);

  return { customers, isLoading: query.isLoading, isError: query.isError, active };
}
