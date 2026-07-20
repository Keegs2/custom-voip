/**
 * Centralised style objects for the Account settings page.
 *
 * Presentational components import these builders/constants instead of inlining
 * big CSSProperties blocks, so the visual language (glass spacing, accent usage,
 * input chrome) lives in one place. Everything is themed off `GLASS.accent`
 * (app blue) and can be re-tinted by passing a different `accent`.
 */

import type { CSSProperties } from 'react';
import { GLASS, hexToRgba } from '../../components/glass/glass';
import type { StatusType } from './types';

// ── Hero ─────────────────────────────────────────────────────────────────────

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

export function heroBadgeDot(accent = GLASS.accent): CSSProperties {
  return { width: 7, height: 7, borderRadius: '50%', background: accent, boxShadow: `0 0 8px ${accent}` };
}

export function heroBadgeLabel(accent = GLASS.accent): CSSProperties {
  return {
    fontSize: '0.66rem',
    fontWeight: 700,
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    color: accent,
  };
}

export function heroTitle(accent = GLASS.accent): CSSProperties {
  return {
    fontSize: 'clamp(1.9rem, 3.4vw, 2.6rem)',
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
  maxWidth: 520,
  lineHeight: 1.55,
};

// ── Card chrome ──────────────────────────────────────────────────────────────

export const cardHeader: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  marginBottom: 4,
};

export function cardIconBadge(accent = GLASS.accent): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 38,
    height: 38,
    borderRadius: 11,
    flexShrink: 0,
    background: hexToRgba(accent, 0.12),
    border: `1px solid ${hexToRgba(accent, 0.26)}`,
    color: accent,
    boxShadow: `inset 0 1px 0 rgba(255,255,255,0.10)`,
  };
}

export const cardTitle: CSSProperties = {
  margin: 0,
  fontSize: '1.02rem',
  fontWeight: 700,
  color: GLASS.text,
  letterSpacing: '-0.01em',
  textShadow: '0 1px 10px rgba(0,0,0,0.45)',
};

export const cardSubtitle: CSSProperties = {
  margin: '2px 0 0',
  fontSize: '0.74rem',
  color: GLASS.textMuted,
};

/** Inner content column of a card. */
export const cardBody: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 20,
  marginTop: 18,
};

export const divider: CSSProperties = {
  height: 1,
  background: 'rgba(255,255,255,0.08)',
};

// ── Fields ───────────────────────────────────────────────────────────────────

export const fieldGroup: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

export const fieldLabel: CSSProperties = {
  fontSize: '0.68rem',
  fontWeight: 700,
  color: GLASS.textMuted,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
};

export const readOnlyValue: CSSProperties = {
  padding: '10px 13px',
  borderRadius: 10,
  background: 'rgba(8,10,15,0.42)',
  border: '1px solid rgba(255,255,255,0.08)',
  fontSize: '0.875rem',
  color: GLASS.text,
  userSelect: 'all',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
};

export const readOnlyGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
  gap: '16px 20px',
};

export function textInput(focused: boolean, disabled: boolean, accent = GLASS.accent): CSSProperties {
  return {
    width: '100%',
    boxSizing: 'border-box',
    padding: '10px 13px',
    borderRadius: 10,
    background: disabled ? 'rgba(8,10,15,0.30)' : 'rgba(8,10,15,0.42)',
    border: `1px solid ${focused ? hexToRgba(accent, 0.5) : 'rgba(255,255,255,0.10)'}`,
    boxShadow: focused
      ? `0 0 0 3px ${hexToRgba(accent, 0.13)}, inset 0 1px 0 rgba(255,255,255,0.05)`
      : 'inset 0 1px 0 rgba(255,255,255,0.04)',
    outline: 'none',
    fontSize: '0.875rem',
    fontFamily: 'inherit',
    color: disabled ? GLASS.textMuted : GLASS.text,
    transition: 'border-color 0.18s, box-shadow 0.18s',
    cursor: disabled ? 'not-allowed' : 'text',
    backdropFilter: 'blur(6px)',
    WebkitBackdropFilter: 'blur(6px)',
  };
}

// ── Status banner ────────────────────────────────────────────────────────────

export function statusBanner(type: StatusType): CSSProperties {
  const color = type === 'success' ? GLASS.success : GLASS.danger;
  return {
    padding: '11px 14px',
    borderRadius: 10,
    background: hexToRgba(color, 0.12),
    border: `1px solid ${hexToRgba(color, 0.4)}`,
    color,
    fontSize: '0.82rem',
    fontWeight: 600,
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
  };
}

// ── Form layout ──────────────────────────────────────────────────────────────

export const form: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
};

export const actionsRow: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
};

export function submitBtn(hovered: boolean, saving: boolean, accent = GLASS.accent): CSSProperties {
  return {
    padding: '9px 22px',
    borderRadius: 10,
    border: 'none',
    background: `linear-gradient(135deg, ${accent} 0%, ${hexToRgba(accent, hovered && !saving ? 0.92 : 0.78)} 100%)`,
    color: '#fff',
    fontSize: '0.82rem',
    fontWeight: 700,
    fontFamily: 'inherit',
    cursor: saving ? 'not-allowed' : 'pointer',
    opacity: saving ? 0.7 : 1,
    boxShadow: hovered && !saving
      ? `0 8px 22px -6px ${hexToRgba(accent, 0.65)}`
      : `0 4px 14px -6px ${hexToRgba(accent, 0.5)}`,
    transition: 'box-shadow 0.2s, opacity 0.18s',
  };
}
