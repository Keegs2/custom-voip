/**
 * Centralised style objects + builders for the production RCF page. Themed off
 * the app blue (`GLASS.accent`). Presentational components import these instead
 * of inlining the repeated token blocks; one-off structural layout stays inline
 * in the components.
 */

import type { CSSProperties } from 'react';
import { GLASS, hexToRgba } from '../../components/glass/glass';

export const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
export const BLUE = GLASS.accent; // #3b82f6
export const BLUE_LIGHT = '#60a5fa';

// ── On/off toggle switch ─────────────────────────────────────────────────────

export function toggleTrack(active: boolean, pending: boolean): CSSProperties {
  return {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    width: 38,
    height: 22,
    borderRadius: 11,
    border: `1px solid ${active ? hexToRgba(BLUE, 0.55) : 'rgba(255,255,255,0.12)'}`,
    background: active ? 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)' : 'rgba(255,255,255,0.06)',
    transition: 'background 0.2s ease, border-color 0.2s ease, opacity 0.2s',
    opacity: pending ? 0.55 : 1,
    flexShrink: 0,
    padding: 0,
    outline: 'none',
    boxShadow: active ? '0 0 8px rgba(59,130,246,0.35)' : 'none',
  };
}

export function toggleKnob(active: boolean): CSSProperties {
  return {
    position: 'absolute',
    left: active ? 18 : 2,
    width: 16,
    height: 16,
    borderRadius: '50%',
    background: '#fff',
    boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
    transition: 'left 0.2s ease',
  };
}

// ── Table primitives ─────────────────────────────────────────────────────────

export const numbersTh: CSSProperties = {
  padding: '12px 16px',
  textAlign: 'left',
  fontSize: '0.6rem',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.12em',
  whiteSpace: 'nowrap',
  background: 'rgba(59,130,246,0.04)',
  borderBottom: '1px solid rgba(59,130,246,0.10)',
};

export const didTh: CSSProperties = {
  padding: '11px 16px',
  textAlign: 'left',
  fontSize: '0.6rem',
  fontWeight: 700,
  color: GLASS.textFaint,
  textTransform: 'uppercase',
  letterSpacing: '0.11em',
  whiteSpace: 'nowrap',
  background: 'rgba(59,130,246,0.04)',
  borderBottom: '1px solid rgba(59,130,246,0.10)',
};

export const activityTh: CSSProperties = {
  padding: '11px 14px',
  textAlign: 'left',
  fontSize: '0.6rem',
  fontWeight: 700,
  color: GLASS.textFaint,
  textTransform: 'uppercase',
  letterSpacing: '0.11em',
  whiteSpace: 'nowrap',
};

// ── Pills / badges ───────────────────────────────────────────────────────────

export function countPill(active = false): CSSProperties {
  return {
    fontSize: '0.72rem',
    fontWeight: 600,
    color: active ? BLUE_LIGHT : BLUE,
    background: 'rgba(59,130,246,0.10)',
    border: '1px solid rgba(59,130,246,0.20)',
    borderRadius: 20,
    padding: '5px 13px',
    whiteSpace: 'nowrap',
    flexShrink: 0,
    letterSpacing: '0.02em',
  };
}

// ── Modal shell ──────────────────────────────────────────────────────────────

export function modalOverlay(strong = false): CSSProperties {
  return {
    position: 'fixed',
    inset: 0,
    zIndex: 1000,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    background: strong ? 'rgba(0,0,0,0.70)' : 'rgba(0,0,0,0.65)',
    backdropFilter: `blur(${strong ? 5 : 4}px)`,
    WebkitBackdropFilter: `blur(${strong ? 5 : 4}px)`,
    animation: 'glass-rise 0.18s ease',
  };
}
