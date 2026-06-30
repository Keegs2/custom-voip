/**
 * Local types + small constants for the Customer Account (customer 360) feature.
 *
 * Page-global types (Customer, Cdr, CdrSummaryRow) stay in src/types/. Only the
 * feature-local shapes live here.
 */

import { GLASS } from '../../../components/glass/glass';

/** Response from POST /customers/:id/credit?amount= */
export interface AddCreditResponse {
  balance: number;
}

/** Aggregated 30-day usage figures derived from the CDR daily summary. */
export interface UsageSummary {
  totalCalls: number;
  answeredCalls: number;
  asr: number;
  totalMinutes: number;
  avgDurationSec: number;
  totalCost: number;
}

/**
 * Per-account-type accent hue. Mirrors the Sidebar's per-product accent system
 * (RCF green, API purple, trunk amber, UCaaS sky) — a justified local override
 * of the default app blue.
 */
export const ACCOUNT_TYPE_ACCENT: Record<string, string> = {
  rcf: GLASS.success, // #22c55e
  api: '#a855f7',
  trunk: GLASS.warning, // #f59e0b
  hybrid: GLASS.accent, // #3b82f6
  ucaas: '#0ea5e9',
};

export function accountAccent(accountType: string): string {
  return ACCOUNT_TYPE_ACCENT[accountType] ?? GLASS.accent;
}
