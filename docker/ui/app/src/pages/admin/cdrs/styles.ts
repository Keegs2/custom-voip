/**
 * Centralised style objects for the CDRs admin feature.
 *
 * Presentational components import these instead of inlining big CSSProperties
 * blocks. Everything is themed off `GLASS.accent` (app blue) and reads clearly
 * over the app-wide liquid-glass backdrop.
 */

import type { CSSProperties } from 'react';
import { GLASS, hexToRgba } from '../../../components/glass/glass';

export const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

// ── Filter bar ───────────────────────────────────────────────────────────────

export const filterLabel: CSSProperties = {
  fontSize: '0.62rem',
  fontWeight: 700,
  color: GLASS.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
  marginBottom: 8,
  display: 'block',
};

export const filterControl: CSSProperties = {
  fontSize: '0.85rem',
  padding: '9px 12px',
  height: 38,
  borderRadius: 10,
  border: '1px solid rgba(255,255,255,0.10)',
  background: 'rgba(255,255,255,0.04)',
  color: GLASS.text,
  outline: 'none',
  fontFamily: 'inherit',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
  transition: 'border-color 0.18s, box-shadow 0.18s',
};

export const filterSelect: CSSProperties = {
  ...filterControl,
  cursor: 'pointer',
  appearance: 'none',
  paddingRight: 32,
  backgroundImage:
    "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none' stroke='%2394a3b8' stroke-width='1.6'><path d='M3 4.5L6 7.5L9 4.5'/></svg>\")",
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 12px center',
};

export const checkboxLabel: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  cursor: 'pointer',
  fontSize: '0.85rem',
  color: GLASS.textMuted,
  whiteSpace: 'nowrap',
  userSelect: 'none',
  height: 38,
};

// ── Stat tiles ───────────────────────────────────────────────────────────────

export const statTile: CSSProperties = {
  flex: '1 1 96px',
  minWidth: 96,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 6,
  padding: '12px 16px',
  borderRadius: 14,
  background: 'rgba(255,255,255,0.035)',
  border: '1px solid rgba(255,255,255,0.08)',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
};

export const statLabel: CSSProperties = {
  fontSize: '0.6rem',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
  color: GLASS.textMuted,
  whiteSpace: 'nowrap',
};

export function statValue(accent?: string): CSSProperties {
  return {
    fontSize: '1.05rem',
    fontWeight: 800,
    fontVariantNumeric: 'tabular-nums',
    fontFamily: MONO,
    lineHeight: 1,
    color: accent ?? GLASS.text,
    textShadow: accent ? `0 0 14px ${hexToRgba(accent, 0.3)}` : '0 1px 8px rgba(0,0,0,0.5)',
  };
}

// ── Group-by toggle (summary view) ───────────────────────────────────────────

export function groupBtn(active: boolean, accent = GLASS.accent): CSSProperties {
  return {
    padding: '6px 16px',
    fontSize: '0.78rem',
    fontWeight: 700,
    borderRadius: 10,
    border: `1px solid ${active ? hexToRgba(accent, 0.4) : 'rgba(255,255,255,0.10)'}`,
    background: active ? hexToRgba(accent, 0.14) : 'rgba(255,255,255,0.03)',
    color: active ? accent : GLASS.textMuted,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'all 0.18s',
  };
}

// ── States ───────────────────────────────────────────────────────────────────

export function stateIcon(accent = GLASS.accent): CSSProperties {
  return {
    width: 52,
    height: 52,
    borderRadius: 16,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: hexToRgba(accent, 0.1),
    border: `1px solid ${hexToRgba(accent, 0.22)}`,
    color: accent,
  };
}

export function spinnerRing(accent = GLASS.accent): CSSProperties {
  return {
    width: 14,
    height: 14,
    borderRadius: '50%',
    border: `2px solid ${hexToRgba(accent, 0.25)}`,
    borderTopColor: accent,
    animation: 'glass-spin 0.7s linear infinite',
    display: 'inline-block',
  };
}

export function shimmerBlock(h: number): CSSProperties {
  return {
    height: h,
    borderRadius: 10,
    background: 'linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.10) 37%, rgba(255,255,255,0.04) 63%)',
    backgroundSize: '200% 100%',
    animation: 'glass-shimmer 1.4s ease-in-out infinite',
  };
}

// ── Tables ───────────────────────────────────────────────────────────────────

export const monoFaint: CSSProperties = {
  fontFamily: MONO,
  fontSize: '0.78rem',
  color: GLASS.textMuted,
  whiteSpace: 'nowrap',
};
