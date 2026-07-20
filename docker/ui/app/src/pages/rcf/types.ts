/**
 * Local types + consts for the production RCF page (`/rcf`).
 *
 * Page-global data types (RcfEntry, DidInventoryItem, Cdr) come from
 * `src/types/`. Only feature-local unions / tuning constants live here.
 */

export type SortField = 'did' | 'name' | 'forward_to' | 'customer' | 'status';
export type SortDir = 'asc' | 'desc';

/** The three top-level dashboard tabs on the RCF page. */
export type DashboardTab = 'numbers' | 'activity' | 'dids';

export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;

/** The DID inventory filter state (My Numbers + Available Numbers). */
export interface DidFilterState {
  npa: string;
  nxx: string;
  state: string;
  search: string;
}

/** One day's aggregated call-quality summary for the 7-day activity chart. */
export interface DailyStats {
  date: string; // YYYY-MM-DD
  label: string; // "Mon, Apr 28"
  shortLabel: string; // "Mon"
  total: number;
  answered: number;
  asr: number | null; // 0–100, null if no calls
  avgMos: number | null; // 1.0–5.0, null if no MOS data
}
