/**
 * Centralised style objects for the Calendar feature (blue liquid-glass theme).
 *
 * Presentational components import these instead of inlining large CSSProperties
 * blocks. Parameterised styles are exported as builder functions; static ones as
 * constants. Everything is themed off `GLASS.accent` (app blue) and can be
 * re-tinted by passing a different `accent` to the builders.
 */

import type { CSSProperties } from 'react';
import { GLASS, hexToRgba } from '../../components/glass/glass';

/* ── Hero ──────────────────────────────────────────────────────────────────── */

export function heroBadge(accent = GLASS.accent): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
    padding: '5px 12px',
    borderRadius: 999,
    background: hexToRgba(accent, 0.08),
    border: `1px solid ${hexToRgba(accent, 0.22)}`,
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
  };
}

export function heroTitle(accent = GLASS.accent): CSSProperties {
  return {
    fontSize: 'clamp(2rem, 4vw, 2.9rem)',
    fontWeight: 800,
    letterSpacing: '-0.02em',
    lineHeight: 1.05,
    margin: 0,
    color: GLASS.text,
    background: `linear-gradient(120deg, #ffffff 0%, ${GLASS.text} 35%, ${hexToRgba(accent, 0.85)} 110%)`,
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
  };
}

export const heroSubtitle: CSSProperties = {
  margin: '10px 0 0',
  fontSize: '0.95rem',
  color: GLASS.textMuted,
  maxWidth: 600,
  lineHeight: 1.55,
};

export function heroEmail(accent = GLASS.accent): CSSProperties {
  return {
    margin: '8px 0 0',
    fontSize: '0.78rem',
    color: accent,
    fontWeight: 600,
    letterSpacing: '0.01em',
  };
}

/* ── Controls bar ──────────────────────────────────────────────────────────── */

export const controlsRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 12,
};

export const navCluster: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

export const navTitle: CSSProperties = {
  fontSize: '0.95rem',
  fontWeight: 700,
  color: GLASS.text,
  marginLeft: 6,
  letterSpacing: '-0.01em',
  textShadow: '0 1px 10px rgba(0,0,0,0.5)',
};

export const navIconBtn: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 32,
  height: 32,
  borderRadius: 9,
  border: '1px solid rgba(255,255,255,0.10)',
  background: 'rgba(255,255,255,0.04)',
  color: GLASS.textMuted,
  cursor: 'pointer',
  padding: 0,
  backdropFilter: 'blur(10px)',
  WebkitBackdropFilter: 'blur(10px)',
  transition: 'color 0.15s, border-color 0.15s, background 0.15s',
};

export const todayBtn: CSSProperties = {
  padding: '7px 14px',
  borderRadius: 9,
  border: '1px solid rgba(255,255,255,0.10)',
  background: 'rgba(255,255,255,0.04)',
  color: GLASS.text,
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: '0.76rem',
  fontWeight: 600,
  backdropFilter: 'blur(10px)',
  WebkitBackdropFilter: 'blur(10px)',
};

export const segGroup: CSSProperties = {
  display: 'flex',
  gap: 3,
  padding: 4,
  borderRadius: 12,
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.10)',
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
};

export function segBtn(active: boolean, accent = GLASS.accent): CSSProperties {
  return {
    padding: '6px 14px',
    borderRadius: 9,
    border: 'none',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: '0.76rem',
    fontWeight: active ? 700 : 600,
    color: active ? accent : GLASS.textMuted,
    background: active ? hexToRgba(accent, 0.16) : 'transparent',
    boxShadow: active ? `inset 0 0 0 1px ${hexToRgba(accent, 0.3)}` : 'none',
    transition: 'background 0.15s, color 0.15s',
    whiteSpace: 'nowrap',
  };
}

export function spinner(accent = GLASS.accent): CSSProperties {
  return {
    width: 14,
    height: 14,
    borderRadius: '50%',
    border: `2px solid ${hexToRgba(accent, 0.25)}`,
    borderTopColor: accent,
    animation: 'glass-spin 0.7s linear infinite',
    display: 'inline-block',
    flexShrink: 0,
  };
}

/* ── Legend ────────────────────────────────────────────────────────────────── */

export const legendRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 18,
  flexWrap: 'wrap',
};

export const legendItem: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
};

export function legendDot(color: string): CSSProperties {
  return {
    width: 10,
    height: 10,
    borderRadius: 3,
    background: color,
    boxShadow: `0 0 8px ${hexToRgba(color, 0.6)}`,
    flexShrink: 0,
  };
}

export const legendLabel: CSSProperties = {
  fontSize: '0.72rem',
  color: GLASS.textMuted,
  fontWeight: 600,
};

/* ── States ────────────────────────────────────────────────────────────────── */

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

export function bannerStyle(color: string): CSSProperties {
  return {
    padding: '11px 16px',
    borderRadius: 12,
    background: hexToRgba(color, 0.08),
    border: `1px solid ${hexToRgba(color, 0.26)}`,
    color,
    fontSize: '0.8rem',
    fontWeight: 500,
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
  };
}

/* ── Connections bar ───────────────────────────────────────────────────────── */

export const connectLabel: CSSProperties = {
  fontSize: '0.62rem',
  fontWeight: 700,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: GLASS.textMuted,
  marginRight: 4,
};

export function connectionChip(needsReauth: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 9,
    padding: '5px 6px 5px 12px',
    borderRadius: 11,
    background: 'rgba(255,255,255,0.04)',
    border: `1px solid ${needsReauth ? hexToRgba(GLASS.warning, 0.34) : 'rgba(255,255,255,0.10)'}`,
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
  };
}

export function statusDot(color: string): CSSProperties {
  return {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: color,
    flexShrink: 0,
    boxShadow: `0 0 6px ${color}`,
  };
}

export function disconnectBtn(): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 24,
    height: 24,
    borderRadius: 7,
    border: '1px solid rgba(255,255,255,0.10)',
    background: 'transparent',
    color: GLASS.textMuted,
    cursor: 'pointer',
    flexShrink: 0,
    padding: 0,
    transition: 'color 0.15s, background 0.15s, border-color 0.15s',
  };
}

/* ── Empty state ───────────────────────────────────────────────────────────── */

export function emptyIcon(accent = GLASS.accent): CSSProperties {
  return {
    width: 60,
    height: 60,
    borderRadius: 16,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
    background: `linear-gradient(135deg, ${hexToRgba(accent, 0.16)} 0%, ${hexToRgba(accent, 0.05)} 100%)`,
    border: `1px solid ${hexToRgba(accent, 0.26)}`,
    color: accent,
  };
}

export const emptyTitle: CSSProperties = {
  fontSize: '1.35rem',
  fontWeight: 800,
  color: GLASS.text,
  margin: '0 0 8px',
};

export const emptyLead: CSSProperties = {
  fontSize: '0.9rem',
  color: GLASS.textMuted,
  maxWidth: 560,
  margin: '0 auto 8px',
  lineHeight: 1.6,
};

export const stepsGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: 22,
  maxWidth: 720,
  margin: '32px auto',
  textAlign: 'left',
};

export function stepBadge(accent = GLASS.accent): CSSProperties {
  return {
    flexShrink: 0,
    width: 30,
    height: 30,
    borderRadius: 9,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: hexToRgba(accent, 0.12),
    border: `1px solid ${hexToRgba(accent, 0.3)}`,
    color: accent,
    fontWeight: 800,
    fontSize: '0.85rem',
  };
}

export function privacyPill(accent = GLASS.accent): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    padding: '6px 14px',
    borderRadius: 999,
    background: hexToRgba(accent, 0.08),
    border: `1px solid ${hexToRgba(accent, 0.24)}`,
    color: accent,
    fontSize: '0.74rem',
    fontWeight: 600,
    marginBottom: 24,
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
  };
}

/* ── Event detail slide-over ───────────────────────────────────────────────── */

export const detailFieldLabel: CSSProperties = {
  fontSize: '0.6rem',
  fontWeight: 700,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: GLASS.textMuted,
  marginBottom: 6,
};

export function joinButton(accent = GLASS.accent): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: '10px 16px',
    borderRadius: 11,
    background: `linear-gradient(135deg, ${accent} 0%, ${hexToRgba(accent, 0.78)} 100%)`,
    color: '#fff',
    fontSize: '0.82rem',
    fontWeight: 700,
    textDecoration: 'none',
    boxShadow: `0 6px 18px -6px ${hexToRgba(accent, 0.6)}`,
  };
}
