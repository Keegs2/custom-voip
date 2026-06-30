/**
 * Centralised style objects for the SIP Trunks glass page.
 *
 * Presentational components import these instead of inlining big CSSProperties
 * blocks. Everything is themed off `GLASS.accent` (app blue) and re-tints by
 * passing a different `accent` to the builders (e.g. `GLASS.textFaint` to fade a
 * disabled trunk).
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
  lineHeight: 1.55,
};

// ── Controls bar ─────────────────────────────────────────────────────────────

export function searchWrap(focused: boolean, accent = GLASS.accent): CSSProperties {
  return {
    position: 'relative',
    flex: '1 1 260px',
    minWidth: 200,
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

export const statTileLabel: CSSProperties = {
  fontSize: '0.62rem',
  fontWeight: 700,
  color: GLASS.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
};

export const statTileValue: CSSProperties = {
  fontSize: '1.5rem',
  fontWeight: 800,
  color: GLASS.text,
  lineHeight: 1.05,
  fontVariantNumeric: 'tabular-nums',
  textShadow: '0 1px 12px rgba(0,0,0,0.45)',
};

export const statTileSub: CSSProperties = {
  fontSize: '0.95rem',
  fontWeight: 500,
  color: GLASS.textMuted,
};

// ── Section label ────────────────────────────────────────────────────────────

export const sectionLabel: CSSProperties = {
  fontSize: '0.66rem',
  fontWeight: 700,
  color: GLASS.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.09em',
  margin: '0 0 10px',
};

export const sectionLabelHint: CSSProperties = {
  fontWeight: 400,
  textTransform: 'none',
  letterSpacing: 'normal',
  color: GLASS.textFaint,
};

// ── Trunk card header ────────────────────────────────────────────────────────

export const trunkName: CSSProperties = {
  fontSize: '1.1rem',
  fontWeight: 700,
  color: GLASS.text,
  letterSpacing: '-0.01em',
  textShadow: '0 1px 10px rgba(0,0,0,0.5)',
};

export const trunkMeta: CSSProperties = {
  fontSize: '0.74rem',
  color: GLASS.textMuted,
  marginTop: 6,
  display: 'flex',
  flexWrap: 'wrap',
  gap: '0 6px',
};

export function authPill(accent = GLASS.accent): CSSProperties {
  return {
    background: hexToRgba(accent, 0.12),
    border: `1px solid ${hexToRgba(accent, 0.28)}`,
    borderRadius: 6,
    padding: '2px 8px',
    fontSize: '0.6rem',
    fontWeight: 700,
    color: accent,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    whiteSpace: 'nowrap',
  };
}

export function expandToggle(hovered: boolean): CSSProperties {
  return {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: '11px 20px',
    fontSize: '0.74rem',
    fontWeight: 600,
    color: hovered ? GLASS.text : GLASS.textMuted,
    borderTop: '1px solid rgba(255,255,255,0.07)',
    background: hovered ? 'rgba(255,255,255,0.03)' : 'transparent',
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'background 0.15s, color 0.15s',
  };
}

export const detailWrap: CSSProperties = {
  borderTop: '1px solid rgba(255,255,255,0.07)',
  padding: '22px 24px',
  display: 'flex',
  flexDirection: 'column',
  gap: 24,
  background: 'rgba(8,10,15,0.35)',
};

// ── Config summary ───────────────────────────────────────────────────────────

export const configCard: CSSProperties = {
  background: 'rgba(8,10,15,0.4)',
  border: '1px solid rgba(255,255,255,0.07)',
  borderRadius: 12,
  padding: '8px 18px',
};

export const configRow: CSSProperties = {
  display: 'flex',
  gap: 16,
  alignItems: 'baseline',
  padding: '7px 0',
  borderBottom: '1px solid rgba(255,255,255,0.05)',
};

export const configLabel: CSSProperties = {
  minWidth: 130,
  fontSize: '0.78rem',
  color: GLASS.textMuted,
  flexShrink: 0,
};

export const configValue: CSSProperties = {
  fontSize: '0.82rem',
  color: GLASS.text,
  fontFamily: MONO,
  wordBreak: 'break-all',
};

export const infoNote: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  marginTop: 10,
  fontSize: '0.72rem',
  color: GLASS.textMuted,
};

export const infoBadge: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 14,
  height: 14,
  borderRadius: '50%',
  border: `1px solid ${hexToRgba(GLASS.textMuted, 0.5)}`,
  fontSize: '0.55rem',
  fontWeight: 700,
  flexShrink: 0,
};

// ── Authorized IPs ───────────────────────────────────────────────────────────

export const ipRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  background: 'rgba(8,10,15,0.45)',
  border: '1px solid rgba(255,255,255,0.07)',
  borderRadius: 9,
  padding: '8px 12px',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
};

export const ipMono: CSSProperties = {
  fontFamily: MONO,
  fontSize: '0.82rem',
  color: GLASS.text,
  flex: 1,
};

export const ipDesc: CSSProperties = {
  fontSize: '0.74rem',
  color: GLASS.textMuted,
};

export function ipInput(invalid: boolean, width = 160): CSSProperties {
  return {
    fontSize: '0.82rem',
    fontFamily: MONO,
    padding: '8px 11px',
    borderRadius: 9,
    border: `1px solid ${invalid ? hexToRgba(GLASS.danger, 0.55) : 'rgba(255,255,255,0.10)'}`,
    background: 'rgba(8,10,15,0.5)',
    color: GLASS.text,
    outline: 'none',
    width,
    boxShadow: invalid ? `0 0 0 3px ${hexToRgba(GLASS.danger, 0.12)}` : 'none',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
  };
}

export function deleteX(hovered: boolean): CSSProperties {
  return {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: hovered ? GLASS.danger : GLASS.textMuted,
    fontSize: '1.05rem',
    lineHeight: 1,
    padding: '0 2px',
    transition: 'color 0.15s',
    fontFamily: 'inherit',
  };
}

// ── DID chips ────────────────────────────────────────────────────────────────

export function didChip(enabled: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: '0.78rem',
    fontFamily: MONO,
    fontWeight: 600,
    background: 'rgba(255,255,255,0.04)',
    color: enabled ? GLASS.text : GLASS.textMuted,
    border: '1px solid rgba(255,255,255,0.10)',
    padding: '5px 11px',
    borderRadius: 8,
    textDecoration: enabled ? 'none' : 'line-through',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
  };
}

// ── Buttons / misc ───────────────────────────────────────────────────────────

export function refreshBtn(busy: boolean, accent = GLASS.accent): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    background: hexToRgba(accent, 0.1),
    border: `1px solid ${hexToRgba(accent, 0.26)}`,
    borderRadius: 9,
    padding: '5px 12px',
    fontSize: '0.7rem',
    fontWeight: 600,
    color: accent,
    cursor: busy ? 'wait' : 'pointer',
    opacity: busy ? 0.6 : 1,
    fontFamily: 'inherit',
  };
}

export function spinner(accent = GLASS.accent, size = 13): CSSProperties {
  return {
    width: size,
    height: size,
    borderRadius: '50%',
    border: `2px solid ${hexToRgba(accent, 0.25)}`,
    borderTopColor: accent,
    animation: 'glass-spin 0.7s linear infinite',
    display: 'inline-block',
    flexShrink: 0,
  };
}

export function howItWorksStep(accent = GLASS.accent): CSSProperties {
  return {
    flexShrink: 0,
    width: 32,
    height: 32,
    borderRadius: 10,
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

export function stateIcon(accent = GLASS.accent): CSSProperties {
  return {
    width: 60,
    height: 60,
    borderRadius: 16,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: hexToRgba(accent, 0.12),
    border: `1px solid ${hexToRgba(accent, 0.24)}`,
    color: accent,
  };
}

// ── Shimmer (skeletons) ──────────────────────────────────────────────────────

export function shimmerLine(w: string | number, h: number, mb = 0): CSSProperties {
  return {
    width: w,
    height: h,
    marginBottom: mb,
    borderRadius: 6,
    background:
      'linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.10) 37%, rgba(255,255,255,0.04) 63%)',
    backgroundSize: '200% 100%',
    animation: 'glass-shimmer 1.4s ease-in-out infinite',
  };
}
