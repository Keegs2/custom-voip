/**
 * GET /cdrs/activity — the RCF Call Activity tab's aggregate feed.
 *
 * One request returns the KPI strip AND every chart bucket for the selected
 * range, computed server-side over ALL matching calls (the old tab built its
 * "7-day" chart from the latest 200 CDRs, so busy numbers only ever showed
 * the last day or two).
 *
 * Buckets are FIXED and ZERO-FILLED in the requested IANA time zone:
 *   24h → 24 hourly · 7d → 7 daily · 30d → 30 daily · 90d → ~13 weekly.
 *
 * Voice quality follows the quality.ts honesty rules: shares and a median
 * over GRADED calls only — never an average MOS. Rates are `null` (not 0)
 * when their denominator is 0, so an empty bucket renders as a gap.
 */
import type { ProductType } from './cdr';

export type ActivityRange = '24h' | '7d' | '30d' | '90d';
export type ActivityBucket = 'hour' | 'day' | 'week';

export interface CdrActivityParams {
  range: ActivityRange;
  /** Browser IANA zone (Intl.DateTimeFormat().resolvedOptions().timeZone). */
  tz: string;
  /** Admin scope only — omit for "All Customers" and for tenants (server-scoped). */
  customer_id?: number;
  product_type?: ProductType;
  /** Selected DID (E.164). Omit for all numbers. */
  destination?: string;
}

/** Counters shared by the whole-range KPIs and every bucket. */
interface ActivityCounts {
  calls: number;
  answered: number;
  /** 0–100, null when calls = 0. */
  asr_pct: number | null;
  /** Calls that received a call grade (quality.ts; one-way counts as graded poor). */
  graded: number;
  good_or_better: number;
  /** 0–100, null when graded = 0. */
  good_share_pct: number | null;
  one_way: number;
  /** Median call MOS over graded calls, null when none. */
  median_mos: number | null;
}

export interface CdrActivityKpis extends ActivityCounts {
  poor: number;
  /** STAFF rows only — exact mean talk time of answered calls, seconds. */
  avg_duration_sec?: number | null;
  /** TENANT rows only — mean whole minutes of answered calls (1 decimal). */
  avg_duration_minutes?: number | null;
}

export interface CdrActivityPoint extends ActivityCounts {
  /** ISO 8601 bucket START (offset-aware, in `tz`). */
  t: string;
  missed: number;
}

export interface CdrActivityResponse {
  range: ActivityRange;
  bucket: ActivityBucket;
  tz: string;
  /** ISO 8601 window start (inclusive) — also the Recent Calls table window. */
  start: string;
  /** ISO 8601 window end (exclusive). */
  end: string;
  kpis: CdrActivityKpis;
  points: CdrActivityPoint[];
}
