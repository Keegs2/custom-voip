/**
 * Local, feature-scoped types for the customer Billing & Payments page. Global
 * payment types (BillingBalance, LedgerEntry, PaymentMethod, …) live in
 * `src/types/payments.ts`; only page-local unions/consts belong here.
 */

/**
 * Add-funds modal rail. The UI presents "card" and "stablecoin"; the stablecoin
 * option maps to the backend's `usdc` rail on submit (see AddFundsModal).
 */
export type AddFundsRail = 'card' | 'stablecoin';

/** How many ledger rows the page requests / renders. */
export const LEDGER_LIMIT = 40;

/** Preset top-up amounts (dollars) offered as quick chips. */
export const TOPUP_PRESETS = [25, 50, 100, 250] as const;
