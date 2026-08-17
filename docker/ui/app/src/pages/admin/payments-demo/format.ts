/**
 * Machine Payments Demo — tiny shared formatting helpers.
 *
 * Money on this page is dollars with up to 4-dp precision (micro-charges are
 * sub-cent); these keep whole-dollar figures clean while letting micro
 * amounts show their real precision.
 */

import type { LedgerEntryType, PaymentSource } from './types';

/** $1,234.56 — standard two-decimal dollars. */
export function fmtDollars(v: number): string {
  return v.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Micro amounts: $0.01 stays $0.01, $0.0075 keeps its 4-dp tail. */
export function fmtMicro(v: number): string {
  const abs = Math.abs(v);
  const decimals = abs > 0 && abs < 0.01 ? 4 : 2;
  return v.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: decimals,
  });
}

/** Signed ledger amount: +$100.00 / −$4.40 (micro precision preserved). */
export function fmtSigned(v: number): string {
  const body = fmtMicro(Math.abs(v));
  return v >= 0 ? `+${body}` : `−${body}`;
}

/** Short local date-time for table rows: "Aug 15, 10:07 AM". */
export function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Truncate a provider ref / tx hash for display: 0x2a80…7823. */
export function fmtRef(ref: string): string {
  return ref.length > 18 ? `${ref.slice(0, 10)}…${ref.slice(-4)}` : ref;
}

// ── Rail + entry-type presentation (one consistent semantic set) ─────────────

export const RAIL_LABEL: Record<PaymentSource, string> = {
  stripe_card: 'Card',
  stripe_crypto: 'USDC',
  stripe_mpp: 'Agent tab',
  x402: 'x402',
  admin: 'Manual',
  rating: 'Call rating',
};

/** Page-scoped rail tag class (see dl-payments.css palette note). */
export const RAIL_CLASS: Record<PaymentSource, string> = {
  stripe_card: 'dlx9-rail dlx9-rail-card',
  stripe_crypto: 'dlx9-rail dlx9-rail-crypto',
  stripe_mpp: 'dlx9-rail dlx9-rail-mpp',
  x402: 'dlx9-rail dlx9-rail-x402',
  admin: 'dlx9-rail dlx9-rail-slate',
  rating: 'dlx9-rail dlx9-rail-slate',
};

export const ENTRY_LABEL: Record<LedgerEntryType, string> = {
  topup: 'Top-up',
  usage: 'Usage',
  fee: 'Fee',
  refund: 'Refund',
  adjustment: 'Adjustment',
  promo: 'Promo',
  chargeback: 'Chargeback',
};

export function railLabel(source: PaymentSource | string): string {
  return RAIL_LABEL[source as PaymentSource] ?? source;
}

export function railClass(source: PaymentSource | string): string {
  return RAIL_CLASS[source as PaymentSource] ?? 'dlx9-rail dlx9-rail-slate';
}
