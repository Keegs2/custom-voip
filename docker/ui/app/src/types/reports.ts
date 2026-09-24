/**
 * Customer Reporting — wire types for the `/reports/*` endpoints.
 *
 * Mirrors docs/CUSTOMER_REPORTING_DESIGN.md 1:1. Every duration is WHOLE
 * minutes computed server-side (never seconds, never rates) and every date is
 * a local calendar date in the requested `tz`. Fields the contract says can
 * be empty (no calls, no rated calls, previous period before retained
 * history) are typed nullable so the UI is forced to handle them.
 */

/** Product a customer number belongs to. */
export type ReportProduct = 'rcf' | 'trunk' | 'api';

/**
 * Quality grade (docs/CALL_QUALITY_ACCURACY_PLAN.md §D, applied to the stored
 * 2-dp E-model MOS): great ≥ 4.34 · good ≥ 4.02 · fair ≥ 3.60 · poor < 3.60 or
 * one-way audio · none = no graded calls. Only answered calls of 5 s or more
 * with measurable audio are graded.
 */
export type QualityGrade = 'great' | 'good' | 'fair' | 'poor' | 'none';

/** Plain-English missed-call reason keys (hangup cause → key, server-side). */
export type MissedReasonKey =
  | 'no_answer'
  | 'caller_hung_up'
  | 'busy'
  | 'not_in_service'
  | 'declined'
  | 'network';

export type CallOutcome = 'answered' | 'missed';
export type CallDirection = 'inbound' | 'outbound';

export type OutcomeFilter = 'all' | CallOutcome;
export type DirectionFilter = 'all' | CallDirection;

/** `YYYY-MM-DD` local calendar date. */
export type IsoDate = string;

/* ─── Common scope (sent on every endpoint) ─────────────────────────────── */

export interface ReportScope {
  /** Inclusive local start date in `tz`. */
  start: IsoDate;
  /** Inclusive local end date in `tz` (≥ start, span ≤ 366 days). */
  end: IsoDate;
  /** IANA timezone name — the browser's own zone. */
  tz: string;
  /** Restrict to these of the customer's own numbers; empty = all numbers. */
  numbers: string[];
  /** Staff only — tenants never send it (the API ignores it for them anyway). */
  customer_id?: number;
}

/* ─── GET /reports/overview ─────────────────────────────────────────────── */

export interface ReportPeriod {
  start: IsoDate;
  end: IsoDate;
  tz: string;
  days: number;
}

export interface ReportTotals {
  calls: number;
  inbound: number;
  outbound: number;
  answered: number;
  missed: number;
  /** null when there were no calls (nothing to divide by). */
  answer_rate_pct: number | null;
  minutes: number;
  /** Average whole-minute length of answered calls; null when none answered. */
  avg_minutes: number | null;
}

/** Same number of days immediately before `start`; fields null before retained history. */
export interface ReportPreviousPeriod {
  start: IsoDate;
  end: IsoDate;
  calls: number | null;
  answered: number | null;
  minutes: number | null;
  answer_rate_pct: number | null;
}

export interface ReportQuality {
  rated_calls: number;
  avg_mos: number | null;
  grade: QualityGrade;
  pct_good_or_better: number | null;
}

export interface BusiestDay {
  date: IsoDate;
  calls: number;
}

export interface BusiestHour {
  /** 0–23, hour of day in `tz`. */
  hour: number;
  /** Total calls started in that hour-of-day across the whole period. */
  calls: number;
}

export interface MissedReason {
  key: MissedReasonKey;
  label: string;
  calls: number;
}

export interface ReportOverview {
  period: ReportPeriod;
  /** Local date of the customer's oldest retained call, or null if none. */
  data_available_from: IsoDate | null;
  totals: ReportTotals;
  previous_period: ReportPreviousPeriod | null;
  quality: ReportQuality;
  busiest_day: BusiestDay | null;
  busiest_hour: BusiestHour | null;
  missed_reasons: MissedReason[];
}

/* ─── GET /reports/trend ────────────────────────────────────────────────── */

export type TrendBucket = 'day' | 'week' | 'month';

export interface ReportTrendPoint {
  /** Bucket start (weeks start Monday; months on the 1st). */
  date: IsoDate;
  calls: number;
  answered: number;
  missed: number;
  minutes: number;
}

export interface ReportTrend {
  bucket: TrendBucket;
  /** Every bucket in range, zero-filled. */
  points: ReportTrendPoint[];
}

/* ─── GET /reports/numbers ──────────────────────────────────────────────── */

export interface ReportNumberRow {
  number: string;
  name: string | null;
  product: ReportProduct;
  /** CURRENT forwarding target — rcf only, else null. */
  forwards_to: string | null;
  calls: number;
  answered: number;
  missed: number;
  answer_rate_pct: number | null;
  minutes: number;
  avg_mos: number | null;
  grade: QualityGrade;
}

export interface ReportNumbers {
  numbers: ReportNumberRow[];
}

/* ─── GET /reports/calls ────────────────────────────────────────────────── */

export interface ReportCallsParams {
  outcome: OutcomeFilter;
  direction: DirectionFilter;
  /** ≤ 500. */
  limit: number;
  offset: number;
}

export interface ReportCallRow {
  id: string;
  /** ISO 8601 with the `tz` offset, start time only. */
  started_at: string;
  direction: CallDirection;
  from: string;
  to: string;
  /** The customer's own number on this call. */
  number: string;
  outcome: CallOutcome;
  outcome_label: string;
  missed_reason: MissedReasonKey | null;
  /** 0 for missed calls, ≥ 1 for any answered call. */
  length_minutes: number;
  /** null when the call has no quality reading. */
  quality: QualityGrade | null;
}

export interface ReportCalls {
  total: number;
  calls: ReportCallRow[];
}

/* ─── GET /reports/my-numbers ───────────────────────────────────────────── */

export interface MyNumber {
  number: string;
  name: string | null;
  product: ReportProduct;
}

export interface MyNumbers {
  numbers: MyNumber[];
}

/* ─── GET /reports/calls.csv ────────────────────────────────────────────── */

export interface ReportCsvDownload {
  blob: Blob;
  filename: string;
  /** Server hit its row cap (`X-Report-Truncated: true`). */
  truncated: boolean;
}
