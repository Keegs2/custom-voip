/**
 * Centralised CSSProperties + builders for the Least-Cost Outbound admin feature.
 * Themes off `GLASS.accent` (app blue). Parameterised styles are builder functions.
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

export const prefixCell: CSSProperties = {
  fontFamily: MONO,
  fontSize: '0.84rem',
  fontWeight: 700,
  color: '#93c5fd',
  letterSpacing: '0.02em',
};

export const costCell: CSSProperties = {
  fontFamily: MONO,
  fontSize: '0.82rem',
  color: GLASS.text,
  fontWeight: 600,
};

export const dash: CSSProperties = { color: GLASS.textFaint, fontSize: '0.8rem' };

export function jurChip(): CSSProperties {
  return {
    fontSize: '0.6rem',
    fontWeight: 700,
    color: GLASS.cyan,
    background: hexToRgba(GLASS.cyan, 0.1),
    border: `1px solid ${hexToRgba(GLASS.cyan, 0.28)}`,
    borderRadius: 6,
    padding: '2px 8px',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  };
}

export function modeChip(allow: boolean): CSSProperties {
  const color = allow ? GLASS.success : GLASS.danger;
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    fontSize: '0.62rem',
    fontWeight: 800,
    color,
    background: hexToRgba(color, 0.1),
    border: `1px solid ${hexToRgba(color, 0.3)}`,
    borderRadius: 6,
    padding: '3px 9px',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  };
}

export function iconBtn(tone: 'accent' | 'danger' | 'muted', hovered: boolean): CSSProperties {
  const color = tone === 'danger' ? '#f87171' : tone === 'accent' ? GLASS.accent : GLASS.textMuted;
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    background: hovered ? hexToRgba(color, 0.14) : 'rgba(255,255,255,0.03)',
    border: `1px solid ${hovered ? hexToRgba(color, 0.4) : 'rgba(255,255,255,0.12)'}`,
    borderRadius: 9,
    cursor: 'pointer',
    color: tone === 'muted' && !hovered ? GLASS.textMuted : color,
    fontSize: '0.72rem',
    padding: '5px 10px',
    fontWeight: 700,
    fontFamily: 'inherit',
    transition: 'all 0.15s',
  };
}

// ── Filter / toolbar ──────────────────────────────────────────────────────────

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

export function searchWrap(focused: boolean, accent = GLASS.accent): CSSProperties {
  return {
    position: 'relative',
    flex: '1 1 200px',
    minWidth: 160,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 12px',
    borderRadius: 10,
    background: 'rgba(255,255,255,0.04)',
    border: `1px solid ${focused ? hexToRgba(accent, 0.45) : 'rgba(255,255,255,0.10)'}`,
    boxShadow: focused ? `0 0 0 3px ${hexToRgba(accent, 0.12)}` : 'none',
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

// ── Route preview path ────────────────────────────────────────────────────────

export function routeHop(rank: number): CSSProperties {
  const cheapest = rank === 0;
  const accent = cheapest ? GLASS.success : GLASS.accent;
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    padding: '14px 16px',
    borderRadius: 14,
    background: hexToRgba(accent, cheapest ? 0.1 : 0.05),
    border: `1px solid ${hexToRgba(accent, cheapest ? 0.35 : 0.2)}`,
  };
}

export function rankBadge(rank: number): CSSProperties {
  const cheapest = rank === 0;
  const accent = cheapest ? GLASS.success : GLASS.accent;
  return {
    width: 30,
    height: 30,
    borderRadius: 9,
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '0.8rem',
    fontWeight: 800,
    color: accent,
    background: hexToRgba(accent, 0.14),
    border: `1px solid ${hexToRgba(accent, 0.3)}`,
    fontFamily: MONO,
  };
}

// ── Savings summary tiles ─────────────────────────────────────────────────────

export function summaryTile(accent = GLASS.accent): CSSProperties {
  return {
    flex: 1,
    minWidth: 150,
    padding: '18px 20px',
    borderRadius: 16,
    background: hexToRgba(accent, 0.06),
    border: `1px solid ${hexToRgba(accent, 0.2)}`,
  };
}
export const summaryValue: CSSProperties = { fontSize: '1.7rem', fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1 };
export const summaryLabel: CSSProperties = {
  fontSize: '0.64rem',
  color: GLASS.textMuted,
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  marginTop: 8,
};

// ── Form / modal ──────────────────────────────────────────────────────────────

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

export function codeBlock(): CSSProperties {
  return {
    fontFamily: MONO,
    fontSize: '0.74rem',
    color: '#93c5fd',
    background: 'rgba(8,10,15,0.6)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 10,
    padding: '10px 12px',
    overflowX: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
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
