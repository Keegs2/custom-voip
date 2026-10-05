/**
 * activityFormat.ts — range presets + date/number formatting for the RCF
 * Call Activity tab. Pure functions only (no React), so the chart, KPI strip
 * and table all label time the same way.
 *
 * Every chart label formats in the RESPONSE's `tz` (the zone the server
 * bucketed in — the browser zone we sent), so a bucket that starts at local
 * midnight is always labelled with that local day, never its UTC neighbour.
 */
import type { ActivityBucket, ActivityRange } from '../../types/cdrActivity';
import type { RcfEntry } from '../../types/rcf';
import { fmt } from '../../utils/format';

// ─── Range presets ───────────────────────────────────────────────────────────

export interface RangePreset {
  id: ActivityRange;
  /** Segmented-control label. */
  short: string;
  /** Chart / section title. */
  title: string;
  /** Lower-case phrase for sentences: "No calls in the last 7 days". */
  phrase: string;
  /** Window length — only used for the client-side fallback window. */
  ms: number;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export const RANGE_PRESETS: readonly RangePreset[] = [
  { id: '24h', short: '24h', title: 'Last 24 hours', phrase: 'the last 24 hours', ms: DAY_MS },
  { id: '7d',  short: '7d',  title: 'Last 7 days',   phrase: 'the last 7 days',   ms: 7 * DAY_MS },
  { id: '30d', short: '30d', title: 'Last 30 days',  phrase: 'the last 30 days',  ms: 30 * DAY_MS },
  { id: '90d', short: '90d', title: 'Last 90 days',  phrase: 'the last 90 days',  ms: 90 * DAY_MS },
];

export const DEFAULT_RANGE: ActivityRange = '7d';

export function rangePreset(id: ActivityRange): RangePreset {
  return RANGE_PRESETS.find((r) => r.id === id) ?? RANGE_PRESETS[1];
}

/**
 * Fallback table window when /cdrs/activity is unavailable: a rolling
 * [now − range, now]. The normal path uses the activity response's
 * `start`/`end` so the table and chart cover the exact same calls.
 */
export function fallbackWindow(range: ActivityRange, nowMs: number): { start: string; end: string } {
  return { start: new Date(nowMs - rangePreset(range).ms).toISOString(), end: new Date(nowMs).toISOString() };
}

/** The viewer's IANA zone, e.g. "America/New_York" (UTC if unavailable). */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// ─── Formatter cache — Intl constructors are not free at 100 rows × render ───

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function dtf(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(options);
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(undefined, options);
    fmtCache.set(key, f);
  }
  return f;
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((p) => p.type === type)?.value ?? '';
}

// ─── Chart labels ────────────────────────────────────────────────────────────

/**
 * X-axis tick for one bucket start.
 *   hour → "3 PM" · day → "Mon 9/28" · week → "Sep 14"
 */
export function bucketTick(bucket: ActivityBucket, iso: string, tz: string): string {
  const d = new Date(iso);
  switch (bucket) {
    case 'hour':
      return dtf({ hour: 'numeric', timeZone: tz }).format(d);
    case 'day': {
      const parts = dtf({ weekday: 'short', month: 'numeric', day: 'numeric', timeZone: tz }).formatToParts(d);
      return `${part(parts, 'weekday')} ${part(parts, 'month')}/${part(parts, 'day')}`;
    }
    case 'week':
      return dtf({ month: 'short', day: 'numeric', timeZone: tz }).format(d);
  }
}

/**
 * Tooltip heading — the bucket's full datetime range.
 *   hour → "Wed, Sep 30, 2:00 – 3:00 PM"
 *   day  → "Mon, Sep 28, 2026"
 *   week → "Sep 14 – 20, 2026"
 * `endIso` is the NEXT bucket's start (exclusive end).
 */
export function bucketRangeLabel(bucket: ActivityBucket, startIso: string, endIso: string, tz: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  switch (bucket) {
    case 'hour':
      return dtf({ weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz })
        .formatRange(start, end);
    case 'day':
      return dtf({ weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: tz }).format(start);
    case 'week': {
      // Inclusive last day of the week = exclusive end − 1 ms.
      const lastDay = new Date(Math.max(start.getTime(), end.getTime() - 1));
      return dtf({ month: 'short', day: 'numeric', year: 'numeric', timeZone: tz }).formatRange(start, lastDay);
    }
  }
}

/**
 * How many buckets apart to place x labels so they never collide: the
 * smallest "natural" step (every 3 hours, every 7 days, …) whose labels fit
 * the plot width at the bucket's typical label width.
 */
export function tickStep(bucket: ActivityBucket, count: number, plotWidth: number): number {
  const labelPx = bucket === 'hour' ? 46 : bucket === 'day' ? 72 : 58;
  const fit = Math.max(1, Math.floor(plotWidth / labelPx));
  const raw = Math.ceil(count / fit);
  const steps = bucket === 'hour' ? [1, 2, 3, 4, 6, 8, 12] : bucket === 'day' ? [1, 2, 3, 5, 7, 10, 14] : [1, 2, 3, 4, 6];
  return steps.find((s) => s >= raw) ?? raw;
}

// ─── Table datetime ──────────────────────────────────────────────────────────

/**
 * Absolute call start, seconds included — customers match these against
 * their own records. `tz` is the zone the activity panel actually used
 * (the viewer's, or UTC after a server tz rejection); omitted → the
 * browser's zone.
 *   → "Sep 30, 2026, 2:14:07 PM"
 */
export function fmtCallDateTime(iso: string, tz?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return dtf({
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: tz,
  }).format(d);
}

/** Short zone name for an instant in `tz` (default: the viewer's zone) — "EDT", "GMT-5", "UTC". */
export function tzAbbrev(iso: string, tz?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return part(dtf({ timeZoneName: 'short', hour: 'numeric', timeZone: tz }).formatToParts(d), 'timeZoneName');
}

// ─── Numbers ─────────────────────────────────────────────────────────────────

/** "97.4%" (one decimal) or "—" for null. */
export function fmtPct1(pct: number | null | undefined): string {
  return pct == null ? '—' : `${pct.toFixed(1)}%`;
}

/**
 * Good-or-better share, floored to a whole percent (never rounds 99.6 up to
 * a "perfect" 100% that one bad call contradicts) — same as the old tile.
 */
export function fmtShareFloor(pct: number | null | undefined): string {
  return pct == null ? '—' : `${Math.floor(pct)}%`;
}

/** Staff average talk time, exact: "7m 9s" / "42s". */
export function fmtAcdExact(sec: number): string {
  // Round once so 7m 59.6s reads "8m 0s", never "7m 60s".
  const whole = Math.round(sec);
  return whole >= 60 ? `${Math.floor(whole / 60)}m ${whole % 60}s` : `${whole}s`;
}

export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** "+1 (617) 454-4217 — Boston office" for a DID, or null when not in the list. */
export function didLabel(entries: readonly RcfEntry[], did: string | null): string | null {
  const entry = did ? entries.find((e) => e.did === did) : undefined;
  return entry ? `${fmt(entry.did)}${entry.name ? ` — ${entry.name}` : ''}` : null;
}
