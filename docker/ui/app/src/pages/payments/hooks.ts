/**
 * Data + mutation hooks for the customer Billing & Payments page. Reads come
 * from the shared `components/payments/queries.ts` family (so they poll live and
 * co-invalidate with the rest of the demo); this file owns the WRITE side —
 * add card, delete card, top-up, and auto-recharge — each invalidating the
 * payments family so the balance/ledger/methods visibly update.
 *
 * React #310: these are plain custom hooks; every hook they call is
 * unconditional at the top.
 */

import { useMutation } from '@tanstack/react-query';
import { useToast } from '../../components/ui/useToast';
import { usePaymentsInvalidate } from '../../components/payments/queries';
import {
  createPaymentMethod,
  createSetupIntent,
  deletePaymentMethod,
  topup,
  updateAutoRecharge,
} from '../../api/payments';
import type {
  AutoRechargeUpdate,
  CreatePaymentMethodRequest,
  TopupRequest,
} from '../../types/payments';

/**
 * Add a (demo) card the way the real SAQ-A flow does:
 *   1. POST /setup-intent — the (simulated) Stripe Payment Element mints a
 *      `pm_…` token + provider_customer_id + brand/last4. WE never see a PAN.
 *   2. POST /methods — persist that token + display metadata (never card digits).
 * The chosen test-card brand drives which card the backend mints, and the card's
 * own last4/expiry come back from the provider (authoritative), so the saved card
 * renders exactly what the backend stored.
 */
export function useAddCard(onDone?: () => void) {
  const invalidate = usePaymentsInvalidate();
  const { toastOk, toastErr } = useToast();

  return useMutation({
    mutationFn: async (input: { brand: string; make_default: boolean }) => {
      const intent = await createSetupIntent(input.brand.toLowerCase());
      const body: CreatePaymentMethodRequest = {
        provider_pm_id: intent.payment_method ?? undefined,
        provider_customer_id: intent.provider_customer_id,
        brand: intent.brand ?? input.brand.toLowerCase(),
        last4: intent.last4 ?? undefined,
        exp_month: intent.exp_month ?? undefined,
        exp_year: intent.exp_year ?? undefined,
        make_default: input.make_default,
        client_secret: intent.client_secret,
      };
      return createPaymentMethod(body);
    },
    onSuccess: async () => {
      toastOk('Demo card added');
      await invalidate();
      onDone?.();
    },
    onError: (err: Error) => toastErr(err.message || 'Could not add card'),
  });
}

export function useDeleteCard() {
  const invalidate = usePaymentsInvalidate();
  const { toastOk, toastErr } = useToast();

  return useMutation({
    mutationFn: (id: number | string) => deletePaymentMethod(id),
    onSuccess: async () => {
      toastOk('Card removed');
      await invalidate();
    },
    onError: (err: Error) => toastErr(err.message || 'Could not remove card'),
  });
}

export function useTopup(onDone?: () => void) {
  const invalidate = usePaymentsInvalidate();
  const { toastOk, toastErr } = useToast();

  return useMutation({
    mutationFn: (body: TopupRequest) => topup(body),
    onSuccess: async () => {
      toastOk('Funds added');
      await invalidate();
      onDone?.();
    },
    onError: (err: Error) => toastErr(err.message || 'Top-up failed'),
  });
}

export function useUpdateAutoRecharge() {
  const invalidate = usePaymentsInvalidate();
  const { toastOk, toastErr } = useToast();

  return useMutation({
    mutationFn: (body: AutoRechargeUpdate) => updateAutoRecharge(body),
    onSuccess: async () => {
      toastOk('Auto-recharge updated');
      await invalidate();
    },
    onError: (err: Error) => toastErr(err.message || 'Could not update auto-recharge'),
  });
}
