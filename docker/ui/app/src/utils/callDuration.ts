/**
 * callDuration.ts — ONE place that reads a CDR's duration, for both row shapes.
 *
 * The API returns two CDR shapes (see types/cdr.ts + API
 * services/tenant_redaction.py):
 *  - STAFF rows carry exact `duration_seconds`.
 *  - TENANT rows carry only `duration_minutes` (whole minutes; 0 = no talk
 *    time, ≥1 for any answered call). Customers never see seconds.
 *
 * Callers decide by FIELD PRESENCE, not by role, so an admin in
 * customer-view mode (who still receives staff rows) and a real tenant both
 * render correctly, and nothing ever shows a misleading "0s".
 */
import type { Cdr } from '../types/cdr';

type DurationFields = Pick<Cdr, 'duration_seconds' | 'duration_minutes'>;

/** True when the row carries exact seconds (staff shape). */
export function hasExactDuration(cdr: DurationFields): boolean {
  return typeof cdr.duration_seconds === 'number';
}

/** True when the call has any talk time, whichever shape the row is. */
export function hasTalkTime(cdr: DurationFields): boolean {
  if (hasExactDuration(cdr)) return (cdr.duration_seconds ?? 0) > 0;
  return (cdr.duration_minutes ?? 0) > 0;
}

/** Whole-minute label for tenant rows: "—" for none, else "N min". */
export function fmtMinutes(minutes: number | null | undefined): string {
  if (minutes == null || minutes <= 0) return '—';
  return `${minutes.toLocaleString()} min`;
}

/** Average in minutes, 1 decimal ("2.3 min"). */
export function fmtAvgMinutes(avgMinutes: number | null | undefined): string {
  if (avgMinutes == null || avgMinutes <= 0) return '—';
  return `${avgMinutes.toFixed(1)} min`;
}

/**
 * Display a row's duration: exact via `fmtExact` for staff rows, whole
 * minutes for tenant rows.
 */
export function fmtCallDuration(cdr: DurationFields, fmtExact: (sec: number) => string): string {
  if (hasExactDuration(cdr)) return fmtExact(cdr.duration_seconds ?? 0);
  return fmtMinutes(cdr.duration_minutes);
}

/**
 * Average duration over a set of rows, formatted. Staff rows average exact
 * seconds (via `fmtExact`); tenant rows average whole minutes (1 decimal).
 * `rows` should already be filtered to the calls that count (e.g. answered).
 */
export function fmtAvgCallDuration(
  rows: DurationFields[],
  fmtExact: (sec: number) => string,
): string {
  if (rows.length === 0) return '—';
  if (rows.every(hasExactDuration)) {
    const sum = rows.reduce((s, r) => s + (r.duration_seconds ?? 0), 0);
    return fmtExact(sum / rows.length);
  }
  const sum = rows.reduce((s, r) => s + (r.duration_minutes ?? 0), 0);
  return fmtAvgMinutes(sum / rows.length);
}
