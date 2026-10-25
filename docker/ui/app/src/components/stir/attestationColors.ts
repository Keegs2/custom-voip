/**
 * Semantic colour tokens for STIR/SHAKEN attestation display.
 *
 * Single source of truth shared by the per-call chain (`AttestationChain`) and
 * the admin summary panel (`StirSummaryPage`) so the colour language is
 * identical everywhere.
 *
 * Palette follows the app convention (green=good, amber=partial, red=bad,
 * gray=none) with the brand blue reserved for `div` (diversion):
 *   - Attestation:  A = green,   B = amber,  C = gray,  div = blue
 *   - Verstat:      Passed = green,  Failed = red,  No-TN / none = gray
 *
 * THEMED (docker/ui/CLAUDE.md §18): every value is a theme-token `var()`
 * string — the status tones (`TONE.*`) plus two alpha steps — so a pill reads
 * on paper and on granite alike (light: green-700 / amber-700 / red-700 /
 * slate text, ≥ 4.4:1 on its wash; dark: the lifted granite tones). This
 * replaced the old dark-UI palette (#22c55e / #f59e0b / #ef4444 / #94a3b8
 * text), which measured 2.1–3.8:1 on the white call-detail modal. The
 * Troubleshooting badges (CallBadges) render from the same table.
 */

import type { AttestationLevel, StirBadgeFields, StirBadgeSource, VerstatSource } from '../../types/stir';
import { T, TONE, tMix } from '../../styles/theme';

export interface ColorToken {
  /** Foreground / text colour. */
  text: string;
  /** Translucent fill for pills/badges. */
  bg: string;
  /** Border colour for pills/badges. */
  border: string;
}

// ── Palette (theme tokens) ───────────────────────────────────────────────────
const GREEN: ColorToken = { text: T.okFg, bg: TONE.ok.bg, border: TONE.ok.border };
const AMBER: ColorToken = { text: T.warnFg, bg: TONE.warn.bg, border: TONE.warn.border };
const RED: ColorToken   = { text: T.dangerFg, bg: tMix('danger-solid', 8), border: TONE.danger.border };
const BLUE: ColorToken  = { text: T.infoFg, bg: TONE.info.bg, border: tMix('info-solid', 26) };
const GRAY: ColorToken  = { text: T.neutralFg, bg: TONE.neutral.bg, border: TONE.neutral.border };
/** Nothing on record / a label this build doesn't know — the gray chrome
 *  with dim (not faint) text, so the word itself still reads at AA. */
const NONE: ColorToken  = { text: T.textDim, bg: TONE.neutral.bg, border: TONE.neutral.border };

export type AttestToneKey = 'A' | 'B' | 'C' | 'div' | 'base-only' | 'unsigned' | 'none';

/**
 * Every attestation label → its pill tone. Wire-outcome labels (Kamailio
 * `eff=`): a base PASSporT went out but no div could be chained (amber), or
 * nothing was signed at all (red — the compliance-risk case).
 */
export const ATTEST_TONES: Readonly<Record<AttestToneKey, ColorToken>> = Object.freeze({
  A: GREEN,
  B: AMBER,
  C: GRAY,
  div: BLUE,
  'base-only': AMBER,
  unsigned: RED,
  none: NONE,
});

/** Colour for an attestation level. `null`/unknown → gray ("none"). */
export function attestColor(level: AttestationLevel | string | null | undefined): ColorToken {
  switch (level) {
    case 'A':
      return GREEN;
    case 'B':
      return AMBER;
    case 'C':
      return GRAY;
    case 'div':
      return BLUE;
    // Wire-outcome labels (Kamailio `eff=` token): base PASSporT only, or
    // nothing signed at all (fail-open) — the compliance-risk one is red.
    case 'base-only':
      return AMBER;
    case 'unsigned':
      return RED;
    default:
      return GRAY;
  }
}

// ── Badge resolution (ACTUAL wire outcome vs INTENT) ─────────────────────────

export interface ResolvedStirBadge {
  /** The level to render, or null when nothing is known. */
  level: string | null;
  /** 'actual' = confirmed on the wire by Kamailio; 'intent' = what we asked for. */
  source: StirBadgeSource | null;
  /** Human note for tooltips — spells out the confidence of the badge. */
  note: string;
  /** Parsed `mode=` of the outcome string when present (relay, reorig, ...). */
  mode: string | null;
}

/** Tooltip phrasing shared by every badge site. */
export const INTENT_ONLY_NOTE = 'intent, not confirmed on wire';
export const ACTUAL_NOTE = 'confirmed on wire (Kamailio outcome)';

/** `k=v;k=v` -> value of `key`, or null. Tolerates garbage. */
export function outcomeToken(outcome: string | null | undefined, key: string): string | null {
  if (!outcome) return null;
  for (const piece of outcome.split(';')) {
    const eq = piece.indexOf('=');
    if (eq <= 0) continue;
    if (piece.slice(0, eq).trim().toLowerCase() === key) {
      const v = piece.slice(eq + 1).trim();
      return v || null;
    }
  }
  return null;
}

/**
 * Resolve which attestation to show for a call and how confident it is.
 *
 * Prefers the API's own `stir_badge` / `stir_badge_source` (one serializer
 * server-side). Falls back — for cached/older responses that predate
 * migration 47 — to `stir_eff_actual` if present, else the intent-derived
 * `signed_attestation`, so the badge never regresses to blank.
 */
export function resolveStirBadge(
  att: (StirBadgeFields & { signed_attestation?: AttestationLevel | string | null }) | null | undefined,
): ResolvedStirBadge {
  if (!att) return { level: null, source: null, note: 'No attestation on record', mode: null };
  const mode = outcomeToken(att.stir_outcome, 'mode');
  if (att.stir_badge && att.stir_badge_source) {
    return {
      level: att.stir_badge,
      source: att.stir_badge_source,
      note: att.stir_badge_source === 'actual' ? ACTUAL_NOTE : INTENT_ONLY_NOTE,
      mode,
    };
  }
  if (att.stir_eff_actual) {
    return { level: att.stir_eff_actual, source: 'actual', note: ACTUAL_NOTE, mode };
  }
  const intent = att.stir_attestation ?? att.signed_attestation ?? null;
  if (intent) return { level: intent, source: 'intent', note: INTENT_ONLY_NOTE, mode };
  return { level: null, source: null, note: 'No attestation on record', mode };
}

/**
 * Colour for a verstat string. Matches on the SHAKEN verstat vocabulary:
 *   - "…Passed"  → green
 *   - "…Failed"  → red
 *   - "No-TN-Validation" / anything else / none → gray
 */
export function verstatColor(verstat: string | null | undefined): ColorToken {
  if (!verstat) return GRAY;
  const v = verstat.toLowerCase();
  if (v.includes('passed')) return GREEN;
  if (v.includes('failed')) return RED;
  return GRAY;
}

/** Colour for the verstat source note. `carrier` reads as more authoritative (blue) than `self` (gray). */
export function verstatSourceColor(source: VerstatSource | string | null | undefined): ColorToken {
  return source === 'carrier' ? BLUE : GRAY;
}

// ── Display helpers ──────────────────────────────────────────────────────────

/** Human label for an attestation level, e.g. "A", "div → Diversion". */
export function attestLabel(level: AttestationLevel | string | null | undefined): string {
  if (!level) return 'None';
  if (level === 'div') return 'div';
  return level;
}

/** Longer description of an attestation level for tooltips / sub-notes. */
export function attestDescription(level: AttestationLevel | string | null | undefined): string {
  switch (level) {
    case 'A':
      return 'Full attestation';
    case 'B':
      return 'Partial attestation';
    case 'C':
      return 'Gateway attestation';
    case 'div':
      return 'Diversion (forwarded call)';
    case 'base-only':
      return 'Base PASSporT only (no div chained)';
    case 'unsigned':
      return 'Nothing signed on the wire';
    default:
      return 'Not attested';
  }
}

/** Whether a verstat string represents a passing validation (drives the ✓/✗ glyph). */
export type VerstatVerdict = 'pass' | 'fail' | 'none';

export function verstatVerdict(verstat: string | null | undefined): VerstatVerdict {
  if (!verstat) return 'none';
  const v = verstat.toLowerCase();
  if (v.includes('passed')) return 'pass';
  if (v.includes('failed')) return 'fail';
  return 'none';
}
