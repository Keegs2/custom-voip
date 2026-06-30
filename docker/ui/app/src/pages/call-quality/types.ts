/**
 * Local types + constants for the Call Quality feature folder.
 *
 * Page-global CDR/customer/trunk types still come from `src/types/*`. Only the
 * unions/shapes used purely within this feature live here.
 */

import type { CallDirection, ProductType } from '../../types/cdr';

// ── CDR table sort ───────────────────────────────────────────────────────────

export type SortKey =
  | 'start_time'
  | 'duration_seconds'
  | 'mos'
  | 'packet_loss_pct'
  | 'jitter_avg_ms'
  | 'r_factor';

export interface SortState {
  key: SortKey;
  dir: 'asc' | 'desc';
}

/** Page size for the CDR table pagination. */
export const TABLE_PAGE_SIZE = 50;

// ── Filter bar ───────────────────────────────────────────────────────────────

export interface FilterState {
  customerId: number | null;
  trunkId: number | null;
  numberSearch: string;
  direction: CallDirection | 'all';
  startDate: string;
  endDate: string;
  productType: ProductType | 'all';
}

// ── Charts ───────────────────────────────────────────────────────────────────

export interface TrendPoint {
  date: string;
  label: string;
  value: number | null;
}

export interface DailyQuality {
  date: string;
  label: string;
  avgMos: number | null;
  avgPacketLossPct: number | null;
  avgJitterMs: number | null;
}

// ── Overview stats ───────────────────────────────────────────────────────────

export interface OverviewStats {
  totalCalls: number;
  answeredCalls: number;
  asr: number;
  avgMos: number | null;
  avgPacketLossPct: number | null;
  avgJitterMs: number | null;
  avgRFactor: number | null;
}

// ── Pill selector ────────────────────────────────────────────────────────────

export interface PillOption<T extends string> {
  value: T;
  label: string;
}
