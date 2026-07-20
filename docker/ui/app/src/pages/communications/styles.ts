/**
 * Centralised style objects + builders for the Communications hub. Keeps the
 * visual language (spacing, accent usage, gradient title) in one place; the
 * presentational components import these instead of inlining big CSSProperties
 * blocks. Everything leads off `GLASS` tokens (app blue) and re-tints locally
 * via an `accent` argument where a product-specific hue is justified.
 */

import type { CSSProperties } from 'react';
import { GLASS, hexToRgba } from '../../components/glass/glass';

// ── Page shell ───────────────────────────────────────────────────────────────
// AppLayout owns the top offset + horizontal gutters; the hub just centers a
// readable column inside it. No top padding here (never re-pad the top edge).

export const pageColumn: CSSProperties = {
  width: '100%',
  maxWidth: 920,
  margin: '0 auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 32, // section gap (spacing standard)
};

// ── Hero ─────────────────────────────────────────────────────────────────────

export const heroWrap: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  textAlign: 'center',
  gap: 16,
};

export function heroIconRing(accent = GLASS.accent): CSSProperties {
  return {
    width: 76,
    height: 76,
    borderRadius: 22,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: `linear-gradient(135deg, ${hexToRgba(accent, 0.2)} 0%, ${hexToRgba(GLASS.accentSecondary, 0.12)} 100%)`,
    border: `1px solid ${hexToRgba(accent, 0.28)}`,
    boxShadow: `0 0 36px -6px ${hexToRgba(accent, 0.35)}, inset 0 1px 0 rgba(255,255,255,0.16)`,
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
  };
}

export function heroTitle(accent = GLASS.accent): CSSProperties {
  return {
    fontSize: 'clamp(1.9rem, 3.4vw, 2.6rem)',
    fontWeight: 800,
    letterSpacing: '-0.03em',
    lineHeight: 1.08,
    margin: 0,
    color: GLASS.text,
    background: `linear-gradient(120deg, #ffffff 0%, ${GLASS.text} 38%, ${hexToRgba(accent, 0.85)} 112%)`,
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
  };
}

export const heroSubtitle: CSSProperties = {
  margin: 0,
  fontSize: '0.95rem',
  color: GLASS.textMuted,
  maxWidth: 480,
  lineHeight: 1.6,
  // darker scrim under text isn't needed here (centered over the ambient field),
  // but a subtle shadow keeps contrast crisp where blobs brighten the backdrop.
  textShadow: '0 1px 8px rgba(0,0,0,0.4)',
};

// ── Feature grid ─────────────────────────────────────────────────────────────

export const featureGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
  gap: 16, // card gap (spacing standard)
};

// ── Feature card internals ───────────────────────────────────────────────────

export const cardInner: CSSProperties = {
  padding: 24,
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  minHeight: 176,
};

export function cardIconRing(accent: string): CSSProperties {
  return {
    width: 54,
    height: 54,
    borderRadius: 16,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    background: hexToRgba(accent, 0.12),
    border: `1px solid ${hexToRgba(accent, 0.26)}`,
    boxShadow: `inset 0 1px 0 rgba(255,255,255,0.12)`,
  };
}

export const cardTitle: CSSProperties = {
  fontSize: '1.02rem',
  fontWeight: 700,
  color: GLASS.text,
  letterSpacing: '-0.01em',
  marginBottom: 6,
  textShadow: '0 1px 10px rgba(0,0,0,0.45)',
};

export const cardDesc: CSSProperties = {
  fontSize: '0.82rem',
  color: GLASS.textMuted,
  lineHeight: 1.55,
};

export function cardOpenHint(accent: string): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    fontSize: '0.72rem',
    fontWeight: 700,
    color: accent,
    letterSpacing: '0.02em',
    textTransform: 'uppercase',
  };
}
