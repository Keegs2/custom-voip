/**
 * Pure formatting + date helpers for the Reporting page (and its PDF).
 *
 * Plain-language rules (docs/CUSTOMER_REPORTING_DESIGN.md "Hard rules"):
 * every length is WHOLE minutes as the server computed them — never seconds,
 * never rates — and quality is a grade word first, a number second.
 *
 * Dates: the page works in LOCAL calendar dates (`YYYY-MM-DD`) in the
 * browser's own timezone, which is also the `tz` sent to the API. Day keys
 * are rendered by parsing them as UTC midnight and formatting with
 * `timeZone: 'UTC'`, so a key can never drift a day on either side of an
 * offset (same idiom as QualityTrendChart).
 */
import type { IsoDate, QualityGrade } from '../../types/reports';

/* ─── Timezone ──────────────────────────────────────────────────────────── */

/** The contract's default zone — used only if the browser can't tell us. */
const FALLBACK_TZ = 'America/New_York';

export function browserTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && tz.length > 0 ? tz : FALLBACK_TZ;
  } catch {
    return FALLBACK_TZ;
  }
}

/* ─── Calendar-date helpers ─────────────────────────────────────────────── */

/** Local calendar date of a Date → `YYYY-MM-DD`. */
export function toIsoDate(d: Date): IsoDate {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Day key → a UTC-midnight instant (format it with `timeZone: 'UTC'`). */
export function dayKeyToUtc(key: IsoDate): Date {
  return new Date(`${key}T00:00:00Z`);
}

const DAY_MS = 86_400_000;

/** Inclusive number of calendar days from `start` to `end` (1 for same day). */
export function inclusiveDays(start: IsoDate, end: IsoDate): number {
  return Math.round((dayKeyToUtc(end).getTime() - dayKeyToUtc(start).getTime()) / DAY_MS) + 1;
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(dayKeyToUtc(value).getTime());
}

/** The contract caps a report at 366 days. */
export const MAX_SPAN_DAYS = 366;

/* ─── Period presets ────────────────────────────────────────────────────── */

export type PeriodPreset = 'this_month' | 'last_month' | 'last_3_months' | 'this_year' | 'custom';

export const PRESET_OPTIONS: ReadonlyArray<{ id: PeriodPreset; label: string }> = [
  { id: 'this_month', label: 'This month' },
  { id: 'last_month', label: 'Last month' },
  { id: 'last_3_months', label: 'Last 3 months' },
  { id: 'this_year', label: 'This year' },
  { id: 'custom', label: 'Custom dates' },
];

export interface DateRange {
  start: IsoDate;
  end: IsoDate;
}

/**
 * Resolve a preset against "today" (local). Examples for today = 2026-09-23:
 *   this_month    → 2026-09-01 … 2026-09-23
 *   last_month    → 2026-08-01 … 2026-08-31
 *   last_3_months → 2026-07-01 … 2026-09-23  (this month + the two before)
 *   this_year     → 2026-01-01 … 2026-09-23
 */
export function presetRange(preset: Exclude<PeriodPreset, 'custom'>, today: Date): DateRange {
  const y = today.getFullYear();
  const m = today.getMonth();
  const end = toIsoDate(today);
  switch (preset) {
    case 'this_month':
      return { start: toIsoDate(new Date(y, m, 1)), end };
    case 'last_month':
      // Day 0 of this month = the last day of the previous month.
      return { start: toIsoDate(new Date(y, m - 1, 1)), end: toIsoDate(new Date(y, m, 0)) };
    case 'last_3_months':
      return { start: toIsoDate(new Date(y, m - 2, 1)), end };
    case 'this_year':
      return { start: toIsoDate(new Date(y, 0, 1)), end };
  }
}

/** Validation message for a custom range, or null when it's usable. */
export function validateRange(start: string, end: string): string | null {
  if (!start || !end) return 'Pick both a start date and an end date.';
  if (!isIsoDate(start) || !isIsoDate(end)) return 'Those dates don’t look right — try picking them again.';
  if (end < start) return 'The end date needs to be on or after the start date.';
  if (inclusiveDays(start, end) > MAX_SPAN_DAYS) return 'Reports can cover up to one year at a time.';
  return null;
}

/* ─── Date phrasing ─────────────────────────────────────────────────────── */

const MONTH_FMT = new Intl.DateTimeFormat(undefined, { month: 'long', timeZone: 'UTC' });
const MONTH_YEAR_FMT = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
const SHORT_FMT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const SHORT_YEAR_FMT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const LONG_FMT = new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const WEEKDAY_LONG_FMT = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });

/** "June 24, 2026" */
export function fmtLongDate(key: IsoDate): string {
  return LONG_FMT.format(dayKeyToUtc(key));
}

/** "Thursday, August 14" */
export function fmtWeekdayDate(key: IsoDate): string {
  return WEEKDAY_LONG_FMT.format(dayKeyToUtc(key));
}

/** "Aug 14" */
export function fmtShortDate(key: IsoDate): string {
  return SHORT_FMT.format(dayKeyToUtc(key));
}

/** True when the range is exactly one whole calendar month. */
function isWholeMonth(start: IsoDate, end: IsoDate): boolean {
  if (start.slice(8) !== '01' || start.slice(0, 7) !== end.slice(0, 7)) return false;
  const [y, m] = start.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Number(end.slice(8)) === lastDay;
}

/** "Aug 3 – Sep 10, 2026" / "Dec 20, 2025 – Jan 4, 2026" / "Aug 3, 2026" */
export function fmtRange(start: IsoDate, end: IsoDate): string {
  if (start === end) return SHORT_YEAR_FMT.format(dayKeyToUtc(start));
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  const left = sameYear ? SHORT_FMT.format(dayKeyToUtc(start)) : SHORT_YEAR_FMT.format(dayKeyToUtc(start));
  return `${left} – ${SHORT_YEAR_FMT.format(dayKeyToUtc(end))}`;
}

/**
 * The "when" part of the header sentence:
 *   this_month → "so far in September"      last_month → "in August"
 *   last_3_months → "in the last 3 months"  this_year → "so far in 2026"
 *   custom → "in August 2026" (whole month) / "between Aug 3 and Sep 10, 2026"
 */
export function periodPhrase(preset: PeriodPreset, range: DateRange): string {
  const start = dayKeyToUtc(range.start);
  switch (preset) {
    case 'this_month':
      return `so far in ${MONTH_FMT.format(start)}`;
    case 'last_month':
      return `in ${MONTH_FMT.format(start)}`;
    case 'last_3_months':
      return 'in the last 3 months';
    case 'this_year':
      return `so far in ${range.start.slice(0, 4)}`;
    case 'custom':
      if (isWholeMonth(range.start, range.end)) return `in ${MONTH_YEAR_FMT.format(start)}`;
      if (range.start === range.end) return `on ${SHORT_YEAR_FMT.format(start)}`;
      return `between ${fmtRange(range.start, range.end).replace(' – ', ' and ')}`;
  }
}

/**
 * What the previous period is called in a comparison:
 * "July" (a whole month, same year) / "December 2025" / "the 23 days before".
 */
export function previousPeriodLabel(prevStart: IsoDate, prevEnd: IsoDate, currentStart: IsoDate): string {
  if (isWholeMonth(prevStart, prevEnd)) {
    const d = dayKeyToUtc(prevStart);
    return prevStart.slice(0, 4) === currentStart.slice(0, 4) ? MONTH_FMT.format(d) : MONTH_YEAR_FMT.format(d);
  }
  const days = inclusiveDays(prevStart, prevEnd);
  return days === 1 ? 'the day before' : `the ${days.toLocaleString()} days before`;
}

/* ─── Hours ─────────────────────────────────────────────────────────────── */

function hour12(h: number): { n: number; ap: 'AM' | 'PM' } {
  const norm = ((h % 24) + 24) % 24;
  return { n: norm % 12 === 0 ? 12 : norm % 12, ap: norm < 12 ? 'AM' : 'PM' };
}

/**
 * A friendly one-hour window:
 *   10 → "10–11 AM"   11 → "11 AM–12 PM"   12 → "12–1 PM"   23 → "11 PM–12 AM"
 */
export function fmtHourRange(hour: number): string {
  const a = hour12(hour);
  const b = hour12(hour + 1);
  return a.ap === b.ap ? `${a.n}–${b.n} ${a.ap}` : `${a.n} ${a.ap}–${b.n} ${b.ap}`;
}

/* ─── Numbers ───────────────────────────────────────────────────────────── */

export function fmtCount(n: number): string {
  return n.toLocaleString();
}

export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/**
 * Whole-percent label that never lies at the edges: 99.6 → "99%" (not a
 * misleading "100%" while something was missed), 0.3 → "under 1%".
 */
export function fmtPct(pct: number | null | undefined): string {
  if (pct == null || Number.isNaN(pct)) return '—';
  return `${honestWhole(pct)}%`;
}

/** Integer rendering used by fmtPct and "N of every 100". */
export function honestWhole(pct: number): string {
  if (pct > 0 && pct < 1) return 'under 1';
  if (pct > 99 && pct < 100) return '99';
  return String(Math.round(pct));
}

/** "2,890 min" */
export function fmtMinutes(minutes: number): string {
  return `${minutes.toLocaleString()} min`;
}

/** Answered-call length on a single call: 0 → "—", n → "about n min". */
export function fmtCallLength(minutes: number): string {
  return minutes <= 0 ? '—' : `about ${minutes.toLocaleString()} min`;
}

/** Average answered-call length: 2.5 → "about 2.5 min", 3 → "about 3 min". */
export function fmtAvgMinutes(avg: number | null | undefined): string {
  if (avg == null || Number.isNaN(avg) || avg <= 0) return '—';
  const rounded = Math.round(avg * 10) / 10;
  return `about ${rounded.toLocaleString(undefined, { maximumFractionDigits: 1 })} min`;
}

/** "+1 (617) 454-4217" for US numbers, otherwise as given. */
export function fmtPhone(phone: string | null | undefined): string {
  if (!phone) return '—';
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return phone;
}

/* ─── Call timestamps (start time only, shown in the report's zone) ─────── */

export function fmtCallDate(iso: string, tz: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: tz });
}

export function fmtCallTime(iso: string, tz: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: tz });
}

/* ─── Quality grades ────────────────────────────────────────────────────── */

export const GRADE_WORD: Record<QualityGrade, string> = {
  great: 'Great',
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
  none: 'Not measured yet',
};

/** Text color per grade — always paired with the word, never color alone. */
export const GRADE_TONE: Record<QualityGrade, string> = {
  great: '#15803d',
  good: '#1d63dd',
  fair: '#b45309',
  poor: '#b91c1c',
  none: '#5d6f8c',
};

export const GRADE_BLURB: Record<QualityGrade, string> = {
  great: 'Calls sounded clear — like talking to someone in the same room.',
  good: 'Calls sounded clear, with only the odd tiny blip.',
  fair: 'Most calls were fine, but some had noticeable crackles, echoes or delays.',
  poor: 'Many calls had choppy or hard-to-hear sound. If this keeps happening, let us know and we’ll look into it.',
  none: 'We haven’t measured sound on any answered calls in this period yet.',
};

/* ─── Chart series colors (legend + bars + PDF share them) ──────────────── */

export const TREND_COLORS = { answered: '#2f7df6', missed: '#d97706' } as const;
