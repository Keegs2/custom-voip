/**
 * Centralised CSSProperties + builders for the customer Billing & Payments page.
 * Presentational components import these rather than inlining big style blocks
 * (glass refactor §1). Everything is themed off GLASS.accent (app blue) and can
 * be re-tinted via the optional `accent` argument.
 */

import type { CSSProperties } from 'react';
import { GLASS, hexToRgba } from '../../components/glass/glass';

export const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

// ── Hero balance ──────────────────────────────────────────────────────────────

export function heroEyebrow(accent = GLASS.accent): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 14,
    padding: '5px 12px',
    borderRadius: 999,
    background: hexToRgba(accent, 0.08),
    border: `1px solid ${hexToRgba(accent, 0.22)}`,
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
  };
}

export const heroBalanceValue: CSSProperties = {
  fontSize: 'clamp(2.4rem, 6vw, 4rem)',
  fontWeight: 800,
  fontFamily: MONO,
  letterSpacing: '-0.02em',
  lineHeight: 1,
  color: GLASS.text,
  textShadow: '0 2px 24px rgba(0,0,0,0.5)',
};

export const heroBalanceLabel: CSSProperties = {
  fontSize: '0.66rem',
  fontWeight: 700,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: GLASS.textMuted,
  marginBottom: 8,
};

// ── Section headings ──────────────────────────────────────────────────────────

export function sectionEyebrow(accent = GLASS.accent): CSSProperties {
  return {
    fontSize: '0.6rem',
    fontWeight: 700,
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    color: hexToRgba(accent, 0.85),
    marginBottom: 6,
  };
}

export const sectionTitle: CSSProperties = {
  fontSize: '1.05rem',
  fontWeight: 700,
  color: GLASS.text,
  margin: 0,
  letterSpacing: '-0.01em',
};

export const sectionDesc: CSSProperties = {
  fontSize: '0.82rem',
  color: GLASS.textMuted,
  margin: '4px 0 0',
  lineHeight: 1.5,
  maxWidth: 620,
};

// ── Ledger table ──────────────────────────────────────────────────────────────

export const th: CSSProperties = {
  textAlign: 'left',
  fontSize: '0.6rem',
  fontWeight: 700,
  color: GLASS.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  padding: '11px 16px',
  whiteSpace: 'nowrap',
};

export const td: CSSProperties = {
  padding: '12px 16px',
  fontSize: '0.82rem',
  color: GLASS.text,
  borderTop: '1px solid rgba(255,255,255,0.05)',
  verticalAlign: 'middle',
};

export const tdMono: CSSProperties = {
  ...td,
  fontFamily: MONO,
  letterSpacing: '0.01em',
};

// ── Payment method card ───────────────────────────────────────────────────────

export function methodCard(isDefault: boolean, accent = GLASS.accent): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    padding: '16px 18px',
    borderRadius: 14,
    background: isDefault ? hexToRgba(accent, 0.06) : 'rgba(255,255,255,0.03)',
    border: `1px solid ${isDefault ? hexToRgba(accent, 0.28) : 'rgba(255,255,255,0.08)'}`,
  };
}

export const cardBrandGlyph: CSSProperties = {
  width: 46,
  height: 30,
  borderRadius: 6,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'linear-gradient(135deg, rgba(255,255,255,0.14), rgba(255,255,255,0.04))',
  border: '1px solid rgba(255,255,255,0.12)',
  fontSize: '0.6rem',
  fontWeight: 800,
  letterSpacing: '0.04em',
  color: GLASS.text,
  flexShrink: 0,
};

// ── Buttons (page-local, glass) ───────────────────────────────────────────────

export function primaryBtn(accent = GLASS.accent, disabled = false): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: '10px 18px',
    borderRadius: 12,
    border: 'none',
    background: `linear-gradient(135deg, ${accent} 0%, ${hexToRgba(accent, 0.78)} 100%)`,
    color: '#fff',
    fontSize: '0.82rem',
    fontWeight: 700,
    fontFamily: 'inherit',
    cursor: disabled ? 'not-allowed' : 'pointer',
    boxShadow: `0 8px 22px -8px ${hexToRgba(accent, 0.6)}`,
    opacity: disabled ? 0.6 : 1,
    transition: 'transform 0.15s, box-shadow 0.15s, opacity 0.15s',
    whiteSpace: 'nowrap',
  };
}

export function ghostBtn(accent = GLASS.accent, active = false): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    padding: '9px 15px',
    borderRadius: 11,
    border: `1px solid ${active ? hexToRgba(accent, 0.4) : 'rgba(255,255,255,0.12)'}`,
    background: active ? hexToRgba(accent, 0.1) : 'rgba(255,255,255,0.03)',
    color: active ? accent : GLASS.text,
    fontSize: '0.8rem',
    fontWeight: 600,
    fontFamily: 'inherit',
    cursor: 'pointer',
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
    transition: 'all 0.15s ease',
    whiteSpace: 'nowrap',
  };
}

// ── Form field (add card / add funds) ─────────────────────────────────────────

export const fieldLabel: CSSProperties = {
  display: 'block',
  fontSize: '0.66rem',
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: GLASS.textMuted,
  marginBottom: 7,
};

export function textInput(accent = GLASS.accent): CSSProperties {
  return {
    width: '100%',
    boxSizing: 'border-box',
    padding: '10px 13px',
    borderRadius: 10,
    border: '1px solid rgba(255,255,255,0.12)',
    background: 'rgba(8,10,15,0.55)',
    color: GLASS.text,
    fontSize: '0.9rem',
    fontFamily: MONO,
    outline: 'none',
    transition: 'border-color 0.15s, box-shadow 0.15s',
    // focus styling applied inline by the component via onFocus/onBlur where needed
    boxShadow: `inset 0 1px 0 rgba(255,255,255,0.05)`,
    // accent referenced so callers can theme; used by focus ring below
    caretColor: accent,
  };
}

// ── Auto-recharge toggle ──────────────────────────────────────────────────────

export function toggleTrack(on: boolean, accent = GLASS.accent): CSSProperties {
  return {
    width: 46,
    height: 26,
    borderRadius: 999,
    background: on ? accent : 'rgba(255,255,255,0.12)',
    border: `1px solid ${on ? hexToRgba(accent, 0.5) : 'rgba(255,255,255,0.14)'}`,
    position: 'relative',
    cursor: 'pointer',
    transition: 'background 0.2s ease, border-color 0.2s ease',
    flexShrink: 0,
    boxShadow: on ? `0 0 16px -4px ${hexToRgba(accent, 0.7)}` : 'none',
  };
}

export function toggleKnob(on: boolean): CSSProperties {
  return {
    position: 'absolute',
    top: 2,
    left: on ? 22 : 2,
    width: 20,
    height: 20,
    borderRadius: '50%',
    background: '#fff',
    transition: 'left 0.2s cubic-bezier(0.2,0.7,0.3,1)',
    boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
  };
}
