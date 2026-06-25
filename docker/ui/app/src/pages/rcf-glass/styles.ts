/**
 * Centralised style objects for the RCF glass reference page.
 *
 * Presentational components import these instead of inlining big CSSProperties
 * blocks, so the visual language (spacing, accent usage, mono font) lives in one
 * place. Parameterised styles are exported as small builder functions; static
 * ones as constants. Everything is themed off `GLASS.accent` (app blue) and can
 * be re-tinted by passing a different `accent` to the builders.
 */

import type { CSSProperties } from 'react';
import { GLASS, hexToRgba } from '../../components/glass/glass';

export const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

// ── ForwardToEditor ──────────────────────────────────────────────────────────

export function editorInput(big: boolean, pending: boolean, accent = GLASS.accent): CSSProperties {
  return {
    flex: 1,
    minWidth: 0,
    boxSizing: 'border-box',
    fontSize: big ? '1.35rem' : '0.9rem',
    fontWeight: 700,
    fontFamily: MONO,
    letterSpacing: '0.02em',
    padding: big ? '10px 14px' : '6px 10px',
    borderRadius: big ? 12 : 8,
    border: `1px solid ${hexToRgba(accent, 0.6)}`,
    background: 'rgba(8,10,15,0.55)',
    color: accent,
    outline: 'none',
    boxShadow: `0 0 0 3px ${hexToRgba(accent, 0.14)}, inset 0 1px 0 rgba(255,255,255,0.06)`,
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    opacity: pending ? 0.6 : 1,
  };
}

export function editorSaveBtn(big: boolean, pending: boolean, accent = GLASS.accent): CSSProperties {
  return {
    flex: big ? 1 : undefined,
    padding: big ? '9px 0' : '6px 14px',
    borderRadius: big ? 10 : 8,
    border: 'none',
    background: `linear-gradient(135deg, ${accent} 0%, ${hexToRgba(accent, 0.78)} 100%)`,
    color: '#fff',
    fontSize: '0.78rem',
    fontWeight: 700,
    cursor: pending ? 'not-allowed' : 'pointer',
    fontFamily: 'inherit',
    boxShadow: `0 6px 18px -6px ${hexToRgba(accent, 0.6)}`,
    opacity: pending ? 0.7 : 1,
  };
}

export function editorCancelBtn(big: boolean): CSSProperties {
  return {
    padding: big ? '9px 16px' : '6px 12px',
    borderRadius: big ? 10 : 8,
    border: '1px solid rgba(255,255,255,0.10)',
    background: 'rgba(255,255,255,0.04)',
    color: GLASS.textMuted,
    fontSize: '0.78rem',
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  };
}

export function editorValue(big: boolean, flash: boolean, accent = GLASS.accent): CSSProperties {
  return {
    fontSize: big ? '1.5rem' : '0.92rem',
    fontWeight: big ? 800 : 700,
    fontFamily: MONO,
    letterSpacing: '0.02em',
    color: flash ? '#bfdbfe' : accent,
    textShadow: flash
      ? `0 0 18px ${hexToRgba(accent, 0.5)}`
      : `0 0 12px ${hexToRgba(accent, big ? 0.28 : 0.18)}`,
    transition: 'color 0.25s, text-shadow 0.25s',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };
}

export function editorPencil(big: boolean, hovered: boolean, accent = GLASS.accent): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: big ? 26 : 22,
    height: big ? 26 : 22,
    borderRadius: 8,
    opacity: hovered ? 1 : 0,
    background: hexToRgba(accent, 0.12),
    border: `1px solid ${hexToRgba(accent, 0.24)}`,
    transition: 'opacity 0.18s',
    flexShrink: 0,
  };
}

// ── GlassRcfCard ─────────────────────────────────────────────────────────────

export const cardBody: CSSProperties = {
  padding: '20px 22px 18px',
  display: 'flex',
  flexDirection: 'column',
};

export const cardDid: CSSProperties = {
  fontSize: '1.5rem',
  fontWeight: 800,
  fontFamily: MONO,
  letterSpacing: '0.01em',
  color: GLASS.text,
  lineHeight: 1.15,
  textShadow: '0 1px 12px rgba(0,0,0,0.5)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

export const cardName: CSSProperties = {
  fontSize: '0.68rem',
  fontWeight: 600,
  color: GLASS.textMuted,
  letterSpacing: '0.04em',
  marginBottom: 4,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

export function dividerLine(toRight: boolean, accent = GLASS.accent): CSSProperties {
  const stop = hexToRgba(accent, 0.28);
  return {
    flex: 1,
    height: 1,
    background: toRight
      ? `linear-gradient(90deg, transparent, ${stop})`
      : `linear-gradient(90deg, ${stop}, transparent)`,
  };
}

export function forwardsPill(accent = GLASS.accent): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    padding: '3px 11px',
    borderRadius: 999,
    background: hexToRgba(accent, 0.07),
    border: `1px solid ${hexToRgba(accent, 0.16)}`,
  };
}

export function forwardsPillLabel(accent = GLASS.accent): CSSProperties {
  return {
    fontSize: '0.54rem',
    fontWeight: 700,
    color: hexToRgba(accent, 0.7),
    textTransform: 'uppercase',
    letterSpacing: '0.12em',
  };
}

// ── GlassTable ───────────────────────────────────────────────────────────────

export const th: CSSProperties = {
  textAlign: 'left',
  fontSize: '0.62rem',
  fontWeight: 700,
  color: GLASS.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  padding: '12px 18px',
  whiteSpace: 'nowrap',
};

export const td: CSSProperties = {
  padding: '13px 18px',
  fontSize: '0.85rem',
  color: GLASS.text,
  borderTop: '1px solid rgba(255,255,255,0.05)',
  verticalAlign: 'middle',
};

// ── Controls bar ─────────────────────────────────────────────────────────────

export function searchWrap(focused: boolean, accent = GLASS.accent): CSSProperties {
  return {
    position: 'relative',
    flex: '1 1 240px',
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

export const selectStyle: CSSProperties = {
  appearance: 'none',
  padding: '9px 32px 9px 14px',
  borderRadius: 12,
  border: '1px solid rgba(255,255,255,0.10)',
  background:
    'rgba(255,255,255,0.04) url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'12\' height=\'12\' viewBox=\'0 0 12 12\' fill=\'none\' stroke=\'%2394a3b8\' stroke-width=\'1.6\'><path d=\'M3 4.5L6 7.5L9 4.5\'/></svg>") no-repeat right 12px center',
  color: GLASS.text,
  fontSize: '0.82rem',
  fontFamily: 'inherit',
  outline: 'none',
  cursor: 'pointer',
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
};

export const viewToggleWrap: CSSProperties = {
  display: 'inline-flex',
  gap: 4,
  padding: 4,
  borderRadius: 12,
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.10)',
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
};

export function viewToggleBtn(active: boolean, accent = GLASS.accent): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '7px 12px',
    borderRadius: 9,
    border: 'none',
    background: active ? hexToRgba(accent, 0.16) : 'transparent',
    color: active ? accent : GLASS.textMuted,
    fontSize: '0.76rem',
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
    boxShadow: active ? `inset 0 0 0 1px ${hexToRgba(accent, 0.3)}` : 'none',
    transition: 'background 0.18s, color 0.18s',
  };
}

export function spinner(accent = GLASS.accent): CSSProperties {
  return {
    width: 13,
    height: 13,
    borderRadius: '50%',
    border: `2px solid ${hexToRgba(accent, 0.25)}`,
    borderTopColor: accent,
    animation: 'glass-spin 0.7s linear infinite',
    display: 'inline-block',
  };
}

// ── States / skeletons ───────────────────────────────────────────────────────

export function shimmerLine(w: string | number, h: number, mb: number): CSSProperties {
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

export function loadMoreBtn(hovered: boolean, accent = GLASS.accent): CSSProperties {
  return {
    padding: '11px 24px',
    borderRadius: 12,
    border: `1px solid ${hovered ? hexToRgba(accent, 0.4) : 'rgba(255,255,255,0.12)'}`,
    background: hovered ? hexToRgba(accent, 0.1) : 'rgba(255,255,255,0.04)',
    color: hovered ? accent : GLASS.text,
    fontSize: '0.82rem',
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    boxShadow: hovered ? `0 0 24px -8px ${hexToRgba(accent, 0.5)}` : 'none',
    transition: 'all 0.2s ease',
  };
}

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
  maxWidth: 560,
  lineHeight: 1.55,
};
