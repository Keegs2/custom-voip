/**
 * Centralised style objects for the Customers admin glass page.
 *
 * Presentational components import these instead of inlining big CSSProperties
 * blocks. Everything is themed off `GLASS.accent` (app blue) and can be
 * re-tinted via an `accent` argument to the builders. Mirrors the convention in
 * `pages/rcf-glass/styles.ts`.
 */

import type { CSSProperties } from 'react';
import { GLASS, hexToRgba } from '../../../components/glass/glass';

export const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

// ── Controls bar ─────────────────────────────────────────────────────────────

export function searchWrap(focused: boolean, accent = GLASS.accent): CSSProperties {
  return {
    position: 'relative',
    flex: '1 1 240px',
    minWidth: 200,
    maxWidth: 440,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '9px 14px',
    borderRadius: 12,
    background: 'rgba(255,255,255,0.04)',
    border: `1px solid ${focused ? hexToRgba(accent, 0.45) : 'rgba(255,255,255,0.10)'}`,
    boxShadow: focused
      ? `0 0 0 3px ${hexToRgba(accent, 0.12)}, inset 0 1px 0 rgba(255,255,255,0.08)`
      : 'inset 0 1px 0 rgba(255,255,255,0.06)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    transition: 'border-color 0.18s, box-shadow 0.18s',
  };
}

export const searchInput: CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: 'transparent',
  border: 'none',
  outline: 'none',
  color: GLASS.text,
  fontSize: '0.85rem',
  fontFamily: 'inherit',
};

// ── Create form ──────────────────────────────────────────────────────────────

export function formEyebrow(accent = GLASS.accent): CSSProperties {
  return {
    fontSize: '0.62rem',
    fontWeight: 700,
    color: accent,
    textTransform: 'uppercase',
    letterSpacing: '0.12em',
    marginBottom: 18,
  };
}

/** The add-on toggle row (UCaaS / Voicemail). `on` drives the active tint. */
export function toggleRow(on: boolean, accent: string): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginTop: 16,
    padding: '12px 16px',
    background: on ? hexToRgba(accent, 0.08) : 'rgba(255,255,255,0.02)',
    border: `1px solid ${on ? hexToRgba(accent, 0.28) : 'rgba(255,255,255,0.08)'}`,
    borderRadius: 12,
    transition: 'background 0.15s, border-color 0.15s',
    cursor: 'pointer',
    userSelect: 'none',
  };
}

export function toggleLabel(on: boolean, accent: string): CSSProperties {
  return {
    fontSize: '0.82rem',
    fontWeight: 600,
    color: on ? accent : GLASS.textMuted,
    cursor: 'pointer',
    transition: 'color 0.15s',
  };
}

export const toggleHint: CSSProperties = {
  fontSize: '0.72rem',
  color: GLASS.textFaint,
  marginLeft: 4,
};

export const formActions: CSSProperties = {
  display: 'flex',
  gap: 8,
  marginTop: 22,
  paddingTop: 20,
  borderTop: '1px solid rgba(255,255,255,0.08)',
};

// ── Table ────────────────────────────────────────────────────────────────────

export const th: CSSProperties = {
  textAlign: 'left',
  fontSize: '0.62rem',
  fontWeight: 700,
  color: GLASS.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  padding: '13px 16px',
  whiteSpace: 'nowrap',
};

export const td: CSSProperties = {
  padding: '13px 16px',
  borderTop: '1px solid rgba(255,255,255,0.05)',
  verticalAlign: 'middle',
};

export const emptyCell: CSSProperties = {
  padding: '48px 16px',
  textAlign: 'center',
  color: GLASS.textMuted,
  fontSize: '0.875rem',
};

// ── States ───────────────────────────────────────────────────────────────────

export function shimmerLine(w: string | number, h: number): CSSProperties {
  return {
    width: w,
    height: h,
    borderRadius: 6,
    background:
      'linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.10) 37%, rgba(255,255,255,0.04) 63%)',
    backgroundSize: '200% 100%',
    animation: 'glass-shimmer 1.4s ease-in-out infinite',
  };
}

export function stateIcon(accent = GLASS.accent): CSSProperties {
  return {
    width: 56,
    height: 56,
    borderRadius: 16,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: hexToRgba(accent, 0.1),
    border: `1px solid ${hexToRgba(accent, 0.22)}`,
    color: accent,
  };
}
