/**
 * Shared style objects for the live-ops monitoring pages (live calls, queues,
 * recordings, media streams, live conferences). These five pages share the same
 * visual language — frosted tables, glass control bars, status chips, stat tiles
 * and loading/error/offline/empty states — so the reusable CSSProperties live
 * here rather than being duplicated per page.
 *
 * Everything is themed off the app blue (`GLASS.accent`) and may be re-tinted by
 * passing a different `accent` into the builder functions. Mirrors the reference
 * implementation in `pages/rcf-glass/styles.ts`.
 */

import type { CSSProperties } from 'react';
import { GLASS, hexToRgba } from '../../../components/glass/glass';

export const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/** Section gap between major page blocks (matches the app spacing standard). */
export const SECTION_GAP = 32;
/** Gap between cards / rows in a list. */
export const CARD_GAP = 16;

// ── Hero ─────────────────────────────────────────────────────────────────────

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

export function heroEyebrow(accent = GLASS.accent): CSSProperties {
  return {
    fontSize: '0.66rem',
    fontWeight: 700,
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    color: accent,
  };
}

export function heroTitle(accent = GLASS.accent): CSSProperties {
  return {
    fontSize: 'clamp(1.7rem, 3.2vw, 2.4rem)',
    fontWeight: 800,
    letterSpacing: '-0.02em',
    lineHeight: 1.05,
    margin: 0,
    color: GLASS.text,
    background: `linear-gradient(120deg, #ffffff 0%, ${GLASS.text} 38%, ${hexToRgba(accent, 0.85)} 115%)`,
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
  };
}

export const heroSubtitle: CSSProperties = {
  margin: '10px 0 0',
  fontSize: '0.92rem',
  color: GLASS.textMuted,
  maxWidth: 640,
  lineHeight: 1.55,
};

// ── Table cells ──────────────────────────────────────────────────────────────

export const th: CSSProperties = {
  textAlign: 'left',
  fontSize: '0.62rem',
  fontWeight: 700,
  color: GLASS.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  padding: '12px 18px',
  whiteSpace: 'nowrap',
};

export const thRight: CSSProperties = { ...th, textAlign: 'right' };

export const td: CSSProperties = {
  padding: '13px 18px',
  fontSize: '0.85rem',
  color: GLASS.text,
  borderTop: '1px solid rgba(255,255,255,0.05)',
  verticalAlign: 'middle',
};

export const tdRight: CSSProperties = { ...td, textAlign: 'right' };

export const tdMono: CSSProperties = {
  ...td,
  fontFamily: MONO,
  fontSize: '0.78rem',
  color: GLASS.textMuted,
};

export const tdNum: CSSProperties = {
  ...td,
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
  color: '#cbd5e1',
};

export const theadRow: CSSProperties = { background: 'rgba(255,255,255,0.025)' };

// ── Controls (filters bar) ───────────────────────────────────────────────────

export const filterLabel: CSSProperties = {
  fontSize: '0.6rem',
  fontWeight: 700,
  color: GLASS.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
  marginBottom: 6,
  display: 'block',
};

export function glassInput(focused: boolean, accent = GLASS.accent): CSSProperties {
  return {
    width: '100%',
    boxSizing: 'border-box',
    padding: '9px 14px',
    borderRadius: 12,
    background: 'rgba(255,255,255,0.04)',
    border: `1px solid ${focused ? hexToRgba(accent, 0.45) : 'rgba(255,255,255,0.10)'}`,
    boxShadow: focused
      ? `0 0 0 3px ${hexToRgba(accent, 0.12)}, inset 0 1px 0 rgba(255,255,255,0.08)`
      : 'inset 0 1px 0 rgba(255,255,255,0.06)',
    color: GLASS.text,
    fontSize: '0.85rem',
    fontFamily: 'inherit',
    outline: 'none',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    transition: 'border-color 0.18s, box-shadow 0.18s',
  };
}

/** Compact frosted input used inside dense control rows (no focus animation). */
export const controlInput: CSSProperties = {
  flex: 1,
  minWidth: 0,
  boxSizing: 'border-box',
  padding: '7px 11px',
  borderRadius: 9,
  background: 'rgba(8,10,15,0.45)',
  border: '1px solid rgba(255,255,255,0.10)',
  color: GLASS.text,
  fontSize: '0.78rem',
  fontFamily: MONO,
  outline: 'none',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
};

export const selectStyle: CSSProperties = {
  appearance: 'none',
  padding: '9px 32px 9px 14px',
  borderRadius: 12,
  border: '1px solid rgba(255,255,255,0.10)',
  background:
    'rgba(255,255,255,0.04) url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'12\' height=\'12\' viewBox=\'0 0 12 12\' fill=\'none\' stroke=\'%2394a3b8\' stroke-width=\'1.6\'><path d=\'M3 4.5L6 7.5L9 4.5\'/></svg>") no-repeat right 12px center',
  color: GLASS.text,
  fontSize: '0.82rem',
  fontFamily: 'inherit',
  outline: 'none',
  cursor: 'pointer',
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
};

// ── Stat tiles ───────────────────────────────────────────────────────────────

export function statTile(accent = GLASS.accent): CSSProperties {
  return {
    padding: '16px 18px',
    borderRadius: 16,
    background: `linear-gradient(160deg, ${hexToRgba(accent, 0.09)} 0%, rgba(255,255,255,0.012) 70%)`,
    border: `1px solid ${hexToRgba(accent, 0.18)}`,
    backdropFilter: 'blur(14px)',
    WebkitBackdropFilter: 'blur(14px)',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  };
}

export const statTileLabel: CSSProperties = {
  fontSize: '0.62rem',
  fontWeight: 700,
  color: GLASS.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
};

export function statTileValue(accent = GLASS.accent): CSSProperties {
  return {
    fontSize: '1.6rem',
    fontWeight: 800,
    color: GLASS.text,
    fontVariantNumeric: 'tabular-nums',
    textShadow: `0 0 18px ${hexToRgba(accent, 0.25)}`,
    lineHeight: 1.1,
  };
}

// ── States / skeletons ───────────────────────────────────────────────────────

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

export function spinner(accent = GLASS.accent): CSSProperties {
  return {
    width: 15,
    height: 15,
    borderRadius: '50%',
    border: `2px solid ${hexToRgba(accent, 0.25)}`,
    borderTopColor: accent,
    animation: 'glass-spin 0.7s linear infinite',
    display: 'inline-block',
  };
}

// ── Misc helpers ─────────────────────────────────────────────────────────────

/** Truncate a long id, keeping a fixed prefix length. */
export function truncId(id: string, len = 18): string {
  return id.length > len ? `${id.slice(0, len)}…` : id;
}
