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

import type { AttestationLevel, VerstatSource } from '../../types/stir';

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
    default:
      return GRAY;
  }
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
