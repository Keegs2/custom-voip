/**
 * Centralised style objects + builders for the Customer Account glass refactor.
 *
 * Presentational components import these instead of inlining large CSSProperties
 * blocks. Everything is themed off `GLASS.accent` (app blue) and accepts a local
 * `accent` override where a per-product hue is justified.
 */

import type { CSSProperties } from 'react';
import { GLASS, hexToRgba } from '../../../components/glass/glass';

export const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

// ── Section labels ───────────────────────────────────────────────────────────

export function sectionLabel(accent = GLASS.accent): CSSProperties {
  return {
    fontSize: '0.62rem',
    fontWeight: 700,
    color: accent,
    textTransform: 'uppercase',
    letterSpacing: '0.12em',
    marginBottom: 20,
  };
}

export const subLabel: CSSProperties = {
  fontSize: '0.62rem',
  fontWeight: 700,
  color: GLASS.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
  marginBottom: 14,
};

// ── Stat tile ────────────────────────────────────────────────────────────────

export const statLabel: CSSProperties = {
  fontSize: '0.6rem',
  fontWeight: 700,
  color: GLASS.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
  marginBottom: 10,
};

export const statValue: CSSProperties = {
  fontSize: '1.1rem',
  fontWeight: 700,
  color: GLASS.text,
  fontVariantNumeric: 'tabular-nums',
  textShadow: '0 1px 10px rgba(0,0,0,0.5)',
};

/**
 * The accent hairline along a StatTile's top edge. GlassPanel's inner content
 * div is `position:relative`, so this anchors to the panel's top edge directly.
 */
export function statAccentLine(accent = GLASS.accent): CSSProperties {
  return {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 2,
    background: `linear-gradient(90deg, transparent, ${hexToRgba(accent, 0.85)}, transparent)`,
  };
}

// ── Header ───────────────────────────────────────────────────────────────────

export function headerGlow(accent = GLASS.accent): CSSProperties {
  return {
    position: 'absolute',
    top: -70,
    right: -50,
    width: 260,
    height: 260,
    borderRadius: '50%',
    background: `radial-gradient(circle, ${hexToRgba(accent, 0.16)} 0%, transparent 70%)`,
    pointerEvents: 'none',
  };
}

export function headerIcon(accent = GLASS.accent): CSSProperties {
  return {
    width: 56,
    height: 56,
    borderRadius: 16,
    background: `linear-gradient(135deg, ${hexToRgba(accent, 0.22)} 0%, ${hexToRgba(accent, 0.08)} 100%)`,
    border: `1px solid ${hexToRgba(accent, 0.32)}`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: accent,
    flexShrink: 0,
    boxShadow: `0 0 22px ${hexToRgba(accent, 0.22)}`,
  };
}

export const headerTitle: CSSProperties = {
  fontSize: '1.75rem',
  fontWeight: 800,
  color: GLASS.text,
  letterSpacing: '-0.025em',
  margin: 0,
  lineHeight: 1.15,
  textShadow: '0 2px 18px rgba(0,0,0,0.55)',
};

export const headerId: CSSProperties = {
  fontFamily: MONO,
  fontSize: '0.78rem',
  color: GLASS.textFaint,
  letterSpacing: '0.04em',
};

// ── Back button ──────────────────────────────────────────────────────────────

export function backBtn(hovered: boolean): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    background: hovered ? hexToRgba(GLASS.accent, 0.08) : 'rgba(255,255,255,0.03)',
    border: `1px solid ${hovered ? hexToRgba(GLASS.accent, 0.4) : 'rgba(255,255,255,0.10)'}`,
    borderRadius: 10,
    color: hovered ? GLASS.text : GLASS.textMuted,
    fontSize: '0.82rem',
    fontWeight: 600,
    cursor: 'pointer',
    padding: '7px 14px',
    fontFamily: 'inherit',
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
    transition: 'color 0.18s, border-color 0.18s, background 0.18s',
  };
}

export function stateIconWrap(accent = GLASS.accent): CSSProperties {
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

// ── Add-credit input ─────────────────────────────────────────────────────────

export function creditInput(focused: boolean): CSSProperties {
  return {
    fontSize: '0.82rem',
    padding: '8px 12px',
    borderRadius: 10,
    width: 132,
    border: `1px solid ${focused ? hexToRgba(GLASS.success, 0.5) : 'rgba(255,255,255,0.12)'}`,
    background: 'rgba(8,10,15,0.55)',
    color: GLASS.text,
    outline: 'none',
    fontFamily: MONO,
    boxShadow: focused
      ? `0 0 0 3px ${hexToRgba(GLASS.success, 0.14)}, inset 0 1px 0 rgba(255,255,255,0.06)`
      : 'inset 0 1px 0 rgba(255,255,255,0.05)',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    transition: 'border-color 0.15s, box-shadow 0.15s',
  };
}

// ── Add-on toggle button ─────────────────────────────────────────────────────

export function toggleBtn(enabled: boolean, accent: string, pending: boolean, hovered: boolean): CSSProperties {
  const dangerOnHover = enabled && hovered;
  const activeAccent = dangerOnHover ? GLASS.danger : accent;
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    fontSize: '0.8rem',
    fontWeight: 600,
    padding: '7px 14px',
    borderRadius: 10,
    cursor: pending ? 'wait' : 'pointer',
    border: `1px solid ${enabled || hovered ? hexToRgba(activeAccent, 0.38) : 'rgba(255,255,255,0.12)'}`,
    background: enabled
      ? hexToRgba(activeAccent, 0.12)
      : hovered
        ? hexToRgba(accent, 0.1)
        : 'rgba(255,255,255,0.03)',
    color: enabled ? activeAccent : hovered ? accent : GLASS.textMuted,
    transition: 'background 0.15s, border-color 0.15s, color 0.15s',
    opacity: pending ? 0.6 : 1,
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    fontFamily: 'inherit',
  };
}

export function toggleTrack(enabled: boolean, accent: string): CSSProperties {
  return {
    position: 'relative',
    display: 'inline-block',
    width: 28,
    height: 16,
    borderRadius: 8,
    background: enabled ? accent : 'rgba(148,163,184,0.35)',
    transition: 'background 0.2s',
    flexShrink: 0,
  };
}

export function toggleKnob(enabled: boolean): CSSProperties {
  return {
    position: 'absolute',
    top: 2,
    left: enabled ? 14 : 2,
    width: 12,
    height: 12,
    borderRadius: '50%',
    background: '#fff',
    transition: 'left 0.2s',
    boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
  };
}

// ── Add-on indicator pill (header) ───────────────────────────────────────────

export function addonPill(enabled: boolean, accent: string): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    fontSize: '0.65rem',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.07em',
    padding: '4px 9px',
    borderRadius: 999,
    background: enabled ? hexToRgba(accent, 0.12) : 'rgba(148,163,184,0.1)',
    border: `1px solid ${enabled ? hexToRgba(accent, 0.3) : 'rgba(148,163,184,0.2)'}`,
    color: enabled ? accent : GLASS.textFaint,
  };
}

// ── Usage analytics inner surfaces ───────────────────────────────────────────

export const chartShell: CSSProperties = {
  background: 'rgba(8,10,15,0.45)',
  border: '1px solid rgba(255,255,255,0.06)',
  borderRadius: 14,
  padding: '16px 16px 6px',
};

export const tableShell: CSSProperties = {
  background: 'rgba(8,10,15,0.35)',
  border: '1px solid rgba(255,255,255,0.06)',
  borderRadius: 14,
  overflow: 'hidden',
};

export const emptyNote: CSSProperties = {
  padding: '32px 0',
  textAlign: 'center',
  color: GLASS.textMuted,
  fontSize: '0.82rem',
};

export function errorNote(): CSSProperties {
  return {
    padding: '14px 18px',
    borderRadius: 12,
    background: hexToRgba(GLASS.danger, 0.08),
    border: `1px solid ${hexToRgba(GLASS.danger, 0.2)}`,
    color: '#f87171',
    fontSize: '0.82rem',
  };
}

// ── Recent calls table ───────────────────────────────────────────────────────

export const tableHead: CSSProperties = {
  padding: '10px 12px',
  textAlign: 'left',
  fontSize: '0.6rem',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: GLASS.textMuted,
  borderBottom: '1px solid rgba(255,255,255,0.08)',
  whiteSpace: 'nowrap',
};

export function dirBadge(inbound: boolean): CSSProperties {
  const c = inbound ? '#60a5fa' : '#c084fc';
  return {
    display: 'inline-block',
    fontSize: '0.6rem',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    padding: '2px 7px',
    borderRadius: 5,
    background: hexToRgba(inbound ? '#3b82f6' : '#a855f7', 0.15),
    color: c,
    border: `1px solid ${hexToRgba(inbound ? '#3b82f6' : '#a855f7', 0.25)}`,
  };
}

export function statusBadge(answered: boolean): CSSProperties {
  const c = answered ? '#4ade80' : '#f87171';
  const base = answered ? GLASS.success : GLASS.danger;
  return {
    display: 'inline-block',
    fontSize: '0.6rem',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    padding: '2px 7px',
    borderRadius: 5,
    background: hexToRgba(base, 0.12),
    color: c,
    border: `1px solid ${hexToRgba(base, 0.22)}`,
  };
}

// ── Tier line ────────────────────────────────────────────────────────────────

export const tierLineRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: '0.82rem',
  color: GLASS.textMuted,
};

export const tierLineLabel: CSSProperties = {
  fontSize: '0.6rem',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.09em',
  color: GLASS.textMuted,
};

// ── Spinner-style inline loading ─────────────────────────────────────────────

export const inlineLoading: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  color: GLASS.textMuted,
  fontSize: '0.82rem',
  padding: '32px 0',
};

// ── Service-section shared chrome (RCF / API / Trunk / UCaaS) ─────────────────
// These sections render inside a glass `SectionPanel`, so they only style their
// own inner surfaces (rows, forms, inputs) — never another opaque card.

/** The section's eyebrow label rendered in the product accent (no bottom margin
 * so it can sit in a flex header row). */
export function sectionEyebrow(accent = GLASS.accent): CSSProperties {
  return {
    fontSize: '0.65rem',
    fontWeight: 700,
    color: accent,
    textTransform: 'uppercase',
    letterSpacing: '0.11em',
  };
}

/** "Manage X" text link in a section header. */
export function manageLink(accent = GLASS.accent): CSSProperties {
  return {
    fontSize: '0.72rem',
    fontWeight: 600,
    color: accent,
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: 0,
    textDecoration: 'none',
  };
}

/** Translucent inner row/card surface used inside a glass SectionPanel. */
export const glassRow: CSSProperties = {
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 12,
};

/** Accent-tinted "add new" form panel inside a section. */
export function glassFormPanel(accent = GLASS.accent): CSSProperties {
  return {
    background: hexToRgba(accent, 0.05),
    border: `1px solid ${hexToRgba(accent, 0.18)}`,
    borderRadius: 14,
    padding: '18px 20px',
  };
}

/** Small uppercase field label inside a section form. */
export const fieldLabel: CSSProperties = {
  fontSize: '0.6rem',
  fontWeight: 700,
  color: GLASS.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
};

/** Glass text input — translucent fill, white hairline, accent focus ring. */
export function glassFieldInput(focused: boolean, accent = GLASS.accent): CSSProperties {
  return {
    fontSize: '0.82rem',
    padding: '7px 11px',
    borderRadius: 9,
    border: `1px solid ${focused ? hexToRgba(accent, 0.5) : 'rgba(255,255,255,0.12)'}`,
    background: 'rgba(8,10,15,0.55)',
    color: GLASS.text,
    outline: 'none',
    fontFamily: 'inherit',
    boxShadow: focused ? `0 0 0 3px ${hexToRgba(accent, 0.14)}` : 'none',
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    transition: 'border-color 0.15s, box-shadow 0.15s',
  };
}

/** Glass select — same surface as {@link glassFieldInput} with a pointer. */
export function glassSelect(accent = GLASS.accent): CSSProperties {
  return { ...glassFieldInput(false, accent), cursor: 'pointer' };
}

/** A glass "stat chip" (label + value) used in trunk quick-stats rows. */
export function glassStatChip(accent = GLASS.accent, tinted = false): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    background: tinted ? hexToRgba(accent, 0.08) : 'rgba(255,255,255,0.03)',
    border: `1px solid ${tinted ? hexToRgba(accent, 0.28) : 'rgba(255,255,255,0.08)'}`,
    borderRadius: 8,
    padding: '4px 11px',
    fontSize: '0.78rem',
  };
}
