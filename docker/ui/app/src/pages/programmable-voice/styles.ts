/**
 * Centralised style objects for the Programmable Voice glass page.
 *
 * Presentational components import these instead of inlining big CSSProperties
 * blocks. Everything is themed off `GLASS.accent` (app blue) and can be
 * re-tinted by passing a different `accent` to the builders.
 */

import type { CSSProperties } from 'react';
import { GLASS, hexToRgba } from '../../components/glass/glass';

export const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

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
  maxWidth: 620,
  lineHeight: 1.6,
};

// ── Webhook signing-secret panel ─────────────────────────────────────────────

export const secretTitleRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 9,
  marginBottom: 6,
};

export const secretTitle: CSSProperties = {
  fontSize: '0.95rem',
  fontWeight: 700,
  color: GLASS.text,
  letterSpacing: '-0.01em',
};

export const secretBlurb: CSSProperties = {
  fontSize: '0.82rem',
  color: GLASS.textMuted,
  marginBottom: 16,
  lineHeight: 1.6,
};

export const secretCode: CSSProperties = {
  fontFamily: MONO,
  color: '#cbd5e1',
};

export const secretBox: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '10px 14px',
  borderRadius: 12,
  marginBottom: 12,
  background: 'rgba(8,10,15,0.55)',
  border: '1px solid rgba(255,255,255,0.10)',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05)',
};

export const secretValue: CSSProperties = {
  flex: 1,
  fontFamily: MONO,
  fontSize: '0.85rem',
  color: GLASS.text,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export function iconBtn(active = false): CSSProperties {
  return {
    background: 'transparent',
    border: 'none',
    color: active ? GLASS.success : GLASS.textMuted,
    cursor: 'pointer',
    display: 'flex',
    padding: 2,
  };
}

export const noticeBox: CSSProperties = {
  fontSize: '0.82rem',
  color: GLASS.textMuted,
  padding: '10px 14px',
  borderRadius: 12,
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.10)',
  lineHeight: 1.55,
};

export const errBox: CSSProperties = {
  fontSize: '0.75rem',
  color: '#fca5a5',
  marginBottom: 12,
  padding: '8px 12px',
  borderRadius: 10,
  background: hexToRgba(GLASS.danger, 0.1),
  border: `1px solid ${hexToRgba(GLASS.danger, 0.28)}`,
};

export function docLink(accent = GLASS.accent): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    marginLeft: 'auto',
    fontSize: '0.75rem',
    fontWeight: 600,
    color: accent,
    textDecoration: 'none',
  };
}

// ── Webhook URL field ────────────────────────────────────────────────────────

export const fieldLabel: CSSProperties = {
  display: 'block',
  fontSize: '0.68rem',
  fontWeight: 700,
  color: GLASS.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.07em',
  marginBottom: 8,
};

export const fieldLabelOptional: CSSProperties = {
  marginLeft: 6,
  color: hexToRgba(GLASS.textMuted, 0.7),
  fontWeight: 400,
  textTransform: 'none',
  letterSpacing: 'normal',
  fontSize: '0.66rem',
};

export function urlInput(dirty: boolean, invalid: boolean, accent = GLASS.accent): CSSProperties {
  const border = invalid
    ? hexToRgba(GLASS.danger, 0.55)
    : dirty
      ? hexToRgba(accent, 0.55)
      : 'rgba(255,255,255,0.12)';
  return {
    flex: '1 1 220px',
    minWidth: 0,
    boxSizing: 'border-box',
    fontSize: '0.85rem',
    fontFamily: MONO,
    padding: '8px 12px',
    borderRadius: 10,
    border: `1px solid ${border}`,
    background: 'rgba(8,10,15,0.5)',
    color: GLASS.text,
    outline: 'none',
    boxShadow: dirty && !invalid ? `0 0 0 3px ${hexToRgba(accent, 0.16)}` : 'inset 0 1px 0 rgba(255,255,255,0.04)',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    transition: 'border-color 0.18s, box-shadow 0.18s',
  };
}

export const copyBtn: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '7px 11px',
  borderRadius: 10,
  border: '1px solid rgba(255,255,255,0.12)',
  background: 'rgba(255,255,255,0.04)',
  color: GLASS.textMuted,
  cursor: 'pointer',
  fontSize: '0.72rem',
  fontWeight: 600,
};

export function fieldHint(invalid: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginTop: 8,
    fontSize: '0.72rem',
    color: invalid ? '#fca5a5' : GLASS.textMuted,
  };
}

export const infoDot: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 14,
  height: 14,
  borderRadius: '50%',
  border: '1px solid rgba(148,163,184,0.5)',
  fontSize: '0.55rem',
  fontWeight: 700,
  flexShrink: 0,
};

// ── API DID card ─────────────────────────────────────────────────────────────

export const cardInset: CSSProperties = {
  padding: '22px 24px',
  display: 'flex',
  flexDirection: 'column',
};

export const cardHeader: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
  marginBottom: 20,
};

export const cardDid: CSSProperties = {
  fontSize: '1.2rem',
  fontWeight: 800,
  fontFamily: MONO,
  color: GLASS.text,
  letterSpacing: '0.01em',
  textShadow: '0 1px 12px rgba(0,0,0,0.5)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

export const cardSub: CSSProperties = {
  fontSize: '0.72rem',
  fontFamily: MONO,
  color: GLASS.textMuted,
  marginTop: 3,
};

export const cardSection: CSSProperties = {
  marginTop: 16,
  paddingTop: 16,
  borderTop: '1px solid rgba(255,255,255,0.06)',
};

export const cardActions: CSSProperties = {
  marginTop: 18,
  paddingTop: 16,
  borderTop: '1px solid rgba(255,255,255,0.06)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  flexWrap: 'wrap',
};

export function toggleBtn(enabled: boolean, pending: boolean): CSSProperties {
  const hue = enabled ? GLASS.danger : GLASS.success;
  return {
    background: hexToRgba(hue, 0.1),
    border: `1px solid ${hexToRgba(hue, 0.32)}`,
    borderRadius: 9,
    padding: '6px 16px',
    fontSize: '0.78rem',
    fontWeight: 600,
    color: hue,
    cursor: pending ? 'wait' : 'pointer',
    opacity: pending ? 0.6 : 1,
    fontFamily: 'inherit',
  };
}

// ── Controls bar ─────────────────────────────────────────────────────────────

export function searchWrap(focused: boolean, accent = GLASS.accent): CSSProperties {
  return {
    position: 'relative',
    flex: '1 1 260px',
    minWidth: 220,
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

// ── Stat tiles ───────────────────────────────────────────────────────────────

export const statGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, 1fr)',
  gap: 16,
  marginBottom: 24,
};

export const statInset: CSSProperties = {
  padding: '18px 20px',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

export const statValue: CSSProperties = {
  fontSize: '1.9rem',
  fontWeight: 800,
  color: GLASS.text,
  fontFamily: MONO,
  letterSpacing: '-0.01em',
  lineHeight: 1,
};

export const statLabel: CSSProperties = {
  fontSize: '0.66rem',
  fontWeight: 700,
  color: GLASS.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
};

// ── Empty state ──────────────────────────────────────────────────────────────

export function stepNum(accent = GLASS.accent): CSSProperties {
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

export function contractBox(accent = GLASS.accent): CSSProperties {
  return {
    maxWidth: 620,
    margin: '28px auto',
    textAlign: 'left',
    background: 'rgba(8,10,15,0.55)',
    border: '1px solid rgba(255,255,255,0.10)',
    borderRadius: 14,
    padding: '16px 20px',
    fontFamily: MONO,
    fontSize: '0.78rem',
    lineHeight: 1.7,
    color: GLASS.textMuted,
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05)',
    accentColor: accent,
  };
}

// ── Skeleton shimmer ─────────────────────────────────────────────────────────

export function shimmerLine(w: string | number, h: number, mb = 0): CSSProperties {
  return {
    width: w,
    height: h,
    marginBottom: mb,
    borderRadius: 6,
    background: 'linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.10) 37%, rgba(255,255,255,0.04) 63%)',
    backgroundSize: '200% 100%',
    animation: 'glass-shimmer 1.4s ease-in-out infinite',
  };
}
