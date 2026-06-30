/**
 * Centralised style objects for the Troubleshooting (SIP-trace search) page.
 *
 * Presentational components import these instead of inlining big CSSProperties
 * blocks. Everything is themed off `GLASS.accent` (app blue). Because this page
 * renders OUTSIDE AppLayout (it owns its own Sidebar), it also owns the app-wide
 * spacing standard locally — see `PAGE_*` below (mirrors AppLayout §7).
 */

import type { CSSProperties } from 'react';
import { GLASS, hexToRgba } from '../../components/glass/glass';

export const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/** Status purple used for call duration (no GLASS token — kept local). */
export const DURATION_COLOR = '#c084fc';

// ── Page shell / spacing standard (full-screen, outside AppLayout) ───────────
// Mirrors AppLayout's PAGE_PADDING_* clamps so this page breathes identically
// to every routed page and is never glued to the top edge.

export const SIDEBAR_WIDTH = 240;

export const pageMain: CSSProperties = {
  marginLeft: SIDEBAR_WIDTH,
  minHeight: '100vh',
  position: 'relative',
  zIndex: 1,
  display: 'flex',
  flexDirection: 'column',
};

export const pageColumn: CSSProperties = {
  width: '100%',
  maxWidth: 1280,
  marginLeft: 'auto',
  marginRight: 'auto',
  paddingLeft: 'clamp(24px, 3vw, 48px)',
  paddingRight: 'clamp(24px, 3vw, 48px)',
  paddingTop: 'clamp(32px, 4vh, 48px)',
  paddingBottom: 'clamp(64px, 8vh, 96px)',
  // 32px section gap between hero → form → results (in-page rhythm).
  display: 'flex',
  flexDirection: 'column',
  gap: 32,
};

// ── Hero ─────────────────────────────────────────────────────────────────────

export const heroRow: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 20,
  flexWrap: 'wrap',
};

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

export const heroBadgeDot = (accent = GLASS.accent): CSSProperties => ({
  width: 7,
  height: 7,
  borderRadius: '50%',
  background: accent,
  boxShadow: `0 0 8px ${accent}`,
});

export const heroBadgeText = (accent = GLASS.accent): CSSProperties => ({
  fontSize: '0.66rem',
  fontWeight: 700,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: accent,
});

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

export function dashboardLink(accent = GLASS.accent): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    padding: '9px 16px',
    borderRadius: 12,
    border: `1px solid ${hexToRgba(accent, 0.28)}`,
    background: hexToRgba(accent, 0.08),
    color: accent,
    fontSize: '0.8rem',
    fontWeight: 700,
    textDecoration: 'none',
    whiteSpace: 'nowrap',
    flexShrink: 0,
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
    boxShadow: `inset 0 1px 0 rgba(255,255,255,0.08)`,
    transition: 'background 0.18s, border-color 0.18s',
  };
}

// ── Search form ───────────────────────────────────────────────────────────────

export const formGrid3: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
  gap: 16,
  marginBottom: 16,
};

export const formGrid2: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: 16,
  marginBottom: 20,
};

export const labelStyle: CSSProperties = {
  display: 'block',
  fontSize: '0.66rem',
  fontWeight: 700,
  letterSpacing: '0.1em',
  color: GLASS.textMuted,
  textTransform: 'uppercase',
  marginBottom: 7,
};

export function inputStyle(focused: boolean, accent = GLASS.accent): CSSProperties {
  return {
    width: '100%',
    padding: '10px 13px',
    background: 'rgba(255,255,255,0.04)',
    border: `1px solid ${focused ? hexToRgba(accent, 0.45) : 'rgba(255,255,255,0.10)'}`,
    borderRadius: 12,
    color: GLASS.text,
    fontSize: '0.875rem',
    fontFamily: 'inherit',
    outline: 'none',
    boxSizing: 'border-box',
    boxShadow: focused
      ? `0 0 0 3px ${hexToRgba(accent, 0.12)}, inset 0 1px 0 rgba(255,255,255,0.06)`
      : 'inset 0 1px 0 rgba(255,255,255,0.05)',
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
    transition: 'border-color 0.18s, box-shadow 0.18s',
  };
}

export const validationError: CSSProperties = {
  margin: '0 0 14px',
  fontSize: '0.8rem',
  color: GLASS.danger,
  display: 'flex',
  alignItems: 'center',
  gap: 7,
};

export const formActions: CSSProperties = { display: 'flex', gap: 10 };

export function primaryBtn(disabled: boolean, accent = GLASS.accent): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 22px',
    borderRadius: 12,
    border: 'none',
    background: disabled
      ? hexToRgba(accent, 0.18)
      : `linear-gradient(135deg, ${accent} 0%, ${hexToRgba(accent, 0.78)} 100%)`,
    color: '#fff',
    fontSize: '0.875rem',
    fontWeight: 700,
    fontFamily: 'inherit',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.7 : 1,
    boxShadow: disabled ? 'none' : `0 8px 22px -8px ${hexToRgba(accent, 0.7)}`,
    transition: 'opacity 0.18s, box-shadow 0.18s',
  };
}

export function ghostBtn(disabled: boolean, hovered: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    padding: '10px 18px',
    borderRadius: 12,
    border: `1px solid ${hovered ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.10)'}`,
    background: hovered ? 'rgba(255,255,255,0.05)' : 'transparent',
    color: hovered ? GLASS.text : GLASS.textMuted,
    fontSize: '0.875rem',
    fontWeight: 600,
    fontFamily: 'inherit',
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'color 0.18s, border-color 0.18s, background 0.18s',
  };
}

// ── Results panel ─────────────────────────────────────────────────────────────

export const resultsHeader: CSSProperties = {
  padding: '16px 22px',
  borderBottom: '1px solid rgba(255,255,255,0.07)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
};

export const resultsHeaderLabel: CSSProperties = {
  fontSize: '0.66rem',
  fontWeight: 700,
  color: GLASS.textMuted,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
};

export const resultsHeaderCount: CSSProperties = {
  fontSize: '0.78rem',
  color: GLASS.textFaint,
};

// ── Results table ─────────────────────────────────────────────────────────────

export const th: CSSProperties = {
  padding: '12px 16px',
  textAlign: 'left',
  fontSize: '0.62rem',
  fontWeight: 700,
  letterSpacing: '0.08em',
  color: GLASS.textMuted,
  textTransform: 'uppercase',
  whiteSpace: 'nowrap',
  borderBottom: '1px solid rgba(255,255,255,0.07)',
  background: 'rgba(255,255,255,0.025)',
};

export const td: CSSProperties = {
  padding: '12px 16px',
  fontSize: '0.82rem',
  color: GLASS.text,
  borderTop: '1px solid rgba(255,255,255,0.05)',
  verticalAlign: 'middle',
};

export const tdMono: CSSProperties = {
  fontFamily: MONO,
  fontSize: '0.76rem',
  color: GLASS.textMuted,
};

export function tableRow(expanded: boolean, accent = GLASS.accent): CSSProperties {
  return {
    cursor: 'pointer',
    transition: 'background 0.15s',
    background: expanded ? hexToRgba(accent, 0.08) : undefined,
  };
}

export function grafanaLink(accent = GLASS.accent): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '5px 11px',
    borderRadius: 8,
    border: `1px solid ${hexToRgba(accent, 0.25)}`,
    background: hexToRgba(accent, 0.07),
    color: accent,
    fontSize: '0.72rem',
    fontWeight: 600,
    textDecoration: 'none',
    transition: 'background 0.15s',
  };
}

// ── Badges (status / msg count / duration) ────────────────────────────────────

export function badge(color: string): CSSProperties {
  return {
    display: 'inline-block',
    padding: '3px 9px',
    borderRadius: 999,
    fontSize: '0.68rem',
    fontWeight: 700,
    fontFamily: MONO,
    background: hexToRgba(color, 0.12),
    color,
    border: `1px solid ${hexToRgba(color, 0.3)}`,
    whiteSpace: 'nowrap',
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08)',
  };
}

export const badgeMutedText: CSSProperties = {
  fontSize: '0.78rem',
  fontFamily: MONO,
  color: GLASS.textFaint,
};

// ── States (empty / no-results / loading / error) ─────────────────────────────

export const stateWrap: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '56px 32px',
  gap: 14,
  textAlign: 'center',
};

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

export const stateText: CSSProperties = {
  color: GLASS.textMuted,
  fontSize: '0.9rem',
  maxWidth: 360,
  lineHeight: 1.55,
};

export const inlineStateRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '56px 32px',
  gap: 12,
  fontSize: '0.9rem',
};

export function spinner(accent = GLASS.accent, size = 14): CSSProperties {
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
