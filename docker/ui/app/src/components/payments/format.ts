/**
 * Money parsing + formatting helpers for the payments surfaces.
 *
 * MONEY REPRESENTATION (the REAL backend contract)
 * ------------------------------------------------
 * The backend ledger is DECIMAL(12,4) dollars and serializes every money field
 * as a decimal DOLLAR value — e.g. `"100.0000"`, `"0.0075"`, `"-2.5000"`. There
 * are NO integer "minor units" and no `_minor` suffixes on money fields (only the
 * on-chain USDC `amount_minor` on x402 settlements is a true integer, and that is
 * kept separate). Depending on the deployed FastAPI serializer a `Decimal` can
 * arrive as a JSON string (`"0.0075"`, Pydantic-v2 core) or a JSON number
 * (`0.0075`, `jsonable_encoder`); `parseMoney` tolerates BOTH and always yields a
 * full-precision JS number.
 *
 * CRITICAL: we parse to a number for display/animation but PRESERVE full 4-dp
 * precision — we never round to cents. The x402/MPP micro-charges are sub-cent
 * (`"0.0075"`), so rounding to 2dp would render `$0.00` and kill the
 * machine-payments story. `fmtMicro` shows up to 4dp for sub-cent magnitudes.
 */

import { fmtMoney } from '../../utils/format';
import { GLASS } from '../glass/glass';
import type { PaymentRail, PaymentSource } from '../../types/payments';

/** A money value on the wire: a decimal dollar STRING (`"100.0000"`), or a number. */
export type MoneyInput = string | number | null | undefined;

/**
 * Parse a backend money value (decimal dollar string OR number) into a
 * full-precision JS number of DOLLARS. Never rounds. Returns `fallback` (0 by
 * default) for null/undefined/unparseable input so the UI degrades instead of
 * rendering `NaN`.
 *
 * Examples: `"100.0000"` → 100, `"0.0075"` → 0.0075, `-2.5` → -2.5, `null` → 0.
 */
export function parseMoney(value: MoneyInput, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Format a dollar number as USD, e.g. `-12.5` → "-$12.50". */
export function fmtDollars(dollars: number, decimals = 2): string {
  return fmtMoney(dollars, decimals);
}

/**
 * Format a signed dollar amount with an explicit +/- and a semantic colour, for
 * ledger rows (credits green, debits muted-red). Returns the display string and
 * whether it is a credit so a row can render both consistently. Sub-cent
 * magnitudes keep 4dp so a `+$0.0075` micro-credit stays legible.
 */
export function signedDollars(dollars: number): { text: string; positive: boolean } {
  const positive = dollars >= 0;
  const abs = Math.abs(dollars);
  const decimals = abs > 0 && abs < 0.01 ? 4 : 2;
  const magnitude = fmtMoney(abs, decimals);
  return { text: `${positive ? '+' : '−'}${magnitude}`, positive };
}

/**
 * Sub-cent aware formatter for machine micro-charges (x402/MPP tick prices are
 * fractions of a cent). Shows up to 4 decimals so a $0.0075 charge is legible,
 * falling back to 2dp for whole-cent and larger amounts.
 */
export function fmtMicro(dollars: number): string {
  if (dollars !== 0 && Math.abs(dollars) < 0.01) return fmtMoney(dollars, 4);
  return fmtMoney(dollars, 2);
}

/** The three rails, each with a label + accent used everywhere they appear. */
export const RAIL_META: Record<PaymentRail, { label: string; short: string; color: string }> = {
  card: { label: 'Card (Stripe)', short: 'Card', color: GLASS.accent },
  stablecoin: { label: 'Stablecoin (USDC)', short: 'Stablecoin', color: GLASS.accentSecondary },
  machine: { label: 'Machine (x402 / MPP)', short: 'Machine', color: '#a78bfa' },
};

/**
 * Map a backend ledger `source` (the key on revenue-by-rail / usage-by-source)
 * to one of the three UI rail buckets, so any source can borrow the rail palette.
 *   • stripe_card                 → card
 *   • stripe_crypto               → stablecoin (Stripe USDC top-up)
 *   • x402, stripe_mpp            → machine
 *   • admin, rating, unknown      → card (neutral blue)
 */
export function sourceToRail(source: PaymentSource | string): PaymentRail {
  switch (source) {
    case 'stripe_crypto':
      return 'stablecoin';
    case 'x402':
    case 'stripe_mpp':
      return 'machine';
    default:
      return 'card';
  }
}

/** Convenience: the rail palette entry for a backend source. */
export function sourceMeta(source: PaymentSource | string): { label: string; short: string; color: string } {
  return RAIL_META[sourceToRail(source)];
}
