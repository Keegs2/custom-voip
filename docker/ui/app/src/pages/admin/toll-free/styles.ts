/**
 * Centralised CSSProperties + builders for the Toll-Free / RespOrg admin feature.
 * Themes off `GLASS.accent` (app blue); status hues come from types.ts maps.
 */

import type { CSSProperties } from 'react';
import { GLASS, hexToRgba } from '../../../components/glass/glass';

export const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

// ── Section header ────────────────────────────────────────────────────────────

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
    padding: '9px 16px',
    borderRadius: 12,
    border: 'none',
    background: `linear-gradient(135deg, ${accent} 0%, ${hexToRgba(accent, 0.78)} 100%)`,
    color: '#fff',
    fontSize: '0.8rem',
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
    boxShadow: hovered ? `0 10px 26px -8px ${hexToRgba(accent, 0.7)}` : `0 6px 18px -8px ${hexToRgba(accent, 0.5)}`,
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
    padding: '8px 14px',
    borderRadius: 12,
    border: `1px solid ${hovered && !disabled ? hexToRgba(accent, 0.4) : 'rgba(255,255,255,0.12)'}`,
    background: hovered && !disabled ? hexToRgba(accent, 0.1) : 'rgba(255,255,255,0.04)',
    color: disabled ? GLASS.textFaint : hovered ? accent : GLASS.text,
    fontSize: '0.8rem',
    fontWeight: 700,
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontFamily: 'inherit',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    transition: 'all 0.18s ease',
    opacity: disabled ? 0.6 : 1,
  };
}

export function spinnerRing(accent = GLASS.accent, size = 13): CSSProperties {
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

// ── Stat tiles ────────────────────────────────────────────────────────────────

export const statValue: CSSProperties = {
  fontSize: '1.4rem',
  fontWeight: 800,
  color: GLASS.text,
  letterSpacing: '-0.03em',
  lineHeight: 1,
};

export const statLabel: CSSProperties = {
  fontSize: '0.64rem',
  color: GLASS.textMuted,
  fontWeight: 600,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  marginTop: 5,
};

// ── Table ─────────────────────────────────────────────────────────────────────

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

export const tfnCell: CSSProperties = {
  fontFamily: MONO,
  fontSize: '0.85rem',
  fontWeight: 700,
  color: '#93c5fd',
  letterSpacing: '0.03em',
  whiteSpace: 'nowrap',
};

export const dash: CSSProperties = { color: GLASS.textFaint, fontSize: '0.8rem' };

export function statusChip(color: string): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    fontSize: '0.6rem',
    fontWeight: 800,
    color,
    background: hexToRgba(color, 0.1),
    border: `1px solid ${hexToRgba(color, 0.3)}`,
    borderRadius: 6,
    padding: '3px 9px',
    letterSpacing: '0.05em',
    textTransform: 'uppercase',
    whiteSpace: 'nowrap',
  };
}

// ── Filter / toolbar ──────────────────────────────────────────────────────────

export const filterBar: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 10,
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
    boxShadow: focused ? `0 0 0 3px ${hexToRgba(accent, 0.12)}, inset 0 1px 0 rgba(255,255,255,0.06)` : 'inset 0 1px 0 rgba(255,255,255,0.05)',
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
    minWidth: 130,
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
  };
}

export function clearBtn(): CSSProperties {
  return { display: 'flex', alignItems: 'center', background: 'none', border: 'none', color: GLASS.textFaint, cursor: 'pointer', padding: 0, flexShrink: 0 };
}

// ── Selection bar ─────────────────────────────────────────────────────────────

export function selectionBar(): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '10px 16px',
    borderRadius: 12,
    background: hexToRgba(GLASS.accent, 0.1),
    border: `1px solid ${hexToRgba(GLASS.accent, 0.28)}`,
  };
}

// ── Detail / modal ────────────────────────────────────────────────────────────

export const detailRow: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
  padding: '8px 0',
  borderBottom: '1px solid rgba(255,255,255,0.05)',
  fontSize: '0.78rem',
};
export const detailKey: CSSProperties = { color: GLASS.textMuted };
export const detailVal: CSSProperties = { color: GLASS.text, fontWeight: 600, textAlign: 'right' };

export function groupLabel(accent = GLASS.accent): CSSProperties {
  return {
    fontSize: '0.65rem',
    fontWeight: 700,
    color: accent,
    textTransform: 'uppercase',
    letterSpacing: '0.1em',
    marginBottom: 12,
    display: 'flex',
    alignItems: 'center',
    gap: 7,
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

export const noteBox: CSSProperties = {
  fontSize: '0.74rem',
  color: GLASS.textMuted,
  lineHeight: 1.55,
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 10,
  padding: '11px 13px',
};

// ── Import progress ───────────────────────────────────────────────────────────

export function progressTrack(): CSSProperties {
  return { width: '100%', height: 10, borderRadius: 999, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' };
}
export function progressFill(pct: number, accent = GLASS.accent): CSSProperties {
  return {
    width: `${Math.max(0, Math.min(100, pct))}%`,
    height: '100%',
    borderRadius: 999,
    background: `linear-gradient(90deg, ${accent}, ${hexToRgba(accent, 0.7)})`,
    transition: 'width 0.4s ease',
  };
}
export function importStat(accent = GLASS.accent): CSSProperties {
  return {
    flex: 1,
    minWidth: 92,
    textAlign: 'center',
    padding: '10px 8px',
    borderRadius: 10,
    background: hexToRgba(accent, 0.06),
    border: `1px solid ${hexToRgba(accent, 0.18)}`,
  };
}

// ── States ────────────────────────────────────────────────────────────────────

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
    background: 'linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.10) 37%, rgba(255,255,255,0.04) 63%)',
    backgroundSize: '200% 100%',
    animation: 'glass-shimmer 1.4s ease-in-out infinite',
  };
}
