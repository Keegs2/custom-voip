/**
 * Centralised CSSProperties + style builders for the DID Search feature.
 *
 * Presentational components import these rather than inlining big style blocks,
 * so spacing, accent usage, and the mono number font all live in one place.
 * Everything is themed off `GLASS.accent` (app blue) and re-tintable via an
 * optional `accent` argument on the builder functions.
 */

import type { CSSProperties } from 'react';
import { GLASS, hexToRgba } from '../../../components/glass/glass';

export const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

// ── Hero ─────────────────────────────────────────────────────────────────────

export function heroIcon(accent = GLASS.accent): CSSProperties {
  return {
    width: 46,
    height: 46,
    borderRadius: 13,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    color: accent,
    background: `linear-gradient(135deg, ${hexToRgba(accent, 0.22)} 0%, ${hexToRgba(accent, 0.07)} 100%)`,
    border: `1px solid ${hexToRgba(accent, 0.3)}`,
    boxShadow: `0 0 22px ${hexToRgba(accent, 0.18)}`,
  };
}

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
    fontSize: 'clamp(1.7rem, 3.4vw, 2.4rem)',
    fontWeight: 800,
    letterSpacing: '-0.025em',
    lineHeight: 1.08,
    margin: 0,
    color: GLASS.text,
    background: `linear-gradient(120deg, #ffffff 0%, ${GLASS.text} 35%, ${hexToRgba(accent, 0.85)} 110%)`,
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
  };
}

export const heroSubtitle: CSSProperties = {
  margin: '8px 0 0',
  fontSize: '0.9rem',
  color: GLASS.textMuted,
  maxWidth: 560,
  lineHeight: 1.55,
};

// ── Stat tile ──────────────────────────────────────────────────────────────────

export function statIconBox(accent: string): CSSProperties {
  return {
    width: 40,
    height: 40,
    borderRadius: 11,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: hexToRgba(accent, 0.14),
    border: `1px solid ${hexToRgba(accent, 0.3)}`,
    color: accent,
    flexShrink: 0,
  };
}

export const statValue: CSSProperties = {
  fontSize: '1.5rem',
  fontWeight: 800,
  color: GLASS.text,
  letterSpacing: '-0.03em',
  lineHeight: 1,
  marginBottom: 4,
};

export const statLabel: CSSProperties = {
  fontSize: '0.66rem',
  color: GLASS.textMuted,
  fontWeight: 600,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
};

// ── Table ──────────────────────────────────────────────────────────────────────

export const tableWrap: CSSProperties = { overflowX: 'auto' };

export const table: CSSProperties = { width: '100%', borderCollapse: 'collapse' };

export function th(right = false): CSSProperties {
  return {
    textAlign: right ? 'right' : 'left',
    fontSize: '0.6rem',
    fontWeight: 700,
    color: GLASS.textMuted,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    padding: '12px 16px',
    whiteSpace: 'nowrap',
    background: 'rgba(255,255,255,0.025)',
    borderBottom: '1px solid rgba(255,255,255,0.08)',
  };
}

export function td(opts: { muted?: boolean; right?: boolean } = {}): CSSProperties {
  return {
    padding: '12px 16px',
    fontSize: '0.82rem',
    color: opts.muted ? GLASS.textMuted : GLASS.text,
    textAlign: opts.right ? 'right' : 'left',
    borderTop: '1px solid rgba(255,255,255,0.05)',
    verticalAlign: 'middle',
  };
}

export const didCell: CSSProperties = {
  fontFamily: MONO,
  fontSize: '0.85rem',
  fontWeight: 700,
  color: '#93c5fd',
  letterSpacing: '0.03em',
  whiteSpace: 'nowrap',
};

export const dash: CSSProperties = { color: GLASS.textFaint, fontSize: '0.8rem' };

export const notesCell: CSSProperties = {
  maxWidth: 200,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  display: 'block',
};

// ── Panel toolbar (count + actions strip atop a table panel) ─────────────────────

export const panelToolbar: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '14px 18px',
  borderBottom: '1px solid rgba(255,255,255,0.06)',
};

export const countText: CSSProperties = { fontSize: '0.78rem', color: GLASS.textMuted };

export const countStrong: CSSProperties = { color: GLASS.text, fontWeight: 700 };

// ── Filter bar ──────────────────────────────────────────────────────────────────

export const filterBar: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 10,
  padding: '14px 18px',
  borderBottom: '1px solid rgba(255,255,255,0.06)',
  alignItems: 'center',
};

export function searchWrap(focused: boolean, accent = GLASS.accent): CSSProperties {
  return {
    position: 'relative',
    flex: '1 1 220px',
    minWidth: 180,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 12px',
    borderRadius: 10,
    background: 'rgba(255,255,255,0.04)',
    border: `1px solid ${focused ? hexToRgba(accent, 0.45) : 'rgba(255,255,255,0.10)'}`,
    boxShadow: focused
      ? `0 0 0 3px ${hexToRgba(accent, 0.12)}, inset 0 1px 0 rgba(255,255,255,0.06)`
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
  fontSize: '0.82rem',
  fontFamily: 'inherit',
};

export function clearBtn(): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    background: 'none',
    border: 'none',
    color: GLASS.textFaint,
    cursor: 'pointer',
    padding: 0,
    flexShrink: 0,
  };
}

export function selectStyle(active: boolean): CSSProperties {
  return {
    appearance: 'none',
    padding: '8px 30px 8px 12px',
    borderRadius: 10,
    border: '1px solid rgba(255,255,255,0.10)',
    background:
      'rgba(255,255,255,0.04) url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'12\' height=\'12\' viewBox=\'0 0 12 12\' fill=\'none\' stroke=\'%2394a3b8\' stroke-width=\'1.6\'><path d=\'M3 4.5L6 7.5L9 4.5\'/></svg>") no-repeat right 10px center',
    color: active ? GLASS.text : GLASS.textFaint,
    fontSize: '0.8rem',
    fontFamily: 'inherit',
    outline: 'none',
    cursor: 'pointer',
    minWidth: 110,
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
  };
}

// ── Tab bar ──────────────────────────────────────────────────────────────────────

export const tabBarWrap: CSSProperties = {
  display: 'inline-flex',
  gap: 4,
  padding: 5,
  borderRadius: 14,
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.10)',
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
};

export function tabBtn(active: boolean, accent = GLASS.accent): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    padding: '8px 16px',
    borderRadius: 10,
    border: 'none',
    background: active ? hexToRgba(accent, 0.16) : 'transparent',
    color: active ? accent : GLASS.textMuted,
    fontSize: '0.8rem',
    fontWeight: active ? 700 : 500,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    fontFamily: 'inherit',
    boxShadow: active ? `inset 0 0 0 1px ${hexToRgba(accent, 0.3)}` : 'none',
    transition: 'background 0.18s, color 0.18s',
  };
}

// ── Assignments group header ──────────────────────────────────────────────────────

export const groupHeader: CSSProperties = {
  padding: '11px 18px',
  display: 'flex',
  alignItems: 'center',
  gap: 9,
  borderTop: '1px solid rgba(255,255,255,0.05)',
  background: 'rgba(255,255,255,0.02)',
};

export const groupName: CSSProperties = {
  fontSize: '0.78rem',
  fontWeight: 700,
  color: '#93c5fd',
  letterSpacing: '0.02em',
};

export function groupCount(accent = GLASS.accent): CSSProperties {
  return {
    fontSize: '0.62rem',
    fontWeight: 700,
    color: accent,
    background: hexToRgba(accent, 0.1),
    border: `1px solid ${hexToRgba(accent, 0.2)}`,
    padding: '1px 8px',
    borderRadius: 6,
  };
}

// ── States / spinner ───────────────────────────────────────────────────────────

export const statePad: CSSProperties = {
  textAlign: 'center',
  padding: '52px 24px',
  color: GLASS.textFaint,
  fontSize: '0.84rem',
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
  };
}

// ── Assign-modal DID summary card ──────────────────────────────────────────────────

export function modalDidCard(accent = GLASS.accent): CSSProperties {
  return {
    padding: '12px 14px',
    background: hexToRgba(accent, 0.06),
    border: `1px solid ${hexToRgba(accent, 0.18)}`,
    borderRadius: 12,
    display: 'flex',
    alignItems: 'center',
    gap: 11,
  };
}

export const modalDidNumber: CSSProperties = {
  fontSize: '0.95rem',
  fontWeight: 700,
  color: GLASS.text,
  fontFamily: MONO,
  letterSpacing: '0.02em',
};

export const modalDidMeta: CSSProperties = {
  fontSize: '0.72rem',
  color: GLASS.textMuted,
  marginTop: 2,
};

export const dangerNote: CSSProperties = {
  padding: '11px 14px',
  background: hexToRgba(GLASS.danger, 0.08),
  border: `1px solid ${hexToRgba(GLASS.danger, 0.22)}`,
  borderRadius: 10,
  fontSize: '0.75rem',
  color: '#f87171',
  lineHeight: 1.55,
};
