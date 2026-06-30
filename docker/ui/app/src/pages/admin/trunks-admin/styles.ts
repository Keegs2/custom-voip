/**
 * Centralised style objects for the Trunks admin feature.
 *
 * Presentational components import these instead of inlining big CSSProperties
 * blocks. Everything is themed off `GLASS.accent` (app blue) and re-tintable by
 * passing a different `accent` to the builders. Parameterised styles are small
 * builder functions; static ones are constants.
 */

import type { CSSProperties } from 'react';
import { GLASS, hexToRgba } from '../../../components/glass/glass';

export const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

// ── Section labels (the small uppercase headers inside expanded panels) ──────

export function sectionLabel(accent = GLASS.accent): CSSProperties {
  return {
    fontSize: '0.65rem',
    fontWeight: 700,
    color: accent,
    textTransform: 'uppercase',
    letterSpacing: '0.1em',
    marginBottom: 14,
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

export function ghostBtn(hovered: boolean, accent = GLASS.accent): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    flexShrink: 0,
    padding: '9px 16px',
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
    transition: 'all 0.18s ease',
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
  whiteSpace: 'nowrap',
};

export function rowStyle(expanded: boolean, accent = GLASS.accent): CSSProperties {
  return {
    cursor: 'pointer',
    transition: 'background 0.15s',
    background: expanded ? hexToRgba(accent, 0.06) : 'transparent',
  };
}

export function statusDot(expanded: boolean, accent = GLASS.accent): CSSProperties {
  return {
    width: 7,
    height: 7,
    borderRadius: '50%',
    flexShrink: 0,
    background: expanded ? accent : 'transparent',
    boxShadow: expanded ? `0 0 6px ${accent}` : 'none',
    transition: 'background 0.2s, box-shadow 0.2s',
  };
}

export const monoFaint: CSSProperties = {
  color: GLASS.textFaint,
  fontFamily: MONO,
  fontSize: '0.78rem',
};

export const cellNum: CSSProperties = {
  color: GLASS.text,
  fontVariantNumeric: 'tabular-nums',
  fontSize: '0.875rem',
};

export const cellMuted: CSSProperties = {
  color: GLASS.textMuted,
  fontSize: '0.83rem',
  fontVariantNumeric: 'tabular-nums',
};

// ── Small inline action buttons in the row (Enable/Disable, Delete) ──────────

export function rowActionBtn(tone: 'accent' | 'danger' | 'muted', _accent = GLASS.accent): CSSProperties {
  const color = tone === 'danger' ? '#f87171' : tone === 'accent' ? GLASS.success : GLASS.textMuted;
  const border =
    tone === 'danger'
      ? 'rgba(239,68,68,0.25)'
      : tone === 'accent'
      ? hexToRgba(GLASS.success, 0.3)
      : 'rgba(255,255,255,0.12)';
  return {
    background: 'rgba(255,255,255,0.02)',
    border: `1px solid ${border}`,
    borderRadius: 8,
    cursor: 'pointer',
    color,
    fontSize: '0.72rem',
    padding: '5px 10px',
    fontWeight: 600,
    fontFamily: 'inherit',
    transition: 'all 0.15s',
  };
}

// ── Expanded detail panel ────────────────────────────────────────────────────

export function expandedShell(accent = GLASS.accent): CSSProperties {
  return {
    borderLeft: `3px solid ${accent}`,
    padding: '24px 28px',
    background: 'linear-gradient(135deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.015) 100%)',
  };
}

// ── IP / DID item rows ───────────────────────────────────────────────────────

export const itemRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 12px',
  borderRadius: 10,
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.08)',
};

export const itemValue: CSSProperties = {
  fontFamily: MONO,
  fontSize: '0.82rem',
  color: GLASS.text,
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

export const removeBtn: CSSProperties = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  color: '#f87171',
  fontSize: '0.8rem',
  padding: '2px 6px',
  borderRadius: 6,
  flexShrink: 0,
};

export const emptyHint: CSSProperties = {
  fontSize: '0.8rem',
  color: GLASS.textFaint,
  marginBottom: 12,
};

export const loadingHint: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  color: GLASS.textMuted,
  fontSize: '0.8rem',
  marginBottom: 12,
};

// ── DID searchable dropdown ──────────────────────────────────────────────────

export function didInput(accent = GLASS.accent): CSSProperties {
  return {
    width: '100%',
    boxSizing: 'border-box',
    padding: '8px 11px',
    borderRadius: 10,
    border: '1px solid rgba(255,255,255,0.12)',
    background: 'rgba(8,10,15,0.55)',
    color: GLASS.text,
    fontSize: '0.82rem',
    fontFamily: MONO,
    outline: 'none',
    transition: 'border-color 0.15s, box-shadow 0.15s',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    boxShadow: `0 0 0 0 ${hexToRgba(accent, 0)}`,
  };
}

export const fieldLabel: CSSProperties = {
  fontSize: '0.72rem',
  fontWeight: 600,
  color: GLASS.textMuted,
  marginBottom: 6,
  letterSpacing: '0.03em',
};

export const dropdownPanel: CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 6px)',
  left: 0,
  right: 0,
  zIndex: 50,
  background: 'rgba(20,23,34,0.92)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 12,
  boxShadow: '0 18px 48px -12px rgba(0,0,0,0.6)',
  backdropFilter: 'blur(18px) saturate(160%)',
  WebkitBackdropFilter: 'blur(18px) saturate(160%)',
  maxHeight: 220,
  overflowY: 'auto',
};

export const dropdownInfo: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '10px 14px',
  color: GLASS.textMuted,
  fontSize: '0.8rem',
};

export function dropdownOption(active: boolean, accent = GLASS.accent): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 14px',
    cursor: 'pointer',
    background: active ? hexToRgba(accent, 0.14) : 'transparent',
    transition: 'background 0.15s',
    borderBottom: '1px solid rgba(255,255,255,0.04)',
  };
}

// ── DID confirmation step ────────────────────────────────────────────────────

export function confirmBox(accent = GLASS.accent): CSSProperties {
  return {
    marginTop: 12,
    padding: '14px 16px',
    borderRadius: 12,
    background: hexToRgba(accent, 0.08),
    border: `1px solid ${hexToRgba(accent, 0.25)}`,
  };
}

// ── Connection info card ─────────────────────────────────────────────────────

export function connectionBox(accent = GLASS.accent): CSSProperties {
  return {
    padding: '14px 16px',
    borderRadius: 12,
    background: hexToRgba(accent, 0.07),
    border: `1px solid ${hexToRgba(accent, 0.2)}`,
    fontSize: '0.82rem',
    color: GLASS.textMuted,
    lineHeight: 1.7,
  };
}

export function connectionValue(accent = GLASS.accent): CSSProperties {
  return {
    fontFamily: MONO,
    fontSize: '0.98rem',
    color: accent,
    fontWeight: 700,
    letterSpacing: '0.02em',
    textShadow: `0 0 14px ${hexToRgba(accent, 0.3)}`,
  };
}

// ── Enabled toggle (edit form) ───────────────────────────────────────────────

export function toggleTrack(on: boolean): CSSProperties {
  return {
    width: 40,
    height: 22,
    borderRadius: 11,
    background: on ? GLASS.success : 'rgba(255,255,255,0.12)',
    border: `1px solid ${on ? hexToRgba(GLASS.success, 0.8) : 'rgba(255,255,255,0.16)'}`,
    position: 'relative',
    cursor: 'pointer',
    transition: 'background 0.2s, border-color 0.2s',
    flexShrink: 0,
  };
}

export function toggleKnob(on: boolean): CSSProperties {
  return {
    position: 'absolute',
    top: 2,
    left: on ? 20 : 2,
    width: 16,
    height: 16,
    borderRadius: '50%',
    background: '#fff',
    transition: 'left 0.2s',
    boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
  };
}

// ── Inline trunk-name editor ─────────────────────────────────────────────────

export const inlineSaveBtn: CSSProperties = {
  fontSize: '0.65rem',
  fontWeight: 600,
  padding: '4px 10px',
  borderRadius: 6,
  border: 'none',
  background: GLASS.success,
  color: '#fff',
  cursor: 'pointer',
  flexShrink: 0,
  lineHeight: 1,
  fontFamily: 'inherit',
};

export const inlineCancelBtn: CSSProperties = {
  fontSize: '0.65rem',
  fontWeight: 500,
  padding: '4px 8px',
  borderRadius: 6,
  border: 'none',
  background: 'transparent',
  color: GLASS.textMuted,
  cursor: 'pointer',
  flexShrink: 0,
  lineHeight: 1,
  fontFamily: 'inherit',
};

export function inlineNameInput(value: string, pending: boolean, accent = GLASS.accent): CSSProperties {
  return {
    color: GLASS.text,
    fontWeight: 600,
    fontSize: '0.875rem',
    background: 'rgba(8,10,15,0.6)',
    border: `1px solid ${hexToRgba(accent, 0.5)}`,
    borderRadius: 6,
    outline: 'none',
    padding: '2px 6px',
    fontFamily: 'inherit',
    opacity: pending ? 0.5 : 1,
    boxShadow: `0 0 0 3px ${hexToRgba(accent, 0.12)}`,
    width: Math.max(value.length * 8.5 + 20, 80),
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

// ── Create form accent line ──────────────────────────────────────────────────

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
