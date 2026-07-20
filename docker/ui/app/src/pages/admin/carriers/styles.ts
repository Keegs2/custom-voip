/**
 * Centralised style objects for the Carriers admin feature.
 *
 * Presentational components import these instead of inlining big CSSProperties
 * blocks. Everything is themed off `GLASS.accent` (app blue) and re-tintable by
 * passing a different `accent` to the builders. Parameterised styles are small
 * builder functions; static ones are constants.
 */

import type { CSSProperties } from 'react';
import { GLASS, hexToRgba } from '../../../components/glass/glass';

export const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

// ── Controls / section header ────────────────────────────────────────────────

export const sectionTitle: CSSProperties = {
  fontSize: '1rem',
  fontWeight: 700,
  color: GLASS.text,
  margin: 0,
  letterSpacing: '-0.01em',
  textShadow: '0 1px 8px rgba(0,0,0,0.5)',
};

export const sectionSubtitle: CSSProperties = {
  fontSize: '0.82rem',
  color: GLASS.textMuted,
  marginTop: 4,
};

export function primaryBtn(hovered: boolean, accent = GLASS.accent): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    flexShrink: 0,
    padding: '9px 18px',
    borderRadius: 12,
    border: 'none',
    background: `linear-gradient(135deg, ${accent} 0%, ${hexToRgba(accent, 0.78)} 100%)`,
    color: '#fff',
    fontSize: '0.82rem',
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
    boxShadow: hovered
      ? `0 10px 26px -8px ${hexToRgba(accent, 0.7)}`
      : `0 6px 18px -8px ${hexToRgba(accent, 0.5)}`,
    transition: 'box-shadow 0.2s ease, transform 0.2s ease',
    transform: hovered ? 'translateY(-1px)' : 'translateY(0)',
  };
}

export function ghostBtn(hovered: boolean, disabled = false, accent = GLASS.accent): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    flexShrink: 0,
    padding: '9px 16px',
    borderRadius: 12,
    border: `1px solid ${hovered && !disabled ? hexToRgba(accent, 0.4) : 'rgba(255,255,255,0.12)'}`,
    background: hovered && !disabled ? hexToRgba(accent, 0.1) : 'rgba(255,255,255,0.04)',
    color: disabled ? GLASS.textFaint : hovered ? accent : GLASS.text,
    fontSize: '0.82rem',
    fontWeight: 700,
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontFamily: 'inherit',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    transition: 'all 0.18s ease',
    opacity: disabled ? 0.6 : 1,
  };
}

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

// ── Carrier card ─────────────────────────────────────────────────────────────

export const cardBody: CSSProperties = {
  padding: '22px 24px 20px',
  display: 'flex',
  flexDirection: 'column',
};

export const cardName: CSSProperties = {
  fontSize: '1.05rem',
  fontWeight: 800,
  color: GLASS.text,
  letterSpacing: '-0.01em',
  lineHeight: 1.2,
  textShadow: '0 1px 10px rgba(0,0,0,0.5)',
};

export const cardGateway: CSSProperties = {
  fontFamily: MONO,
  fontSize: '0.74rem',
  color: GLASS.textMuted,
  marginTop: 3,
};

export const badgeRow: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  marginTop: 13,
};

// ── Connection details block ─────────────────────────────────────────────────

export function connBlock(accent = GLASS.accent): CSSProperties {
  return {
    fontFamily: MONO,
    fontSize: '0.76rem',
    background: 'rgba(8,10,15,0.5)',
    border: `1px solid ${hexToRgba(accent, 0.16)}`,
    borderRadius: 12,
    padding: '14px 16px',
    margin: '18px 0 16px',
    overflowX: 'auto',
    lineHeight: 1.85,
  };
}

export const connRow: CSSProperties = {
  display: 'flex',
  gap: 12,
};

export const connKey: CSSProperties = {
  color: GLASS.textMuted,
  minWidth: 104,
  flexShrink: 0,
};

export function connValue(accent = GLASS.accent): CSSProperties {
  return {
    color: accent,
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textShadow: `0 0 12px ${hexToRgba(accent, 0.18)}`,
  };
}

// ── Card action bar ──────────────────────────────────────────────────────────

export const actionsRow: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 8,
};

export function actionBtn(tone: 'accent' | 'success' | 'danger' | 'muted', hovered: boolean): CSSProperties {
  const color =
    tone === 'danger' ? '#f87171' : tone === 'success' ? GLASS.success : tone === 'accent' ? GLASS.accent : GLASS.textMuted;
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    background: hovered ? hexToRgba(color, 0.14) : 'rgba(255,255,255,0.03)',
    border: `1px solid ${hovered ? hexToRgba(color, 0.4) : 'rgba(255,255,255,0.12)'}`,
    borderRadius: 9,
    cursor: 'pointer',
    color: tone === 'muted' && !hovered ? GLASS.textMuted : color,
    fontSize: '0.74rem',
    padding: '6px 12px',
    fontWeight: 700,
    fontFamily: 'inherit',
    transition: 'all 0.15s',
  };
}

export function testResultText(reachable: boolean): CSSProperties {
  return {
    fontSize: '0.76rem',
    fontWeight: 700,
    color: reachable ? GLASS.success : '#f87171',
  };
}

export function editShell(accent = GLASS.accent): CSSProperties {
  return {
    borderTop: `1px solid ${hexToRgba(accent, 0.18)}`,
    paddingTop: 18,
    marginTop: 4,
  };
}

// ── Form ─────────────────────────────────────────────────────────────────────

export function formAccentLine(accent = GLASS.accent): CSSProperties {
  return {
    position: 'absolute',
    top: 0,
    left: 32,
    right: 32,
    height: 2,
    background: `linear-gradient(90deg, transparent, ${accent}, transparent)`,
    opacity: 0.6,
    pointerEvents: 'none',
  };
}

export function groupLabel(accent = GLASS.accent): CSSProperties {
  return {
    fontSize: '0.65rem',
    fontWeight: 700,
    color: accent,
    textTransform: 'uppercase',
    letterSpacing: '0.1em',
    marginBottom: 10,
  };
}

export const formError: CSSProperties = {
  color: '#fca5a5',
  fontSize: '0.82rem',
  background: 'rgba(239,68,68,0.1)',
  border: '1px solid rgba(239,68,68,0.28)',
  borderRadius: 10,
  padding: '9px 13px',
};

export function checkPill(checked: boolean, accent = GLASS.accent): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '7px 13px',
    borderRadius: 10,
    cursor: 'pointer',
    userSelect: 'none',
    fontSize: '0.78rem',
    fontWeight: 600,
    border: `1px solid ${checked ? hexToRgba(accent, 0.45) : 'rgba(255,255,255,0.12)'}`,
    background: checked ? hexToRgba(accent, 0.14) : 'rgba(255,255,255,0.03)',
    color: checked ? accent : GLASS.textMuted,
    transition: 'all 0.15s',
  };
}

export function checkBox(checked: boolean, accent = GLASS.accent): CSSProperties {
  return {
    width: 15,
    height: 15,
    borderRadius: 5,
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#fff',
    background: checked ? accent : 'transparent',
    border: `1px solid ${checked ? accent : 'rgba(255,255,255,0.2)'}`,
    transition: 'all 0.15s',
  };
}

// ── States (loading / error / empty) ─────────────────────────────────────────

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
