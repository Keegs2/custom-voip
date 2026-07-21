/**
 * Centralised style objects for the Dashboard hub.
 *
 * Presentational components import these instead of inlining big CSSProperties
 * blocks. Static styles are constants; hover/state-dependent styles are small
 * builder functions parameterised on the app blue accent (`GLASS.accent`).
 */

import type { CSSProperties } from 'react';
import { GLASS, hexToRgba } from '../../components/glass/glass';

/* ── Page layout rhythm ─────────────────────────────────────────────────── */

/** Outer page column: full width, vertical rhythm via the 32px section gap. */
export const pageColumn: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  width: '100%',
  gap: 32,
};

/** A standard full-width section (centered within the layout's content column). */
export const sectionBlock: CSSProperties = {
  width: '100%',
};

/* ── Hero ───────────────────────────────────────────────────────────────── */

export const heroWrap: CSSProperties = {
  textAlign: 'center',
  width: '100%',
  maxWidth: 760,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  // A little extra breathing room beneath the marketing hero.
  paddingTop: 8,
  paddingBottom: 8,
};

export const heroImageWrap: CSSProperties = {
  position: 'relative',
  marginBottom: 28,
  overflow: 'hidden',
  borderRadius: 16,
};

export const heroImage: CSSProperties = {
  width: 320,
  height: 'auto',
  display: 'block',
};

export const heroScanLine: CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'linear-gradient(180deg, transparent 0%, rgba(96,165,250,0.06) 50%, transparent 100%)',
  pointerEvents: 'none',
};

export const heroTitle: CSSProperties = {
  fontSize: 'clamp(1.6rem, 3.6vw, 2.3rem)',
  fontWeight: 800,
  color: GLASS.text,
  letterSpacing: '-0.03em',
  lineHeight: 1.18,
  margin: '0 0 16px',
  textShadow: '0 2px 24px rgba(0,0,0,0.5)',
};

export const heroTitleAccent: CSSProperties = {
  color: GLASS.accent,
};

export const heroSubtitle: CSSProperties = {
  fontSize: '1rem',
  color: GLASS.textMuted,
  lineHeight: 1.7,
  maxWidth: 600,
  margin: '0 auto',
};

/* ── Section label ──────────────────────────────────────────────────────── */

export const sectionLabel: CSSProperties = {
  fontSize: '0.62rem',
  fontWeight: 700,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: GLASS.accent,
  marginBottom: 16,
  opacity: 0.85,
};

/* ── Product card ───────────────────────────────────────────────────────── */

export const productCardBody: CSSProperties = {
  padding: '20px 22px',
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
};

export const productHeaderRow: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  marginBottom: 16,
};

export function productIconBox(accent: string, hovered: boolean): CSSProperties {
  return {
    width: 42,
    height: 42,
    borderRadius: 11,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: hovered ? '#bfdbfe' : accent,
    background: `linear-gradient(135deg, ${hexToRgba(accent, hovered ? 0.26 : 0.16)} 0%, ${hexToRgba(accent, 0.07)} 100%)`,
    border: `1px solid ${hexToRgba(accent, hovered ? 0.42 : 0.26)}`,
    transition: 'background 0.22s ease, border-color 0.22s ease, color 0.22s ease',
    flexShrink: 0,
  };
}

export function productBadge(accent: string): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    background: hexToRgba(accent, 0.12),
    border: `1px solid ${hexToRgba(accent, 0.3)}`,
    borderRadius: 999,
    padding: '3px 9px',
  };
}

export function productBadgeDot(accent: string): CSSProperties {
  return {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: accent,
    boxShadow: `0 0 6px ${hexToRgba(accent, 0.9)}`,
  };
}

export function productBadgeText(color: string): CSSProperties {
  return {
    fontSize: '0.58rem',
    fontWeight: 700,
    color,
    letterSpacing: '0.09em',
    textTransform: 'uppercase',
  };
}

export const productTitle: CSSProperties = {
  fontSize: '0.92rem',
  fontWeight: 700,
  color: GLASS.text,
  letterSpacing: '-0.01em',
  marginBottom: 6,
};

export const productSubtitle: CSSProperties = {
  fontSize: '0.74rem',
  color: GLASS.textMuted,
  lineHeight: 1.55,
};

/**
 * "Read the guide" docs link at the foot of a product card. A subtle,
 * low-friction "learn more" affordance that routes to the PUBLIC /docs guide, so
 * it works for logged-out prospects too. `mt: auto` pins it to the card bottom.
 */
export function productDocsLink(accent: string, hovered: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    marginTop: 14,
    fontSize: '0.68rem',
    fontWeight: 700,
    letterSpacing: '0.02em',
    color: hovered ? accent : GLASS.textFaint,
    textDecoration: 'none',
    transition: 'color 0.18s ease, gap 0.18s ease',
    alignSelf: 'flex-start',
  };
}

/* ── Capability card ────────────────────────────────────────────────────── */

/** Responsive capabilities grid — 4-up on wide screens, wraps gracefully. */
export const capabilitiesGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
  gap: 16,
};

export const capabilityBody: CSSProperties = {
  padding: '22px 22px 20px',
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
};

export function capabilityIconBox(accent: string, hovered: boolean): CSSProperties {
  return {
    width: 44,
    height: 44,
    borderRadius: 12,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
    color: hovered ? '#93c5fd' : accent,
    background: `linear-gradient(135deg, ${hexToRgba(accent, hovered ? 0.22 : 0.14)} 0%, ${hexToRgba(accent, 0.06)} 100%)`,
    border: `1px solid ${hexToRgba(accent, hovered ? 0.35 : 0.2)}`,
    transition: 'background 0.25s ease, border-color 0.25s ease, color 0.25s ease',
  };
}

export const capabilityTitle: CSSProperties = {
  fontSize: '1rem',
  fontWeight: 700,
  color: GLASS.text,
  letterSpacing: '-0.01em',
  marginBottom: 10,
};

export const capabilityDescription: CSSProperties = {
  fontSize: '0.8rem',
  color: GLASS.textMuted,
  lineHeight: 1.65,
};

/* ── Request Access CTA ─────────────────────────────────────────────────── */

export const ctaInner: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  textAlign: 'center',
  padding: '36px 24px',
  gap: 14,
};

export const ctaEyebrow: CSSProperties = {
  fontSize: '0.72rem',
  color: GLASS.textMuted,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  fontWeight: 600,
};

export function ctaButton(hovered: boolean, accent = GLASS.accent): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '14px 36px',
    borderRadius: 12,
    border: 'none',
    background: hovered
      ? `linear-gradient(135deg, ${hexToRgba(accent, 1)} 0%, #2563eb 100%)`
      : `linear-gradient(135deg, ${accent} 0%, #2563eb 100%)`,
    color: '#fff',
    fontSize: '0.9rem',
    fontWeight: 700,
    cursor: 'pointer',
    letterSpacing: '-0.01em',
    fontFamily: 'inherit',
    boxShadow: hovered
      ? `0 0 30px -4px ${hexToRgba(accent, 0.6)}, 0 8px 24px -8px rgba(0,0,0,0.45)`
      : `0 6px 22px -8px ${hexToRgba(accent, 0.45)}, 0 4px 16px -6px rgba(0,0,0,0.35)`,
    transform: hovered ? 'scale(1.02)' : 'scale(1)',
    transition: 'all 0.2s ease',
  };
}

export const ctaFinePrint: CSSProperties = {
  fontSize: '0.72rem',
  color: GLASS.textFaint,
  letterSpacing: '0.01em',
};
