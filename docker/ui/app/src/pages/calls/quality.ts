/**
 * quality.ts — THE single UI owner of the voice-quality grade (contract:
 * docs/CALL_QUALITY_ACCURACY_PLAN.md §D) plus the shared color semantics and
 * small formatters used by every quality surface (Calls & Quality page, call
 * detail modal, RCF call activity).
 *
 * What the numbers mean (since migration 50):
 *   - `mos` / `r_factor` are OUR ITU-T G.107 E-model score computed from TRUE
 *     RTP sequence loss (not FreeSWITCH's do_mos(), which scored silence as
 *     4.50). A perfectly clean G.711 call is 4.41 — the G.107 ceiling.
 *   - They are non-NULL only when the leg was actually graded
 *     (`quality_status === 'rated'`). Everything else carries a status that
 *     explains why there is no score (see `qualityStatusReason`).
 *   - `jitter_*_ms` are RFC 3550 interarrival jitter (diagnostic only — it
 *     does not enter the MOS).
 *   - Call quality (`call_quality_*`, `call_mos`) = the WORSE of the two
 *     audio directions, computed server-side on the call (A) row.
 *
 * Grade bands (G.109 R 90/80/70 mapped to MOS, applied to the STORED 2-dp
 * value so Python, SQL and this file agree on every row):
 *   great ≥ 4.34 · good ≥ 4.02 · fair ≥ 3.60 · poor < 3.60 (or one-way audio)
 * One-way audio (`no_rtp`) = < 10% of the expected packets received while
 * ≥ 50% were sent; `no_media` (migration 51) = < 10% received AND < 50% sent —
 * no audio either way (failed setup, test call, both parties silent). It is
 * NOT graded and never counts as one-way.
 * Secondary colour-only thresholds for raw numbers:
 *   R ≥ 80 / ≥ 70 · loss ≤ 4% / ≤ 8% · jitter ≤ 20 ms / ≤ 50 ms.
 *
 * Status colors are quality semantics only, never decoration.
 * Boundary self-test: ./quality.assert.ts (mirrors the Python tests).
 */

export const MONO = '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace';

/** Ink-dark status tones tuned for legibility on the white paper canvas. */
export const GOOD = '#15803d';
export const WARN = '#b45309';
export const BAD = '#b91c1c';
export const INK_FAINT = '#8b99b0';
export const AZURE_DEEP = '#1d63dd';

/* ─── The one grade definition (§D) ─────────────────────────────────────── */

export type Grade = 'great' | 'good' | 'fair' | 'poor';

/** Per-leg / per-call grading outcome (contract B.2). */
export type QualityStatus =
  | 'rated'
  | 'no_rtp'
  | 'no_media'
  | 'low_sample'
  | 'short'
  | 'unanswered'
  | 'no_data';

/** MOS cut points — G.109 R 90 / 80 / 70 → MOS, rounded to 2 dp. */
export const GRADE_MOS_GREAT = 4.34;
export const GRADE_MOS_GOOD = 4.02;
export const GRADE_MOS_FAIR = 3.6;

/**
 * Grade for a stored (2-dp) MOS. NULL / non-finite → null (not graded).
 * The input is rounded to 2 dp first so a float like 4.3399999 grades the
 * same as the stored NUMERIC(3,2) 4.34 would.
 */
export function gradeForMos(mos: number | null | undefined): Grade | null {
  if (mos == null || !Number.isFinite(mos)) return null;
  const m = Math.round(mos * 100) / 100;
  if (m >= GRADE_MOS_GREAT) return 'great';
  if (m >= GRADE_MOS_GOOD) return 'good';
  if (m >= GRADE_MOS_FAIR) return 'fair';
  return 'poor';
}

const GRADE_LABEL: Record<Grade, string> = {
  great: 'Great',
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
};

/**
 * Display word for a grade. `status === 'no_rtp'` reads "One-way" (it is a
 * poor grade, but saying WHY is the honest label). Ungraded → "—".
 */
export function gradeLabel(grade: Grade | null | undefined, status?: QualityStatus | null): string {
  if (status === 'no_rtp') return 'One-way';
  return grade ? GRADE_LABEL[grade] : '—';
}

/** Narrowing guard for grade strings arriving off the wire. */
export function isGrade(v: unknown): v is Grade {
  return v === 'great' || v === 'good' || v === 'fair' || v === 'poor';
}

/** Text color for a grade: great/good → GOOD, fair → WARN, poor → BAD, none → faint. */
export function gradeColor(grade: Grade | null | undefined): string {
  switch (grade) {
    case 'great':
    case 'good':
      return GOOD;
    case 'fair':
      return WARN;
    case 'poor':
      return BAD;
    default:
      return INK_FAINT;
  }
}

export interface QualityTone {
  text: string;
  bg: string;
  border: string;
}

const TONE_GOOD: QualityTone = { text: GOOD, bg: 'rgba(22,163,74,0.1)', border: 'rgba(22,163,74,0.26)' };
const TONE_WARN: QualityTone = { text: WARN, bg: 'rgba(180,83,9,0.09)', border: 'rgba(180,83,9,0.26)' };
const TONE_BAD: QualityTone = { text: BAD, bg: 'rgba(220,38,38,0.07)', border: 'rgba(220,38,38,0.26)' };
const TONE_NONE: QualityTone = { text: INK_FAINT, bg: 'rgba(93,111,140,0.08)', border: 'rgba(93,111,140,0.2)' };

/** Translucent pill tone for a grade on the white canvas. */
export function gradeTone(grade: Grade | null | undefined): QualityTone {
  switch (grade) {
    case 'great':
    case 'good':
      return TONE_GOOD;
    case 'fair':
      return TONE_WARN;
    case 'poor':
      return TONE_BAD;
    default:
      return TONE_NONE;
  }
}

/** MOS colour = the colour of its grade (no separate MOS thresholds exist). */
export function mosColor(mos: number | null | undefined): string {
  return gradeColor(gradeForMos(mos));
}

/** MOS pill tone = the tone of its grade. */
export function mosTone(mos: number | null | undefined): QualityTone {
  return gradeTone(gradeForMos(mos));
}

/* ─── Why a call / leg has no grade ─────────────────────────────────────── */

export type ReasonAudience = 'customer' | 'staff';

const STATUS_REASON: Record<Exclude<QualityStatus, 'rated'>, Record<ReasonAudience, string>> = {
  no_rtp: {
    customer: 'One-way audio — no sound came through from one side',
    staff: 'One-way audio: no inbound media',
  },
  no_media: {
    customer: 'No audio either way — the call never carried sound',
    staff: 'No media either direction (in < 10%, out < 50% of expected packets) — not graded',
  },
  short: {
    customer: 'Not graded — the call was under 5 seconds',
    staff: 'Not graded — call under 5 s',
  },
  low_sample: {
    customer: 'Not graded — too little sound to measure',
    staff: 'Too few packets',
  },
  no_data: {
    customer: 'Not graded — no sound measurements for this call',
    staff: 'No media data',
  },
  unanswered: {
    customer: 'Not graded — the call wasn’t answered',
    staff: 'Unanswered',
  },
};

/**
 * Plain-language explanation for a non-rated status (customer wording on
 * customer surfaces, the technical wording for staff). `rated` → null.
 * Unknown / NULL status (pre-migration row) → the no-data wording.
 */
export function qualityStatusReason(
  status: QualityStatus | null | undefined,
  audience: ReasonAudience,
): string | null {
  if (status === 'rated') return null;
  if (status == null || !(status in STATUS_REASON)) return STATUS_REASON.no_data[audience];
  return STATUS_REASON[status][audience];
}

const STATUS_SHORT: Record<Exclude<QualityStatus, 'rated' | 'no_rtp'>, string> = {
  short: 'under 5 sec',
  no_media: 'no audio either way',
  low_sample: 'too little sound',
  no_data: 'no sound data',
  unanswered: 'not answered',
};

/**
 * Compact customer phrase for a table cell next to "Not rated". `rated` and
 * `no_rtp` (which IS graded — poor / one-way) → null.
 */
export function qualityStatusShort(status: QualityStatus | null | undefined): string | null {
  if (status === 'rated' || status === 'no_rtp') return null;
  if (status == null || !(status in STATUS_SHORT)) return STATUS_SHORT.no_data;
  return STATUS_SHORT[status];
}

/* ─── Colour-only thresholds for raw numbers ────────────────────────────── */

export function rFactorColor(r: number | null | undefined): string {
  if (r == null) return INK_FAINT;
  if (r >= 80) return GOOD;
  if (r >= 70) return WARN;
  return BAD;
}

export function packetLossColor(pct: number | null | undefined): string {
  if (pct == null) return INK_FAINT;
  if (pct <= 4) return GOOD;
  if (pct <= 8) return WARN;
  return BAD;
}

/** RFC 3550 mean jitter — diagnostic only. */
export function jitterColor(ms: number | null | undefined): string {
  if (ms == null) return INK_FAINT;
  if (ms <= 20) return GOOD;
  if (ms <= 50) return WARN;
  return BAD;
}

/**
 * Share of graded calls that were good or better (0–100). Tone follows the
 * NOC "Good-or-better calls" stat (plan §E.1 #43): < 90 red, < 97 amber.
 */
export function goodShareColor(pct: number | null | undefined): string {
  if (pct == null) return INK_FAINT;
  if (pct >= 97) return GOOD;
  if (pct >= 90) return WARN;
  return BAD;
}

/* ─── Aggregation (shares / percentiles — never averages of MOS) ────────── */

/**
 * Continuous percentile (PostgreSQL `percentile_cont` semantics: linear
 * interpolation between the closest ranks). `p` in [0, 1]. Empty → null.
 *
 * Example: percentileCont([1, 2, 3, 4], 0.5) === 2.5
 */
export function percentileCont(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const clamped = Math.min(Math.max(p, 0), 1);
  const rank = clamped * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/** Minimal shape the call-level aggregation reads (A rows). */
export interface CallQualityFields {
  call_quality_status?: QualityStatus | null;
  call_quality_grade?: Grade | null;
  call_mos?: number | null;
}

export interface CallQualitySummary {
  /** Calls that carry a call grade (rated or one-way). */
  graded: number;
  /** great + good. */
  goodOrBetter: number;
  /** poor, INCLUDING one-way audio calls. */
  poor: number;
  /** call_quality_status === 'no_rtp'. */
  oneWay: number;
  /** goodOrBetter ÷ graded × 100, null when nothing is graded. */
  goodSharePct: number | null;
  /** Median call MOS over rated calls, null when none. */
  medianMos: number | null;
}

/** Page / bucket summary of call-level grades — counts and shares only. */
export function summarizeCallQuality(rows: readonly CallQualityFields[]): CallQualitySummary {
  let graded = 0;
  let goodOrBetter = 0;
  let poor = 0;
  let oneWay = 0;
  const moses: number[] = [];
  for (const r of rows) {
    const g = r.call_quality_grade;
    if (r.call_quality_status === 'no_rtp') oneWay++;
    if (g == null) continue;
    graded++;
    if (g === 'great' || g === 'good') goodOrBetter++;
    else if (g === 'poor') poor++;
    if (r.call_quality_status === 'rated' && r.call_mos != null) moses.push(r.call_mos);
  }
  return {
    graded,
    goodOrBetter,
    poor,
    oneWay,
    goodSharePct: graded > 0 ? (goodOrBetter / graded) * 100 : null,
    medianMos: percentileCont(moses, 0.5),
  };
}

/* ─── Formatters ────────────────────────────────────────────────────────── */

export function fmtDurationShort(sec: number): string {
  if (sec <= 0) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
