/**
 * Centralised style objects for the Onboarding admin page. Presentational
 * components import these instead of inlining big CSSProperties blocks, so the
 * visual language (glass tints, accent usage, spacing, mono font) lives in one
 * place. Parameterised styles are builder functions; static ones are constants.
 *
 * Everything leads with `GLASS.accent` (app blue); status-coloured callouts and
 * chips pass their own `accent`.
 */

import type { CSSProperties } from 'react';
import { GLASS, hexToRgba } from '../../../components/glass/glass';

export const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

// ── Form fields (frosted) ──────────────────────────────────────────────────────

export const inputStyle: CSSProperties = {
  width: '100%',
  fontSize: '0.82rem',
  padding: '9px 13px',
  borderRadius: 10,
  border: '1px solid rgba(255,255,255,0.12)',
  background: 'rgba(8,10,15,0.5)',
  color: GLASS.text,
  outline: 'none',
  boxSizing: 'border-box',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
};

export const textareaStyle: CSSProperties = {
  ...inputStyle,
  resize: 'vertical',
  minHeight: 76,
  fontFamily: 'inherit',
  lineHeight: 1.5,
};

// ── Labels ───────────────────────────────────────────────────────────────────

export function sectionLabel(accent = GLASS.accent): CSSProperties {
  return {
    fontSize: '0.6rem',
    fontWeight: 700,
    color: accent,
    textTransform: 'uppercase',
    letterSpacing: '0.12em',
    marginBottom: 12,
  };
}

export const fieldLabel: CSSProperties = {
  fontSize: '0.66rem',
  fontWeight: 600,
  color: GLASS.textMuted,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
  marginBottom: 4,
  display: 'block',
};

export const fieldValue: CSSProperties = {
  fontSize: '0.875rem',
  color: GLASS.text,
};

// ── Status-tinted callout panel ───────────────────────────────────────────────
// A translucent, accent-tinted inset panel used for the billing / reject /
// provisioning / active / rejected sub-sections. Keeps strong contrast by
// staying dark-fill + thin accent border.

export function callout(accent = GLASS.accent): CSSProperties {
  return {
    padding: '16px 18px',
    borderRadius: 14,
    background: hexToRgba(accent, 0.05),
    border: `1px solid ${hexToRgba(accent, 0.2)}`,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  };
}

/** A neutral inset detail block (for read-only field grids). */
export const detailGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
  gap: '12px 24px',
};

export const detailGridTwo: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: '10px 24px',
};

// ── Status filter tabs ─────────────────────────────────────────────────────────

export function tabBtn(active: boolean, accent = GLASS.accent): CSSProperties {
  return {
    padding: '8px 16px',
    fontSize: '0.82rem',
    fontWeight: active ? 700 : 500,
    whiteSpace: 'nowrap',
    borderRadius: 10,
    border: active ? `1px solid ${hexToRgba(accent, 0.4)}` : '1px solid transparent',
    color: active ? GLASS.text : GLASS.textMuted,
    background: active ? hexToRgba(accent, 0.14) : 'transparent',
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'color 0.18s, background 0.18s, border-color 0.18s',
    boxShadow: active ? `inset 0 0 0 1px ${hexToRgba(accent, 0.18)}` : 'none',
  };
}

// ── Card summary row ───────────────────────────────────────────────────────────

export function summaryRow(): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 20,
    padding: '16px 22px',
    cursor: 'pointer',
    userSelect: 'none',
  };
}

export function chevron(expanded: boolean): CSSProperties {
  return {
    color: GLASS.textFaint,
    display: 'inline-flex',
    transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
    transition: 'transform 0.2s ease',
    flexShrink: 0,
  };
}

export const companyName: CSSProperties = {
  fontSize: '0.92rem',
  fontWeight: 700,
  color: GLASS.text,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  textShadow: '0 1px 10px rgba(0,0,0,0.5)',
};

export const companyContact: CSSProperties = {
  fontSize: '0.75rem',
  color: GLASS.textMuted,
  marginTop: 2,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export function didCount(accent = GLASS.accent): CSSProperties {
  return {
    fontSize: '1.05rem',
    fontWeight: 800,
    fontFamily: MONO,
    color: accent,
    textShadow: `0 0 12px ${hexToRgba(accent, 0.28)}`,
    lineHeight: 1,
  };
}

export const didCountLabel: CSSProperties = {
  fontSize: '0.55rem',
  fontWeight: 700,
  color: GLASS.textFaint,
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
  marginTop: 3,
};

export const timelineCell: CSSProperties = {
  fontSize: '0.75rem',
  color: GLASS.textMuted,
  flexShrink: 0,
  maxWidth: 120,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export const submittedCell: CSSProperties = {
  fontSize: '0.72rem',
  color: GLASS.textFaint,
  flexShrink: 0,
};

// ── Card detail panel ──────────────────────────────────────────────────────────

export const detailPanel: CSSProperties = {
  padding: '20px 22px 24px',
  display: 'flex',
  flexDirection: 'column',
  gap: 24,
  borderTop: '1px solid rgba(255,255,255,0.08)',
};

// ── Column header (above the card list) ─────────────────────────────────────────

export const colHeaderRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 20,
  padding: '0 22px',
};

export const colHeaderLabel: CSSProperties = {
  fontSize: '0.6rem',
  fontWeight: 700,
  color: GLASS.textFaint,
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
};

// ── DID selector (provisioning form) ─────────────────────────────────────────────

export const didListWrap: CSSProperties = {
  maxHeight: 220,
  overflowY: 'auto',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 12,
  background: 'rgba(8,10,15,0.4)',
};

export function didRow(selected: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '9px 14px',
    cursor: 'pointer',
    background: selected ? hexToRgba(GLASS.accent, 0.1) : 'transparent',
    borderBottom: '1px solid rgba(255,255,255,0.05)',
    transition: 'background 0.12s',
  };
}

export const didMono: CSSProperties = {
  fontFamily: MONO,
  fontSize: '0.83rem',
  color: GLASS.text,
  flex: 1,
};

export const didMeta: CSSProperties = {
  fontSize: '0.72rem',
  color: GLASS.textFaint,
};

export const forwardRowLabel: CSSProperties = {
  fontFamily: MONO,
  fontSize: '0.8rem',
  color: GLASS.textMuted,
  minWidth: 160,
  flexShrink: 0,
};

export function approveBtnGlow(ready: boolean, accent = GLASS.accent): CSSProperties {
  return {
    alignSelf: 'flex-start',
    boxShadow: ready ? `0 0 24px -4px ${hexToRgba(accent, 0.5)}` : 'none',
  };
}

// ── Credentials modal ────────────────────────────────────────────────────────────

export function modalBanner(accent: string): CSSProperties {
  return {
    padding: '14px 16px',
    borderRadius: 12,
    background: hexToRgba(accent, 0.08),
    border: `1px solid ${hexToRgba(accent, 0.22)}`,
    color: accent,
    fontSize: '0.82rem',
    lineHeight: 1.55,
  };
}

export const credBox: CSSProperties = {
  background: 'rgba(8,10,15,0.5)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 14,
  padding: '16px 18px',
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
};

export const credCode: CSSProperties = {
  flex: 1,
  padding: '9px 12px',
  borderRadius: 9,
  background: hexToRgba(GLASS.accent, 0.08),
  border: `1px solid ${hexToRgba(GLASS.accent, 0.22)}`,
  color: '#bfdbfe',
  fontSize: '0.9rem',
  letterSpacing: '0.04em',
  fontFamily: MONO,
  wordBreak: 'break-all',
};

export const provisionedDidRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '8px 13px',
  borderRadius: 9,
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.07)',
};

// ── Skeleton shimmer ─────────────────────────────────────────────────────────────

export function shimmerLine(w: string | number, h: number): CSSProperties {
  return {
    width: w,
    height: h,
    borderRadius: 6,
    background:
      'linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.1) 37%, rgba(255,255,255,0.04) 63%)',
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

export function spinnerRing(accent = GLASS.accent): CSSProperties {
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

// ── Hero ─────────────────────────────────────────────────────────────────────────

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
    fontSize: 'clamp(1.7rem, 3vw, 2.3rem)',
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
  fontSize: '0.9rem',
  color: GLASS.textMuted,
  maxWidth: 560,
  lineHeight: 1.55,
};
