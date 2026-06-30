/**
 * Centralised style objects + builders for the Call Quality page.
 *
 * Presentational components import these instead of inlining big CSSProperties
 * blocks. Everything is themed off `GLASS.accent` (app blue); semantic quality
 * hues are passed in per-call where a status colour is required.
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
  maxWidth: 560,
  lineHeight: 1.55,
};

// ── Section header ───────────────────────────────────────────────────────────

export function sectionLabel(accent = GLASS.accent): CSSProperties {
  return {
    fontSize: '0.62rem',
    fontWeight: 700,
    color: accent,
    textTransform: 'uppercase',
    letterSpacing: '0.12em',
  };
}

// ── Filter bar form controls ─────────────────────────────────────────────────

export const fieldLabel: CSSProperties = {
  fontSize: '0.6rem',
  fontWeight: 700,
  color: GLASS.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.09em',
  marginBottom: 6,
  display: 'block',
};

export function inputStyle(focused: boolean, accent = GLASS.accent): CSSProperties {
  return {
    width: '100%',
    boxSizing: 'border-box',
    padding: '8px 12px',
    fontSize: '0.82rem',
    borderRadius: 10,
    border: `1px solid ${focused ? hexToRgba(accent, 0.45) : 'rgba(255,255,255,0.10)'}`,
    background: 'rgba(255,255,255,0.04)',
    color: GLASS.text,
    outline: 'none',
    fontFamily: 'inherit',
    boxShadow: focused
      ? `0 0 0 3px ${hexToRgba(accent, 0.12)}, inset 0 1px 0 rgba(255,255,255,0.06)`
      : 'inset 0 1px 0 rgba(255,255,255,0.05)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    transition: 'border-color 0.18s, box-shadow 0.18s',
  };
}

export function selectStyle(focused: boolean, accent = GLASS.accent): CSSProperties {
  return {
    ...inputStyle(focused, accent),
    appearance: 'none',
    cursor: 'pointer',
    paddingRight: 32,
    background:
      'rgba(255,255,255,0.04) url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'12\' height=\'12\' viewBox=\'0 0 12 12\' fill=\'none\' stroke=\'%2394a3b8\' stroke-width=\'1.6\'><path d=\'M3 4.5L6 7.5L9 4.5\'/></svg>") no-repeat right 12px center',
  };
}

// ── Pill selector ────────────────────────────────────────────────────────────

export function pillBtn(active: boolean, accent = GLASS.accent): CSSProperties {
  return {
    padding: '5px 14px',
    fontSize: '0.72rem',
    fontWeight: active ? 700 : 500,
    borderRadius: 999,
    border: active ? `1px solid ${hexToRgba(accent, 0.45)}` : '1px solid rgba(255,255,255,0.10)',
    background: active ? hexToRgba(accent, 0.16) : 'rgba(255,255,255,0.03)',
    color: active ? accent : GLASS.textMuted,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'all 0.15s',
  };
}

// ── Action buttons ───────────────────────────────────────────────────────────

export function primaryBtn(disabled: boolean, accent = GLASS.accent): CSSProperties {
  return {
    padding: '9px 22px',
    fontSize: '0.82rem',
    fontWeight: 700,
    borderRadius: 10,
    border: 'none',
    background: `linear-gradient(135deg, ${accent} 0%, ${hexToRgba(accent, 0.78)} 100%)`,
    color: '#fff',
    cursor: disabled ? 'not-allowed' : 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    opacity: disabled ? 0.65 : 1,
    boxShadow: `0 8px 22px -8px ${hexToRgba(accent, 0.6)}`,
    fontFamily: 'inherit',
    transition: 'all 0.15s',
  };
}

export function ghostBtn(hovered: boolean): CSSProperties {
  return {
    padding: '9px 18px',
    fontSize: '0.82rem',
    fontWeight: 600,
    borderRadius: 10,
    border: `1px solid ${hovered ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.10)'}`,
    background: hovered ? 'rgba(255,255,255,0.06)' : 'transparent',
    color: hovered ? GLASS.text : GLASS.textMuted,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'all 0.15s',
  };
}

// ── Overview stat tile ───────────────────────────────────────────────────────

export function statTile(accent: string): CSSProperties {
  return {
    flex: '1 1 150px',
    minWidth: 0,
    position: 'relative',
    overflow: 'hidden',
    borderRadius: 14,
    padding: '16px 20px',
    background: 'rgba(255,255,255,0.035)',
    border: '1px solid rgba(255,255,255,0.09)',
    boxShadow: `inset 0 1px 0 rgba(255,255,255,0.08), 0 0 28px -16px ${hexToRgba(accent, 0.6)}`,
    backdropFilter: 'blur(14px)',
    WebkitBackdropFilter: 'blur(14px)',
  };
}

export function statTileEdge(accent: string): CSSProperties {
  return {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 2,
    background: `linear-gradient(90deg, transparent, ${accent}, transparent)`,
    opacity: 0.7,
  };
}

export const statTileLabel: CSSProperties = {
  fontSize: '0.58rem',
  fontWeight: 700,
  color: GLASS.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
  marginBottom: 8,
};

export function statTileValue(accent: string): CSSProperties {
  return {
    fontSize: '1.35rem',
    fontWeight: 800,
    color: accent,
    fontVariantNumeric: 'tabular-nums',
    lineHeight: 1.1,
    textShadow: `0 0 18px ${hexToRgba(accent, 0.35)}`,
  };
}

export const statTileSub: CSSProperties = {
  fontSize: '0.65rem',
  color: GLASS.textMuted,
  marginTop: 4,
};

// ── Inline state row (loading / empty inside a panel) ────────────────────────

export const inlineState: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  color: GLASS.textMuted,
  fontSize: '0.82rem',
  padding: '18px 2px',
};

export const emptyState: CSSProperties = {
  padding: '26px 0',
  textAlign: 'center',
  color: GLASS.textMuted,
  fontSize: '0.82rem',
};

// ── Charts ───────────────────────────────────────────────────────────────────

export const chartLabel: CSSProperties = {
  fontSize: '0.6rem',
  fontWeight: 700,
  color: GLASS.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.09em',
  marginBottom: 8,
};

export const chartSurface: CSSProperties = {
  background: 'rgba(8,10,15,0.4)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 12,
  padding: '12px 12px 4px',
  overflowX: 'auto',
};

// ── CDR table ────────────────────────────────────────────────────────────────

export function tableSearchWrap(focused: boolean, accent = GLASS.accent): CSSProperties {
  return {
    position: 'relative',
    flex: 1,
    maxWidth: 380,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 14px',
    borderRadius: 10,
    background: 'rgba(255,255,255,0.04)',
    border: `1px solid ${focused ? hexToRgba(accent, 0.45) : 'rgba(255,255,255,0.10)'}`,
    boxShadow: focused ? `0 0 0 3px ${hexToRgba(accent, 0.12)}` : 'inset 0 1px 0 rgba(255,255,255,0.05)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    transition: 'border-color 0.18s, box-shadow 0.18s',
  };
}

export const tableSearchInput: CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: 'transparent',
  border: 'none',
  outline: 'none',
  color: GLASS.text,
  fontSize: '0.82rem',
  fontFamily: 'inherit',
};

export const tableWrap: CSSProperties = {
  overflowX: 'auto',
  background: 'rgba(8,10,15,0.32)',
  border: '1px solid rgba(255,255,255,0.07)',
  borderRadius: 12,
};

export function th(sortable: boolean): CSSProperties {
  return {
    padding: '10px 12px',
    textAlign: 'left',
    fontSize: '0.58rem',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: GLASS.textMuted,
    borderBottom: '1px solid rgba(255,255,255,0.08)',
    whiteSpace: 'nowrap',
    cursor: sortable ? 'pointer' : 'default',
    userSelect: 'none',
  };
}

export const tdBase: CSSProperties = {
  padding: '7px 12px',
};

export function rowStyle(isSelected: boolean, even: boolean, accent = GLASS.accent): CSSProperties {
  return {
    borderBottom: '1px solid rgba(255,255,255,0.04)',
    background: isSelected
      ? hexToRgba(accent, 0.1)
      : even ? 'transparent' : 'rgba(255,255,255,0.012)',
    cursor: 'pointer',
    transition: 'background 0.12s',
    outline: isSelected ? `1px solid ${hexToRgba(accent, 0.32)}` : 'none',
    outlineOffset: -1,
  };
}

export function badge(color: string): CSSProperties {
  return {
    fontSize: '0.58rem',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    padding: '2px 7px',
    borderRadius: 5,
    background: hexToRgba(color, 0.14),
    color,
    border: `1px solid ${hexToRgba(color, 0.28)}`,
  };
}

export function metricPill(color: string): CSSProperties {
  return {
    fontSize: '0.7rem',
    fontWeight: 700,
    padding: '2px 8px',
    borderRadius: 6,
    background: hexToRgba(color, 0.14),
    color,
    fontVariantNumeric: 'tabular-nums',
  };
}

export function paginationBtn(disabled: boolean, accent = GLASS.accent): CSSProperties {
  return {
    padding: '6px 16px',
    fontSize: '0.74rem',
    fontWeight: 600,
    borderRadius: 8,
    border: `1px solid ${disabled ? 'rgba(255,255,255,0.07)' : hexToRgba(accent, 0.3)}`,
    background: disabled ? 'transparent' : hexToRgba(accent, 0.1),
    color: disabled ? GLASS.textFaint : accent,
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontFamily: 'inherit',
  };
}

// ── Detail panel (slide-out drawer) ──────────────────────────────────────────

export const drawerOverlay: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.55)',
  backdropFilter: 'blur(2px)',
  WebkitBackdropFilter: 'blur(2px)',
  zIndex: 1000,
  display: 'flex',
  justifyContent: 'flex-end',
};

export const drawerPanel: CSSProperties = {
  width: 480,
  maxWidth: '95vw',
  height: '100%',
  background: 'linear-gradient(180deg, rgba(18,21,32,0.92) 0%, rgba(11,13,19,0.96) 100%)',
  borderLeft: '1px solid rgba(255,255,255,0.10)',
  boxShadow: '-24px 0 64px rgba(0,0,0,0.55)',
  backdropFilter: 'blur(24px) saturate(160%)',
  WebkitBackdropFilter: 'blur(24px) saturate(160%)',
  display: 'flex',
  flexDirection: 'column',
  overflowY: 'auto',
};

export const drawerHeader: CSSProperties = {
  padding: '22px 26px 16px',
  borderBottom: '1px solid rgba(255,255,255,0.08)',
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
  position: 'sticky',
  top: 0,
  background: 'rgba(16,19,29,0.82)',
  backdropFilter: 'blur(14px)',
  WebkitBackdropFilter: 'blur(14px)',
  zIndex: 1,
};

export const drawerCloseBtn: CSSProperties = {
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.10)',
  borderRadius: 8,
  color: GLASS.textMuted,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 32,
  height: 32,
  fontSize: '0.95rem',
  lineHeight: 1,
  flexShrink: 0,
  marginTop: -2,
};

export function panelSectionTitle(accent = GLASS.accent): CSSProperties {
  return {
    fontSize: '0.58rem',
    fontWeight: 700,
    color: accent,
    textTransform: 'uppercase',
    letterSpacing: '0.12em',
    marginBottom: 10,
    paddingBottom: 6,
    borderBottom: `1px solid ${hexToRgba(accent, 0.22)}`,
  };
}

export const detailRow: CSSProperties = {
  display: 'flex',
  gap: 8,
  padding: '5px 0',
  borderBottom: '1px solid rgba(255,255,255,0.05)',
  alignItems: 'flex-start',
};

export const detailRowLabel: CSSProperties = {
  fontSize: '0.6rem',
  fontWeight: 700,
  color: GLASS.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.07em',
  whiteSpace: 'nowrap',
  flexShrink: 0,
  width: 132,
  paddingTop: 2,
};

export function detailRowValue(mono: boolean, accent?: string): CSSProperties {
  return {
    fontSize: '0.78rem',
    color: accent ?? GLASS.text,
    fontFamily: mono ? MONO : 'inherit',
    wordBreak: 'break-all',
  };
}

export function bigMetric(color: string): CSSProperties {
  return {
    background: `linear-gradient(135deg, ${hexToRgba(color, 0.1)} 0%, transparent 100%)`,
    border: `1px solid ${hexToRgba(color, 0.24)}`,
    borderRadius: 12,
    padding: '12px 16px',
    flex: '1 1 110px',
    minWidth: 0,
  };
}

export function bigMetricValue(color: string): CSSProperties {
  return {
    fontSize: '1.7rem',
    fontWeight: 800,
    color,
    fontVariantNumeric: 'tabular-nums',
    lineHeight: 1,
    textShadow: `0 0 18px ${hexToRgba(color, 0.4)}`,
  };
}

export const rtpGroupLabel: CSSProperties = {
  fontSize: '0.62rem',
  fontWeight: 700,
  marginBottom: 4,
  textTransform: 'uppercase',
  letterSpacing: '0.07em',
};

// ── Generic spinner (uses the app-wide glass-spin keyframe) ──────────────────

export function spinnerRing(accent = GLASS.accent): CSSProperties {
  return {
    width: 13,
    height: 13,
    borderRadius: '50%',
    border: `2px solid ${hexToRgba(accent, 0.25)}`,
    borderTopColor: accent,
    animation: 'glass-spin 0.7s linear infinite',
    display: 'inline-block',
    flexShrink: 0,
  };
}
