/**
 * Centralised style objects + builders for the User Detail glass page.
 *
 * Presentational components import these instead of inlining large
 * `CSSProperties` blocks, so spacing / accent usage / the mono font live in one
 * place. Everything reads off the canonical `GLASS` tokens (app blue) and can be
 * re-tinted by passing a different `accent` to the builders. Status/product hues
 * (RCF green, API purple, Trunk amber) stay semantic — they identify the product,
 * not the page accent.
 */

import type { CSSProperties } from 'react';
import { GLASS, hexToRgba } from '../../../components/glass/glass';

export const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

// ── Section card header ──────────────────────────────────────────────────────

export const sectionHeader: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginBottom: 16,
};

export function sectionIcon(accent: string): CSSProperties {
  return { color: accent, display: 'flex', alignItems: 'center' };
}

export const sectionTitle: CSSProperties = {
  margin: 0,
  fontSize: '0.72rem',
  fontWeight: 700,
  color: GLASS.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
};

// ── Tables (recent calls / products / users / customers) ─────────────────────

export const tableTh: CSSProperties = {
  padding: '10px 14px',
  textAlign: 'left',
  fontSize: '0.6rem',
  fontWeight: 700,
  color: GLASS.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
  whiteSpace: 'nowrap',
};

export const tableTd: CSSProperties = {
  padding: '11px 14px',
  fontSize: '0.82rem',
  color: GLASS.text,
  borderTop: '1px solid rgba(255,255,255,0.05)',
  verticalAlign: 'middle',
};

export const tableHeadRow: CSSProperties = {
  background: 'rgba(255,255,255,0.03)',
  borderBottom: '1px solid rgba(255,255,255,0.08)',
};

/** Generic status pill (Active / Disabled, pass-thru, etc.). */
export function statusPill(color: string): CSSProperties {
  return {
    fontSize: '0.63rem',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    color,
    background: hexToRgba(color, 0.12),
    border: `1px solid ${hexToRgba(color, 0.3)}`,
    borderRadius: 5,
    padding: '2px 8px',
    whiteSpace: 'nowrap',
    display: 'inline-block',
  };
}

// ── Field tile (extension config grid) ───────────────────────────────────────

export const fieldTile: CSSProperties = {
  padding: '12px 16px',
  borderRadius: 12,
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.06)',
};

export const fieldTileLabel: CSSProperties = {
  fontSize: '0.58rem',
  fontWeight: 700,
  color: GLASS.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
  marginBottom: 6,
};

// ── Edit user form ───────────────────────────────────────────────────────────

export const editInput: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '9px 12px',
  fontSize: '0.875rem',
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.10)',
  borderRadius: 8,
  color: GLASS.text,
  outline: 'none',
  fontFamily: 'inherit',
  transition: 'border-color 0.15s, box-shadow 0.15s',
};

export const editSelect: CSSProperties = {
  ...editInput,
  appearance: 'none',
  WebkitAppearance: 'none',
  cursor: 'pointer',
  paddingRight: 32,
};

export const editLabel: CSSProperties = {
  display: 'block',
  fontSize: '0.68rem',
  fontWeight: 700,
  color: GLASS.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  marginBottom: 6,
};

export const optionStyle: CSSProperties = { background: '#1a1d2e', color: GLASS.text };

export function editFocus(e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>): void {
  e.currentTarget.style.borderColor = hexToRgba(GLASS.accent, 0.5);
  e.currentTarget.style.boxShadow = `0 0 0 3px ${hexToRgba(GLASS.accent, 0.12)}`;
}

export function editBlur(e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>): void {
  e.currentTarget.style.borderColor = 'rgba(255,255,255,0.10)';
  e.currentTarget.style.boxShadow = 'none';
}

// ── Buttons / links ──────────────────────────────────────────────────────────

export function primaryBtn(pending: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    padding: '9px 20px',
    borderRadius: 10,
    background: pending
      ? hexToRgba(GLASS.accent, 0.5)
      : `linear-gradient(135deg, ${GLASS.accent} 0%, ${hexToRgba(GLASS.accent, 0.8)} 100%)`,
    border: `1px solid ${hexToRgba(GLASS.accent, 0.5)}`,
    color: '#fff',
    fontSize: '0.85rem',
    fontWeight: 700,
    cursor: pending ? 'not-allowed' : 'pointer',
    fontFamily: 'inherit',
    boxShadow: pending ? 'none' : `0 6px 18px -6px ${hexToRgba(GLASS.accent, 0.6)}`,
    transition: 'background 0.15s, box-shadow 0.15s',
  };
}

export function ghostBtn(pending = false): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '9px 16px',
    borderRadius: 10,
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.10)',
    color: GLASS.textMuted,
    fontSize: '0.85rem',
    fontWeight: 600,
    cursor: pending ? 'not-allowed' : 'pointer',
    fontFamily: 'inherit',
    transition: 'border-color 0.15s, color 0.15s',
  };
}

export const backButton: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  background: 'transparent',
  border: 'none',
  color: GLASS.accent,
  fontSize: '0.8rem',
  fontWeight: 600,
  cursor: 'pointer',
  padding: '4px 0',
  fontFamily: 'inherit',
  transition: 'color 0.15s',
};

/** A small frosted action link/button used in Quick Actions. */
export function actionPill(accent: string, hovered: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    padding: '9px 16px',
    borderRadius: 10,
    background: hexToRgba(accent, hovered ? 0.18 : 0.1),
    border: `1px solid ${hexToRgba(accent, hovered ? 0.45 : 0.25)}`,
    color: accent,
    textDecoration: 'none',
    fontSize: '0.82rem',
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'background 0.15s, border-color 0.15s',
  };
}

export function disabledPill(accent: string): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    padding: '9px 16px',
    borderRadius: 10,
    background: hexToRgba(accent, 0.06),
    border: `1px solid ${hexToRgba(accent, 0.15)}`,
    color: GLASS.textMuted,
    fontSize: '0.82rem',
    fontWeight: 600,
    cursor: 'not-allowed',
    opacity: 0.55,
    fontFamily: 'inherit',
  };
}

// ── Search input (user lookup + customer picker) ─────────────────────────────

export function searchWrap(focused: boolean): CSSProperties {
  return {
    position: 'relative',
    flex: '1 1 240px',
    minWidth: 200,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 12px',
    borderRadius: 10,
    background: 'rgba(255,255,255,0.04)',
    border: `1px solid ${focused ? hexToRgba(GLASS.accent, 0.45) : 'rgba(255,255,255,0.10)'}`,
    boxShadow: focused
      ? `0 0 0 3px ${hexToRgba(GLASS.accent, 0.12)}, inset 0 1px 0 rgba(255,255,255,0.06)`
      : 'inset 0 1px 0 rgba(255,255,255,0.05)',
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

// ── Banner (edit form result) ────────────────────────────────────────────────

export function banner(type: 'success' | 'error'): CSSProperties {
  const color = type === 'success' ? GLASS.success : GLASS.danger;
  return {
    padding: '10px 14px',
    borderRadius: 10,
    marginBottom: 20,
    background: hexToRgba(color, 0.1),
    border: `1px solid ${hexToRgba(color, 0.3)}`,
    color: type === 'success' ? '#4ade80' : '#f87171',
    fontSize: '0.82rem',
    fontWeight: 500,
  };
}

// ── Hero badge / heading (per-state subheads) ────────────────────────────────

export function kicker(accent: string): CSSProperties {
  return {
    fontSize: '0.65rem',
    fontWeight: 700,
    color: accent,
    textTransform: 'uppercase',
    letterSpacing: '0.1em',
  };
}
