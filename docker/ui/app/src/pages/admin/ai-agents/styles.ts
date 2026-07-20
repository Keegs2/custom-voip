/**
 * Centralised CSSProperties + builders for the AI Voice Agents admin feature.
 * Everything themes off `GLASS.accent` (app blue); status hues come from the
 * shared tokens. Parameterised styles are small builders; static ones are consts.
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

// ── Table ────────────────────────────────────────────────────────────────────

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
    padding: '13px 16px',
    fontSize: '0.82rem',
    color: opts.muted ? GLASS.textMuted : GLASS.text,
    textAlign: opts.right ? 'right' : 'left',
    borderTop: '1px solid rgba(255,255,255,0.05)',
    verticalAlign: 'middle',
  };
}

export const agentName: CSSProperties = {
  fontSize: '0.9rem',
  fontWeight: 700,
  color: GLASS.text,
  letterSpacing: '-0.01em',
};

export const rowActions: CSSProperties = {
  display: 'flex',
  gap: 6,
  justifyContent: 'flex-end',
  flexWrap: 'wrap',
};

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

// ── Provider chips (in the table) ─────────────────────────────────────────────

export function layerChip(cloud: boolean): CSSProperties {
  const color = cloud ? GLASS.warning : GLASS.success;
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    fontSize: '0.66rem',
    fontWeight: 600,
    color: GLASS.textMuted,
    background: 'rgba(255,255,255,0.03)',
    border: `1px solid ${hexToRgba(color, 0.28)}`,
    borderRadius: 8,
    padding: '3px 8px',
    whiteSpace: 'nowrap',
  };
}

export const layerKind: CSSProperties = {
  fontSize: '0.56rem',
  fontWeight: 800,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  opacity: 0.7,
};

// ── Form ─────────────────────────────────────────────────────────────────────

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

export const formSection: CSSProperties = {
  borderTop: '1px solid rgba(255,255,255,0.07)',
  paddingTop: 20,
};

export const formGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
  gap: 16,
};

export const formError: CSSProperties = {
  color: '#fca5a5',
  fontSize: '0.82rem',
  background: 'rgba(239,68,68,0.1)',
  border: '1px solid rgba(239,68,68,0.28)',
  borderRadius: 10,
  padding: '9px 13px',
};

export const sliderLabel: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  fontSize: '0.68rem',
  fontWeight: 700,
  color: '#4a5568',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  marginBottom: 8,
};

export const sliderValue: CSSProperties = {
  color: GLASS.accent,
  fontFamily: MONO,
  fontSize: '0.72rem',
};

export function slider(): CSSProperties {
  return {
    width: '100%',
    accentColor: GLASS.accent,
    cursor: 'pointer',
  };
}

export function toggleRow(checked: boolean, accent = GLASS.accent): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '12px 14px',
    borderRadius: 12,
    cursor: 'pointer',
    userSelect: 'none',
    border: `1px solid ${checked ? hexToRgba(accent, 0.4) : 'rgba(255,255,255,0.1)'}`,
    background: checked ? hexToRgba(accent, 0.08) : 'rgba(255,255,255,0.02)',
    transition: 'all 0.15s',
  };
}

export function toggleTrack(checked: boolean, accent = GLASS.accent): CSSProperties {
  return {
    width: 38,
    height: 22,
    borderRadius: 999,
    flexShrink: 0,
    position: 'relative',
    background: checked ? accent : 'rgba(255,255,255,0.12)',
    transition: 'background 0.18s',
  };
}

export function toggleKnob(checked: boolean): CSSProperties {
  return {
    position: 'absolute',
    top: 3,
    left: checked ? 19 : 3,
    width: 16,
    height: 16,
    borderRadius: '50%',
    background: '#fff',
    boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
    transition: 'left 0.18s',
  };
}

export const toggleTitle: CSSProperties = { fontSize: '0.82rem', fontWeight: 600, color: GLASS.text };
export const toggleHint: CSSProperties = { fontSize: '0.7rem', color: GLASS.textMuted, marginTop: 2 };

// ── Compliance banner ─────────────────────────────────────────────────────────

export function complianceBanner(inVpc: boolean): CSSProperties {
  const color = inVpc ? GLASS.success : GLASS.warning;
  return {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 12,
    padding: '14px 16px',
    borderRadius: 14,
    background: hexToRgba(color, 0.09),
    border: `1px solid ${hexToRgba(color, 0.32)}`,
    boxShadow: `inset 0 1px 0 rgba(255,255,255,0.06), 0 0 24px -12px ${hexToRgba(color, 0.6)}`,
  };
}

export function complianceIcon(inVpc: boolean): CSSProperties {
  const color = inVpc ? GLASS.success : GLASS.warning;
  return {
    width: 34,
    height: 34,
    borderRadius: 10,
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color,
    background: hexToRgba(color, 0.14),
    border: `1px solid ${hexToRgba(color, 0.3)}`,
  };
}

export function complianceTitle(inVpc: boolean): CSSProperties {
  return {
    fontSize: '0.85rem',
    fontWeight: 800,
    color: inVpc ? '#86efac' : '#fcd34d',
    letterSpacing: '-0.01em',
  };
}

export const complianceBody: CSSProperties = {
  fontSize: '0.75rem',
  color: GLASS.textMuted,
  marginTop: 3,
  lineHeight: 1.5,
};

// ── Runtime detail (code block) ───────────────────────────────────────────────

export function codeBlock(): CSSProperties {
  return {
    fontFamily: MONO,
    fontSize: '0.72rem',
    color: '#93c5fd',
    background: 'rgba(8,10,15,0.6)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 10,
    padding: '12px 14px',
    overflowX: 'auto',
    lineHeight: 1.6,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  };
}

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

export const helpNote: CSSProperties = {
  fontSize: '0.72rem',
  color: GLASS.textFaint,
  lineHeight: 1.5,
};

// ── Select (filter dropdown) ──────────────────────────────────────────────────

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
