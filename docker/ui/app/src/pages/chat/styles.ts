/**
 * Centralised style objects for the Chat page (liquid-glass, app blue).
 *
 * Static styles are exported as constants; parameterised ones as small builder
 * functions. Everything is themed off `GLASS.accent` so the page refracts light
 * the same way as the rest of the glass kit.
 */

import type { CSSProperties } from 'react';
import { GLASS, glassSurface, hexToRgba } from '../../components/glass/glass';
import { LIST_PANE_WIDTH, SIDEBAR_WIDTH } from './types';

// ── Page shell ───────────────────────────────────────────────────────────────

/** Full-viewport root. GlassBackground sits fixed behind it (zIndex 0). */
export const root: CSSProperties = {
  position: 'relative',
  minHeight: '100vh',
  background: GLASS.bg,
};

/**
 * The content column to the right of the fixed sidebar. Padded so the frosted
 * chat frame floats with breathing room (never glued to the viewport edges) and
 * the ambient backdrop shows around it. `boxSizing: border-box` keeps the
 * 100vh height honest with the padding.
 */
export const shell: CSSProperties = {
  position: 'relative',
  zIndex: 1,
  marginLeft: SIDEBAR_WIDTH,
  height: '100vh',
  boxSizing: 'border-box',
  padding: 'clamp(14px, 2.2vh, 26px) clamp(16px, 2vw, 30px)',
};

/** The frosted glass frame wrapping both panes. */
export function frame(): CSSProperties {
  return {
    ...glassSurface({ radius: 22, blur: 18 }),
    display: 'flex',
    height: '100%',
    minHeight: 0,
  };
}

// ── Panes ────────────────────────────────────────────────────────────────────

/** Conversation-list pane — translucent so the backdrop tint reads through. */
export const listPane: CSSProperties = {
  position: 'relative',
  zIndex: 1,
  width: LIST_PANE_WIDTH,
  flexShrink: 0,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  borderRight: `1px solid ${hexToRgba(GLASS.accent, 0.12)}`,
  background: 'rgba(10,12,20,0.42)',
};

/** Thread / placeholder pane. MessageThread paints its own bg when active. */
export const threadPane: CSSProperties = {
  position: 'relative',
  zIndex: 1,
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  minWidth: 0,
};

// ── Placeholder (empty / no-conversations states) ─────────────────────────────

export const placeholderWrap: CSSProperties = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 'clamp(24px, 5vh, 56px)',
};

export const placeholderInner: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  textAlign: 'center',
  gap: 18,
};

export function placeholderIcon(pulse: boolean): CSSProperties {
  return {
    width: 76,
    height: 76,
    borderRadius: 22,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: GLASS.accent,
    background: `linear-gradient(135deg, ${hexToRgba(GLASS.accent, 0.16)} 0%, ${hexToRgba(GLASS.accentSecondary, 0.1)} 100%)`,
    border: `1px solid ${hexToRgba(GLASS.accent, 0.22)}`,
    boxShadow: `0 0 40px ${hexToRgba(GLASS.accent, 0.14)}`,
    animation: pulse ? 'chatPulse 3s ease-in-out infinite' : undefined,
  };
}

export const placeholderTitle: CSSProperties = {
  fontSize: '1.1rem',
  fontWeight: 700,
  color: GLASS.text,
  letterSpacing: '-0.02em',
  marginBottom: 8,
  textShadow: '0 1px 12px rgba(0,0,0,0.5)',
};

export const placeholderBody: CSSProperties = {
  fontSize: '0.85rem',
  color: GLASS.textMuted,
  lineHeight: 1.65,
  maxWidth: 300,
  textShadow: '0 1px 8px rgba(0,0,0,0.45)',
};

export function newChatBtn(hovered: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 22px',
    borderRadius: 12,
    border: 'none',
    background: `linear-gradient(135deg, ${hexToRgba(GLASS.accent, 0.95)} 0%, ${GLASS.accent} 100%)`,
    color: '#fff',
    fontSize: '0.875rem',
    fontWeight: 700,
    fontFamily: 'inherit',
    cursor: 'pointer',
    boxShadow: hovered
      ? `0 10px 30px -8px ${hexToRgba(GLASS.accent, 0.6)}`
      : `0 4px 16px -4px ${hexToRgba(GLASS.accent, 0.45)}`,
    transform: hovered ? 'translateY(-1px)' : 'translateY(0)',
    transition: 'transform 0.14s ease, box-shadow 0.2s ease',
  };
}
