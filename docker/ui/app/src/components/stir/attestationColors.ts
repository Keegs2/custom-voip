/**
 * Semantic colour tokens for STIR/SHAKEN attestation display.
 *
 * Single source of truth shared by the per-call chain (`AttestationChain`) and
 * the admin summary panel (`StirSummaryPage`) so the colour language is
 * identical everywhere.
 *
 * Palette follows the app convention (green=good, amber=partial, red=bad,
 * gray=none) with the blue brand (#3b82f6) reserved for `div` (diversion):
 *   - Attestation:  A = green,   B = amber,  C = gray,  div = blue
 *   - Verstat:      Passed = green,  Failed = red,  No-TN / none = gray
 */

import type { AttestationLevel, StirBadgeFields, StirBadgeSource, VerstatSource } from '../../types/stir';

export interface ColorToken {
  /** Foreground / text colour. */
  text: string;
  /** Translucent fill for pills/badges. */
  bg: string;
  /** Border colour for pills/badges. */
  border: string;
}

// ── Raw palette ──────────────────────────────────────────────────────────────
const GREEN: ColorToken = { text: '#22c55e', bg: 'rgba(34,197,94,0.12)', border: 'rgba(34,197,94,0.25)' };
const AMBER: ColorToken = { text: '#f59e0b', bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.28)' };
const RED: ColorToken   = { text: '#ef4444', bg: 'rgba(239,68,68,0.12)',  border: 'rgba(239,68,68,0.28)'  };
const BLUE: ColorToken  = { text: '#3b82f6', bg: 'rgba(59,130,246,0.14)', border: 'rgba(59,130,246,0.30)' };
const GRAY: ColorToken  = { text: '#94a3b8', bg: 'rgba(74,85,104,0.15)',  border: 'rgba(74,85,104,0.30)'  };

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
