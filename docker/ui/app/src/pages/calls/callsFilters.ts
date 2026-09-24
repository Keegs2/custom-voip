/**
 * callsFilters — filter state, validation, and the filters→query-params
 * serialization for the merged Calls & Quality page (/cdrs + /call-quality).
 *
 * Evolved from pages/admin/cdrFilters.ts (the CDR Search filter module) with
 * one addition: `trunk_id` — a server-declared param on GET /cdrs that the
 * old page never exposed. filtersToParams() remains the ONE place the picker
 * state becomes wire params — Records, Summary, CSV export, and the quality
 * trend charts all consume its output.
 *
 * PINNED API CONTRACT (GET /v1/cdrs — routers/cdrs.py query_cdrs): the
 * endpoint declares ONLY customer_id, trunk_id, product_type, direction,
 * destination (prefix), sbc_id, zone, start_date, end_date, rated_only,
 * leg + call_id (staff-only row model / single-call filter), limit,
 * offset. FastAPI silently drops anything else — do not add params here
 * without adding them to the router first. (`call_id` is declared on
 * /v1/cdrs only; /cdrs/summary ignores it — the Summary tab says so.)
 *
 * Quality trends deliberately DROP `leg` (see QualityTrendsSection): quality
 * is a one-row-per-call surface per the leg-split contract.
 */
import type {
  CdrSearchParams, ProductType, CallDirection, CdrZone, CdrRowsMode,
} from '../../types/cdr';

/* ── Range presets ───────────────────────────────────────────────────── */

export type CdrRangePreset = '1h' | '24h' | '7d' | '30d' | 'custom';

export const PRESET_LABELS: Record<Exclude<CdrRangePreset, 'custom'>, string> = {
  '1h': 'Last hour',
  '24h': 'Last 24h',
  '7d': 'Last 7d',
  '30d': 'Last 30d',
};

const PRESET_MS: Record<Exclude<CdrRangePreset, 'custom'>, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

/** Concrete range for a relative preset, anchored at `now`. */
export function presetRange(
  preset: Exclude<CdrRangePreset, 'custom'>,
  now: Date,
): { start: Date; end: Date } {
  return { start: new Date(now.getTime() - PRESET_MS[preset]), end: now };
}

/** Renders a Date as a `datetime-local` input value in the BROWSER'S LOCAL tz. */
export function toDatetimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/* ── Row model (staff only — docs/CDR_LEG_SPLIT_CONTRACT.md) ─────────── */

/** Segmented-control order + labels for the staff "Rows" filter. */
export const ROWS_MODE_OPTIONS: ReadonlyArray<{ id: CdrRowsMode; label: string; title: string }> = [
  { id: 'calls', label: 'Calls', title: 'One row per call (default)' },
  { id: 'all', label: 'All legs', title: 'Call rows plus every carrier bridge attempt (B-leg)' },
  { id: 'b', label: 'Carrier legs', title: 'Carrier bridge attempts (B-legs) only' },
];

/** Staff note per row model — what counts / totals actually count. Shared
    by the KPI strip and the Summary tab so the wording can never drift. */
export const ROWS_MODE_NOTE: Record<CdrRowsMode, string> = {
  calls: 'Figures are per call — one row per call (carrier legs folded in).',
  all: 'Counting every carrier leg — totals are not call counts.',
  b: 'Carrier legs only — figures are per bridge attempt, not per call.',
};

/** The row model a committed search was made with ('calls' when omitted). */
export function rowsModeOf(params: CdrSearchParams): CdrRowsMode {
  return params.leg ?? 'calls';
}

/* ── Filter state ────────────────────────────────────────────────────── */

export interface CallsFilters {
  customer_id: string;
  /** '' = all trunks, else a trunk id (sent as the server's `trunk_id`). */
  trunk_id: string;
  product_type: string;
  direction: string;
  /** '' = all zones, else east | west | central. */
  zone: string;
  range_preset: CdrRangePreset;
  /** Local wall-clock datetime-local values — authoritative only when range_preset === 'custom'. */
  start_local: string;
  end_local: string;
  destination: string;
  rated_only: boolean;
  /** Staff-only row model. Tenants never see the control, so it stays 'calls'. */
  rows: CdrRowsMode;
  /** Staff-only single-call filter ('' = none). Set by the call-detail
      modal's "Show all legs of this call"; shown as a clearable chip. */
  call_id: string;
}

export function defaultCallsFilters(): CallsFilters {
  // Seed the custom pickers with the default preset's window so switching to
  // Custom always starts from something sensible.
  const { start, end } = presetRange('24h', new Date());
  return {
    customer_id: '',
    trunk_id: '',
    product_type: '',
    direction: '',
    zone: '',
    range_preset: '24h',
    start_local: toDatetimeLocal(start),
    end_local: toDatetimeLocal(end),
    destination: '',
    rated_only: false,
    rows: 'calls',
    call_id: '',
  };
}

/**
 * Validate the filter set. Returns a user-facing error string, or null when
 * the filters are searchable. Only the custom range can be invalid.
 */
export function validateCallsFilters(filters: CallsFilters): string | null {
  if (filters.range_preset !== 'custom') return null;
  if (!filters.start_local || !filters.end_local) {
    return 'Custom range requires both a start and an end date/time.';
  }
  const start = new Date(filters.start_local);
  const end = new Date(filters.end_local);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return 'Enter a valid start and end date/time.';
  }
  if (start.getTime() > end.getTime()) {
    return 'Start must be before end.';
  }
  return null;
}

/**
 * Serialize the filter UI state to the API's query params. Called ONCE per
 * Search click (commit time) so:
 * - relative presets resolve to concrete instants at that moment, and
 * - page navigation reuses the exact same frozen window (consistent offsets).
 *
 * TIMEZONE HANDLING: `<input type="datetime-local">` yields a wall-clock
 * string with no timezone (e.g. "2026-08-04T09:30"). Per ECMA-262,
 * `new Date()` on a date-time form WITHOUT an offset interprets it in the
 * browser's LOCAL timezone; `.toISOString()` then converts that instant to
 * UTC with a trailing "Z" — the ISO 8601 UTC form the API's `start_date` /
 * `end_date` params expect. So the operator thinks in local time and the
 * wire always carries unambiguous UTC.
 *
 * Callers must validateCallsFilters() first — an invalid custom range here
 * falls back to the last-24h window rather than sending garbage.
 */
export function filtersToParams(filters: CallsFilters): CdrSearchParams {
  let start: Date;
  let end: Date;
  if (filters.range_preset === 'custom' && validateCallsFilters(filters) === null) {
    start = new Date(filters.start_local); // local wall-clock → Date instant
    end = new Date(filters.end_local);
  } else {
    const preset = filters.range_preset === 'custom' ? '24h' : filters.range_preset;
    ({ start, end } = presetRange(preset, new Date()));
  }

  const params: CdrSearchParams = {
    start_date: start.toISOString(), // → UTC "Z" instant
    end_date: end.toISOString(),
  };
  if (filters.customer_id) params.customer_id = Number(filters.customer_id);
  if (filters.trunk_id) params.trunk_id = Number(filters.trunk_id);
  if (filters.product_type) params.product_type = filters.product_type as ProductType;
  if (filters.direction) params.direction = filters.direction as CallDirection;
  if (filters.zone) params.zone = filters.zone as CdrZone;
  if (filters.destination) params.destination = filters.destination;
  if (filters.rated_only) params.rated_only = true;
  // 'calls' is the server default — omitted, so tenant params (always
  // 'calls') are unchanged and the react-query keys stay identical.
  if (filters.rows !== 'calls') params.leg = filters.rows;
  const callId = filters.call_id.trim();
  if (callId) params.call_id = callId;
  return params;
}
