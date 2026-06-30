/**
 * Centralised style objects + builders for the Conference feature, themed off
 * the canonical blue glass kit (`GLASS.accent`). Presentational components import
 * from here instead of inlining big CSSProperties blocks, so the visual language
 * (spacing, accent usage, frosted fills) lives in one place.
 *
 * Keep this module free of React component imports (styles only).
 */

import type { CSSProperties } from 'react';
import { GLASS, hexToRgba, glassSurface } from '../../components/glass/glass';

export const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/* ── Page-local keyframes (the glass kit injects glass-spin/rise/shimmer; these
 *    two are conference-specific live indicators). ──────────────────────────── */
export const CONFERENCE_KEYFRAMES = `
  @keyframes confPulse {
    0%, 100% { opacity: 0.7; transform: scale(1); }
    50%       { opacity: 1;   transform: scale(1.05); }
  }
  @keyframes liveGlow {
    0%, 100% { box-shadow: 0 0 0 2px rgba(34,197,94,0.15); }
    50%       { box-shadow: 0 0 0 4px rgba(34,197,94,0.30); }
  }
`;

/* ── Full-height structural panels (left room list + right detail) ──────────── */

/** A full-height frosted shell that lays its children out as a flex column. */
export function panelShell(radius = 22): CSSProperties {
  return {
    ...glassSurface({ radius }),
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    overflow: 'hidden',
  };
}

/* ── Shared spinner (uses the kit's glass-spin keyframe) ────────────────────── */

export function spinner(size = 16, accent = GLASS.accent): CSSProperties {
  return {
    width: size,
    height: size,
    borderRadius: '50%',
    border: `2px solid ${hexToRgba(accent, 0.2)}`,
    borderTopColor: accent,
    animation: 'glass-spin 0.8s linear infinite',
    flexShrink: 0,
  };
}

/* ── Form primitives ────────────────────────────────────────────────────────── */

export const inputStyle: CSSProperties = {
  width: '100%',
  padding: '9px 12px',
  borderRadius: 10,
  background: 'rgba(8,10,15,0.45)',
  border: '1px solid rgba(255,255,255,0.10)',
  color: GLASS.text,
  fontSize: '0.85rem',
  outline: 'none',
  boxSizing: 'border-box',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
  transition: 'border-color 0.15s',
};

export const primaryBtn: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  padding: '9px 18px',
  borderRadius: 10,
  background: `linear-gradient(135deg, ${GLASS.accent} 0%, ${hexToRgba(GLASS.accent, 0.78)} 100%)`,
  border: 'none',
  color: '#fff',
  fontSize: '0.85rem',
  fontWeight: 700,
  cursor: 'pointer',
  fontFamily: 'inherit',
  boxShadow: `0 6px 18px -6px ${hexToRgba(GLASS.accent, 0.6)}`,
};

export const secondaryBtn: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '9px 16px',
  borderRadius: 10,
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.10)',
  color: GLASS.textMuted,
  fontSize: '0.85rem',
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

export const dangerBtn: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  padding: '8px 14px',
  borderRadius: 9,
  background: hexToRgba(GLASS.danger, 0.1),
  border: `1px solid ${hexToRgba(GLASS.danger, 0.25)}`,
  color: GLASS.danger,
  fontSize: '0.8rem',
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

/* ── Modal shell ────────────────────────────────────────────────────────────── */

export const modalBackdrop: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.65)',
  backdropFilter: 'blur(6px)',
  WebkitBackdropFilter: 'blur(6px)',
  animation: 'modal-backdrop-in 0.18s ease-out both',
  zIndex: 500,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
};

export function modalCard(maxWidth: number, maxHeight?: string): CSSProperties {
  return {
    ...glassSurface({ radius: 18 }),
    width: '100%',
    maxWidth,
    maxHeight,
    display: 'flex',
    flexDirection: 'column',
    animation: 'modal-in 0.18s cubic-bezier(0.16, 1, 0.3, 1) both',
  };
}

export const modalCloseBtn: CSSProperties = {
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.08)',
  color: GLASS.textMuted,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 32,
  height: 32,
  borderRadius: 9,
  flexShrink: 0,
};

export function modalIconBadge(size = 36): CSSProperties {
  return {
    width: size,
    height: size,
    borderRadius: 10,
    background: `linear-gradient(135deg, ${hexToRgba(GLASS.accent, 0.22)} 0%, ${hexToRgba(GLASS.accent, 0.1)} 100%)`,
    border: `1px solid ${hexToRgba(GLASS.accent, 0.3)}`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#93c5fd',
    flexShrink: 0,
  };
}

export const errorBanner: CSSProperties = {
  padding: '10px 14px',
  background: hexToRgba(GLASS.danger, 0.1),
  border: `1px solid ${hexToRgba(GLASS.danger, 0.25)}`,
  borderRadius: 9,
  color: '#fca5a5',
  fontSize: '0.8rem',
};

/* ── Avatar ─────────────────────────────────────────────────────────────────── */

export function avatar(size = 34): CSSProperties {
  return {
    width: size,
    height: size,
    borderRadius: '50%',
    background: 'linear-gradient(135deg, rgba(59,130,246,0.24) 0%, rgba(99,102,241,0.24) 100%)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: size >= 36 ? '0.9rem' : '0.85rem',
    fontWeight: 700,
    color: '#a5b4fc',
    flexShrink: 0,
  };
}

/* ── Row tiles (members / schedules / participants / settings) ──────────────── */

export function listRow(active = false, accent = GLASS.accent): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '11px 14px',
    borderRadius: 12,
    background: active ? hexToRgba(accent, 0.08) : 'rgba(255,255,255,0.03)',
    border: `1px solid ${active ? hexToRgba(accent, 0.22) : 'rgba(255,255,255,0.06)'}`,
    transition: 'background 0.18s, border-color 0.18s',
  };
}

export function iconTile(size = 36, accent = GLASS.accent): CSSProperties {
  return {
    width: size,
    height: size,
    borderRadius: 10,
    background: hexToRgba(accent, 0.1),
    border: `1px solid ${hexToRgba(accent, 0.2)}`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#93c5fd',
    flexShrink: 0,
  };
}

export function smallIconBtn(tone: 'neutral' | 'danger' = 'neutral'): CSSProperties {
  const danger = tone === 'danger';
  return {
    width: 30,
    height: 30,
    borderRadius: 9,
    background: danger ? hexToRgba(GLASS.danger, 0.08) : 'rgba(255,255,255,0.04)',
    border: `1px solid ${danger ? hexToRgba(GLASS.danger, 0.18) : 'rgba(255,255,255,0.08)'}`,
    color: danger ? GLASS.danger : GLASS.textMuted,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  };
}

/* ── Tabs ───────────────────────────────────────────────────────────────────── */

export function tabBtn(active: boolean, accent = GLASS.accent): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 16px',
    borderRadius: 10,
    background: active ? hexToRgba(accent, 0.14) : 'transparent',
    border: `1px solid ${active ? hexToRgba(accent, 0.28) : 'transparent'}`,
    color: active ? '#bfdbfe' : GLASS.textMuted,
    fontSize: '0.8rem',
    fontWeight: active ? 700 : 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'background 0.15s, color 0.15s, border-color 0.15s',
  };
}

/* ── Section labels ─────────────────────────────────────────────────────────── */

export const sectionLabel: CSSProperties = {
  fontSize: '0.85rem',
  fontWeight: 600,
  color: GLASS.textMuted,
};

export const uppercaseLabel: CSSProperties = {
  fontSize: '0.65rem',
  fontWeight: 700,
  color: GLASS.textFaint,
  textTransform: 'uppercase',
  letterSpacing: '0.12em',
};

/* ── Join button (detail header) ────────────────────────────────────────────── */

export function joinBtn(hovered: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '11px 22px',
    borderRadius: 12,
    background: `linear-gradient(135deg, ${GLASS.accent} 0%, ${hexToRgba(GLASS.accent, 0.78)} 100%)`,
    border: 'none',
    color: '#fff',
    fontSize: '0.875rem',
    fontWeight: 700,
    cursor: 'pointer',
    boxShadow: `0 8px 24px -8px ${hexToRgba(GLASS.accent, 0.6)}`,
    letterSpacing: '-0.01em',
    flexShrink: 0,
    transform: hovered ? 'translateY(-1px)' : 'translateY(0)',
    opacity: hovered ? 0.94 : 1,
    transition: 'opacity 0.15s, transform 0.12s',
    fontFamily: 'inherit',
  };
}

/* ── Start Meeting Now button (left panel) ──────────────────────────────────── */

export function startNowBtn(hovered: boolean, disabled: boolean): CSSProperties {
  return {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
    padding: '13px 16px',
    borderRadius: 12,
    background: hovered && !disabled
      ? `linear-gradient(135deg, ${GLASS.success} 0%, #16a34a 100%)`
      : `linear-gradient(135deg, #2dd36f 0%, ${GLASS.success} 100%)`,
    border: 'none',
    color: '#fff',
    fontSize: '0.9rem',
    fontWeight: 700,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.55 : 1,
    transition: 'background 0.18s, opacity 0.18s, transform 0.12s',
    transform: hovered && !disabled ? 'translateY(-1px)' : 'translateY(0)',
    letterSpacing: '-0.01em',
    boxShadow: `0 8px 22px -8px ${hexToRgba(GLASS.success, 0.55)}`,
    fontFamily: 'inherit',
  };
}

/* ── Live indicator pills ───────────────────────────────────────────────────── */

export const livePill: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '3px 10px',
  borderRadius: 999,
  background: hexToRgba(GLASS.success, 0.12),
  border: `1px solid ${hexToRgba(GLASS.success, 0.3)}`,
  animation: 'liveGlow 2s ease-in-out infinite',
};

export const recordingPill: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 12px',
  borderRadius: 999,
  background: hexToRgba(GLASS.danger, 0.1),
  border: `1px solid ${hexToRgba(GLASS.danger, 0.25)}`,
};

export function pulseDot(color: string, size = 6): CSSProperties {
  return {
    width: size,
    height: size,
    borderRadius: '50%',
    background: color,
    animation: 'confPulse 1.5s ease-in-out infinite',
    flexShrink: 0,
  };
}

/* ── Empty-state hero icon ──────────────────────────────────────────────────── */

export function emptyHeroIcon(accent = GLASS.accent): CSSProperties {
  return {
    width: 80,
    height: 80,
    borderRadius: 22,
    background: `linear-gradient(135deg, ${hexToRgba(accent, 0.14)} 0%, ${hexToRgba('#818cf8', 0.08)} 100%)`,
    border: `1px solid ${hexToRgba(accent, 0.2)}`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: accent,
    animation: 'confPulse 3s ease-in-out infinite',
  };
}

export function softIcon(accent = GLASS.accent): CSSProperties {
  return {
    width: 60,
    height: 60,
    borderRadius: 16,
    background: hexToRgba(accent, 0.08),
    border: `1px solid ${hexToRgba(accent, 0.18)}`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: hexToRgba(accent, 0.7),
  };
}

/* ── Misc text tokens ───────────────────────────────────────────────────────── */

export const monoAccent: CSSProperties = {
  color: '#93c5fd',
  fontWeight: 700,
  fontFamily: MONO,
};
