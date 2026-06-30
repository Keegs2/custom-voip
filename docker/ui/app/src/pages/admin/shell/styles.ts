/**
 * Centralised style objects + builders for the admin tab-shell chrome.
 * Colours come from the canonical glass tokens (blue accent); surfaces are built
 * with the glass kit (GlassPanel) in the components, so this file holds only the
 * inner layout + the per-state tab-link styling.
 */

import type { CSSProperties } from 'react';
import { GLASS, hexToRgba } from '../../../components/glass/glass';

/** Outer stack: even vertical rhythm between hero → tabs → content (no top pad — AppLayout owns it). */
export const shellStack: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 24,
};

// ── Hero ─────────────────────────────────────────────────────────────────────

export const heroRow: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 24,
};

export const heroLogoBadge: CSSProperties = {
  width: 56,
  height: 56,
  borderRadius: 14,
  background: `linear-gradient(135deg, ${hexToRgba(GLASS.accent, 0.18)} 0%, ${hexToRgba(GLASS.accent, 0.08)} 100%)`,
  border: `1px solid ${hexToRgba(GLASS.accent, 0.28)}`,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  boxShadow: `0 0 24px ${hexToRgba(GLASS.accent, 0.2)}`,
  flexShrink: 0,
};

export const heroLogoImg: CSSProperties = {
  width: 40,
  height: 40,
  objectFit: 'contain',
  filter: `drop-shadow(0 0 8px ${hexToRgba(GLASS.accent, 0.55)}) brightness(1.1)`,
};

export const heroEyebrow: CSSProperties = {
  fontSize: '0.6rem',
  fontWeight: 700,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: GLASS.accent,
  opacity: 0.85,
  marginBottom: 6,
};

export const heroTitle: CSSProperties = {
  fontSize: 'clamp(1.2rem, 2.5vw, 1.55rem)',
  fontWeight: 800,
  color: GLASS.text,
  letterSpacing: '-0.025em',
  lineHeight: 1.15,
  margin: '0 0 8px',
  // Scrim-free legibility: solid bright text over the blurred surface.
  textShadow: '0 1px 12px rgba(0,0,0,0.45)',
};

export const heroSubtitle: CSSProperties = {
  fontSize: '0.85rem',
  color: GLASS.textMuted,
  lineHeight: 1.6,
  margin: 0,
  maxWidth: 520,
};

// ── Tab bar ────────────────────────────────────────────────────────────────

export const tabNav: CSSProperties = {
  display: 'flex',
  justifyContent: 'center',
  gap: 6,
  flexWrap: 'nowrap',
};

/** Per-tab link style, parameterised by active + hover (hover owned by the component, #310-safe). */
export function tabLink(active: boolean, hovered: boolean): CSSProperties {
  return {
    padding: '8px 18px',
    fontSize: '0.85rem',
    fontWeight: active ? 600 : 500,
    whiteSpace: 'nowrap',
    textDecoration: 'none',
    borderRadius: 10,
    fontFamily: 'inherit',
    color: active ? GLASS.text : hovered ? '#cbd5e0' : GLASS.textMuted,
    background: active
      ? `linear-gradient(135deg, ${hexToRgba(GLASS.accent, 0.2)} 0%, ${hexToRgba(GLASS.accent, 0.07)} 100%)`
      : hovered
        ? 'rgba(255,255,255,0.05)'
        : 'transparent',
    border: active ? `1px solid ${hexToRgba(GLASS.accent, 0.4)}` : '1px solid transparent',
    boxShadow: active
      ? `0 0 14px ${hexToRgba(GLASS.accent, 0.18)}, inset 0 1px 0 rgba(255,255,255,0.06)`
      : 'none',
    transition: 'color 0.15s, background 0.15s, border-color 0.15s, box-shadow 0.15s',
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  };
}

export const tabActiveDot: CSSProperties = {
  position: 'absolute',
  bottom: 3,
  left: '50%',
  transform: 'translateX(-50%)',
  width: 3,
  height: 3,
  borderRadius: '50%',
  background: GLASS.accent,
  boxShadow: `0 0 5px ${GLASS.accent}`,
};
