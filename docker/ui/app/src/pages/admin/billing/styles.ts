/**
 * Shared liquid-glass style objects for the billing admin area
 * (Rates / Tiers / SIPp). Centralises the frosted visual language so the three
 * feature folders refract light identically. Everything leads with the app blue
 * (`GLASS.accent`) and can be re-tinted by passing a different `accent`.
 *
 * Static styles are exported as constants; parameterised ones as builders.
 * This module is React-free (only `CSSProperties`) so it never trips
 * `react-refresh/only-export-components`.
 */

import type { CSSProperties, FocusEvent } from 'react';
import { GLASS, hexToRgba } from '../../../components/glass/glass';

export const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

// ── Section header (inside SectionPanel) ─────────────────────────────────────

export function sectionEyebrow(accent = GLASS.accent): CSSProperties {
  return {
    fontSize: '0.6rem',
    fontWeight: 700,
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    color: accent,
    opacity: 0.85,
    marginBottom: 8,
  };
}

export const sectionTitle: CSSProperties = {
  fontSize: '1.02rem',
  fontWeight: 700,
  color: GLASS.text,
  margin: 0,
  letterSpacing: '-0.01em',
  textShadow: '0 1px 10px rgba(0,0,0,0.45)',
};

export const sectionDesc: CSSProperties = {
  fontSize: '0.85rem',
  color: GLASS.textMuted,
  marginTop: 5,
  lineHeight: 1.55,
  maxWidth: 620,
};

// ── Form fields ──────────────────────────────────────────────────────────────

export const labelStyle: CSSProperties = {
  fontSize: '0.64rem',
  fontWeight: 700,
  color: GLASS.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.09em',
  marginBottom: 6,
  display: 'block',
};

export function glassInput(narrow = false): CSSProperties {
  return {
    fontSize: '0.875rem',
    padding: '8px 12px',
    borderRadius: 10,
    width: narrow ? 96 : '100%',
    boxSizing: 'border-box',
    border: '1px solid rgba(255,255,255,0.10)',
    background: 'rgba(8,10,15,0.45)',
    color: GLASS.text,
    outline: 'none',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    transition: 'border-color 0.16s, box-shadow 0.16s',
  };
}

/** Focus/blur handlers that paint the accent glow on a glass input. */
export function inputFocus(accent = GLASS.accent) {
  return (e: FocusEvent<HTMLInputElement>) => {
    e.currentTarget.style.borderColor = hexToRgba(accent, 0.55);
    e.currentTarget.style.boxShadow = `0 0 0 3px ${hexToRgba(accent, 0.14)}`;
  };
}

export function inputBlur(e: FocusEvent<HTMLInputElement>) {
  e.currentTarget.style.borderColor = 'rgba(255,255,255,0.10)';
  e.currentTarget.style.boxShadow = 'none';
}

// ── Glass table cells ────────────────────────────────────────────────────────

export const th: CSSProperties = {
  textAlign: 'left',
  fontSize: '0.62rem',
  fontWeight: 700,
  color: GLASS.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  padding: '12px 18px',
  whiteSpace: 'nowrap',
  borderBottom: '1px solid rgba(255,255,255,0.08)',
};

export const td: CSSProperties = {
  padding: '13px 18px',
  fontSize: '0.85rem',
  color: GLASS.text,
  borderTop: '1px solid rgba(255,255,255,0.05)',
  verticalAlign: 'middle',
};

// ── Stat tiles ───────────────────────────────────────────────────────────────

export const statTile: CSSProperties = {
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 12,
  padding: '13px 14px',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
};

export const statTileLabel: CSSProperties = {
  fontSize: '0.6rem',
  fontWeight: 700,
  color: GLASS.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  marginBottom: 8,
};

export function statTileValue(accent?: string): CSSProperties {
  return {
    fontSize: '1.3rem',
    fontWeight: 800,
    fontVariantNumeric: 'tabular-nums',
    lineHeight: 1,
    color: accent ?? GLASS.text,
    textShadow: '0 1px 10px rgba(0,0,0,0.4)',
  };
}

// ── Group label (small uppercase divider above a sub-block) ──────────────────

export const groupLabel: CSSProperties = {
  fontSize: '0.62rem',
  fontWeight: 700,
  color: GLASS.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.09em',
  marginBottom: 12,
};
