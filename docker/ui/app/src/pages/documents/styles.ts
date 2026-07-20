/**
 * Centralised style objects + builders for the Documents glass page.
 *
 * Presentational components import these instead of inlining big CSSProperties
 * blocks. Everything is themed off `GLASS.accent` (app blue) and built on the
 * shared `glassSurface()` primitive so every frosted surface refracts the same.
 */

import type { CSSProperties } from 'react';
import { GLASS, glassSurface, hexToRgba } from '../../components/glass/glass';

/* ── Page shell ──────────────────────────────────────────────────────────── */

/** Content area to the right of the fixed 240px sidebar — floats the panels.
 *  The sidebar offset is NOT set here: inline styles cannot be responsive, so
 *  the consuming element pairs this with `className="md:ml-60"` (240px at md+
 *  only — below md the Sidebar is off-canvas and a margin would leave a dead
 *  gutter). */
export const contentShell: CSSProperties = {
  position: 'relative',
  zIndex: 1,
  height: '100vh',
  display: 'flex',
  gap: 18,
  padding: 'clamp(16px, 2vh, 24px) clamp(18px, 2vw, 28px)',
  boxSizing: 'border-box',
  overflow: 'hidden',
};

/** A full-height frosted column (folder rail / main panel). */
export function glassColumn(extra: CSSProperties = {}): CSSProperties {
  return {
    ...glassSurface({ radius: 20, blur: 18 }),
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    height: '100%',
    overflow: 'hidden',
    ...extra,
  };
}

export const sectionDivider: CSSProperties = {
  borderBottom: '1px solid rgba(255,255,255,0.07)',
  flexShrink: 0,
};

/* ── Folder rail ─────────────────────────────────────────────────────────── */

export const railHeader: CSSProperties = {
  padding: '18px 18px 14px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  flexShrink: 0,
  borderBottom: '1px solid rgba(255,255,255,0.07)',
};

export const railLabel: CSSProperties = {
  fontSize: '0.68rem',
  fontWeight: 700,
  color: GLASS.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.14em',
};

export function newFolderBtn(hovered: boolean, accent = GLASS.accent): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    padding: '5px 10px',
    borderRadius: 8,
    cursor: 'pointer',
    fontSize: '0.72rem',
    fontWeight: 700,
    color: accent,
    background: hexToRgba(accent, hovered ? 0.2 : 0.12),
    border: `1px solid ${hexToRgba(accent, 0.28)}`,
    transition: 'background 0.15s',
  };
}

export function folderRow(selected: boolean, depth = 0, accent = GLASS.accent): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: `7px ${14 + depth * 14}px 7px 14px`,
    borderRadius: 10,
    cursor: 'pointer',
    userSelect: 'none',
    position: 'relative',
    background: selected
      ? `linear-gradient(135deg, ${hexToRgba(accent, 0.18)} 0%, ${hexToRgba(accent, 0.08)} 100%)`
      : 'transparent',
    color: selected ? '#bfdbfe' : GLASS.textMuted,
    boxShadow: selected ? `inset 0 0 0 1px ${hexToRgba(accent, 0.22)}` : 'none',
    transition: 'background 0.14s, color 0.14s',
  };
}

export const folderCountChip: CSSProperties = {
  fontSize: '0.62rem',
  fontWeight: 600,
  color: GLASS.textMuted,
  background: 'rgba(255,255,255,0.07)',
  borderRadius: 5,
  padding: '1px 6px',
  flexShrink: 0,
};

/* ── Header bar (breadcrumb / search / view / upload) ────────────────────── */

export const headerBar: CSSProperties = {
  padding: '16px 22px',
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  flexShrink: 0,
  borderBottom: '1px solid rgba(255,255,255,0.07)',
};

export function breadcrumbBtn(active: boolean): CSSProperties {
  return {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: active ? GLASS.text : GLASS.textMuted,
    fontSize: '0.9rem',
    fontWeight: active ? 700 : 500,
    padding: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    transition: 'color 0.14s',
    fontFamily: 'inherit',
  };
}

export function searchWrap(focused: boolean, accent = GLASS.accent): CSSProperties {
  return {
    position: 'relative',
    width: 230,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 12px',
    borderRadius: 11,
    background: 'rgba(255,255,255,0.04)',
    border: `1px solid ${focused ? hexToRgba(accent, 0.45) : 'rgba(255,255,255,0.10)'}`,
    boxShadow: focused
      ? `0 0 0 3px ${hexToRgba(accent, 0.12)}, inset 0 1px 0 rgba(255,255,255,0.06)`
      : 'inset 0 1px 0 rgba(255,255,255,0.05)',
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
    transition: 'border-color 0.16s, box-shadow 0.16s',
    flexShrink: 0,
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

export const viewToggleWrap: CSSProperties = {
  display: 'inline-flex',
  gap: 3,
  padding: 3,
  borderRadius: 10,
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.10)',
  flexShrink: 0,
};

export function viewToggleBtn(active: boolean, accent = GLASS.accent): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '6px 9px',
    borderRadius: 7,
    border: 'none',
    cursor: 'pointer',
    background: active ? hexToRgba(accent, 0.16) : 'transparent',
    color: active ? accent : GLASS.textMuted,
    boxShadow: active ? `inset 0 0 0 1px ${hexToRgba(accent, 0.3)}` : 'none',
    transition: 'background 0.14s, color 0.14s',
  };
}

export function uploadBtn(hovered: boolean, accent = GLASS.accent): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    padding: '9px 18px',
    borderRadius: 10,
    border: 'none',
    cursor: 'pointer',
    flexShrink: 0,
    color: '#fff',
    fontSize: '0.85rem',
    fontWeight: 700,
    fontFamily: 'inherit',
    background: `linear-gradient(135deg, ${hexToRgba(accent, 0.92)} 0%, ${accent} 100%)`,
    boxShadow: hovered
      ? `0 8px 22px -6px ${hexToRgba(accent, 0.6)}`
      : `0 3px 14px -4px ${hexToRgba(accent, 0.5)}`,
    transform: hovered ? 'translateY(-1px)' : 'translateY(0)',
    transition: 'transform 0.14s, box-shadow 0.18s',
  };
}

export const statsBar: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: '0.78rem',
  color: GLASS.textMuted,
  flexShrink: 0,
};

/* ── Document list / rows ────────────────────────────────────────────────── */

export const LIST_GRID = '32px 1fr 90px 130px 80px 36px';

export const listHeader: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: LIST_GRID,
  gap: 12,
  padding: '10px 22px',
  borderBottom: '1px solid rgba(255,255,255,0.06)',
  flexShrink: 0,
};

export function listHeaderCell(rightAlign: boolean): CSSProperties {
  return {
    fontSize: '0.62rem',
    fontWeight: 700,
    color: GLASS.textMuted,
    textTransform: 'uppercase',
    letterSpacing: '0.1em',
    textAlign: rightAlign ? 'right' : 'left',
  };
}

export function docRow(hovered: boolean): CSSProperties {
  return {
    display: 'grid',
    gridTemplateColumns: LIST_GRID,
    alignItems: 'center',
    gap: 12,
    padding: '11px 22px',
    borderBottom: '1px solid rgba(255,255,255,0.05)',
    background: hovered ? 'rgba(255,255,255,0.04)' : 'transparent',
    transition: 'background 0.12s',
    cursor: 'default',
  };
}

export function docNameBtn(hovered: boolean, accent = GLASS.accent): CSSProperties {
  return {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    color: hovered ? accent : GLASS.text,
    fontSize: '0.875rem',
    fontWeight: 600,
    padding: 0,
    textAlign: 'left',
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    display: 'block',
    transition: 'color 0.12s',
    fontFamily: 'inherit',
  };
}

export const docMeta: CSSProperties = {
  fontSize: '0.8rem',
  color: GLASS.textMuted,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export function tagChip(accent = GLASS.accent): CSSProperties {
  return {
    fontSize: '0.6rem',
    fontWeight: 700,
    letterSpacing: '0.05em',
    color: '#93c5fd',
    background: hexToRgba(accent, 0.14),
    border: `1px solid ${hexToRgba(accent, 0.22)}`,
    borderRadius: 5,
    padding: '1px 6px',
  };
}

export function iconActionBtn(active: boolean): CSSProperties {
  return {
    background: active ? 'rgba(255,255,255,0.08)' : 'none',
    border: 'none',
    cursor: 'pointer',
    color: active ? GLASS.text : GLASS.textMuted,
    borderRadius: 7,
    padding: '4px 5px',
    display: 'flex',
    transition: 'background 0.12s, color 0.12s',
  };
}

/* ── Context / action menus ──────────────────────────────────────────────── */

export const menuSurface: CSSProperties = {
  position: 'absolute',
  right: 0,
  top: '100%',
  marginTop: 4,
  zIndex: 200,
  background: 'rgba(20,24,34,0.92)',
  backdropFilter: 'blur(16px) saturate(160%)',
  WebkitBackdropFilter: 'blur(16px) saturate(160%)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 12,
  padding: '5px 0',
  minWidth: 180,
  boxShadow: '0 18px 48px -12px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.08)',
};

export function menuItem(danger = false): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    width: '100%',
    background: 'none',
    border: 'none',
    color: danger ? GLASS.danger : GLASS.textMuted,
    fontSize: '0.8rem',
    fontWeight: 500,
    padding: '8px 14px',
    cursor: 'pointer',
    textAlign: 'left',
    fontFamily: 'inherit',
  };
}

/* ── Inputs (modals / inline edit) ───────────────────────────────────────── */

export const inlineEditInput: CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: 'rgba(8,10,15,0.5)',
  border: `1px solid ${hexToRgba(GLASS.accent, 0.5)}`,
  borderRadius: 7,
  color: GLASS.text,
  fontSize: '0.8rem',
  padding: '4px 8px',
  outline: 'none',
  fontFamily: 'inherit',
};

export const fieldLabel: CSSProperties = {
  marginBottom: 7,
  fontSize: '0.72rem',
  fontWeight: 700,
  color: GLASS.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
};

export function fieldInput(focused: boolean, accent = GLASS.accent): CSSProperties {
  return {
    width: '100%',
    boxSizing: 'border-box',
    background: 'rgba(8,10,15,0.45)',
    border: `1px solid ${focused ? hexToRgba(accent, 0.5) : 'rgba(255,255,255,0.12)'}`,
    borderRadius: 10,
    color: GLASS.text,
    fontSize: '0.875rem',
    padding: '10px 14px',
    outline: 'none',
    fontFamily: 'inherit',
    boxShadow: focused ? `0 0 0 3px ${hexToRgba(accent, 0.12)}` : 'none',
    transition: 'border-color 0.16s, box-shadow 0.16s',
  };
}

export function primaryBtn(enabled = true, accent = GLASS.accent): CSSProperties {
  return {
    padding: '9px 20px',
    borderRadius: 10,
    border: 'none',
    color: '#fff',
    fontSize: '0.85rem',
    fontWeight: 700,
    fontFamily: 'inherit',
    cursor: enabled ? 'pointer' : 'not-allowed',
    background: enabled
      ? `linear-gradient(135deg, ${hexToRgba(accent, 0.92)} 0%, ${accent} 100%)`
      : hexToRgba(accent, 0.25),
    boxShadow: enabled ? `0 4px 14px -4px ${hexToRgba(accent, 0.6)}` : 'none',
  };
}

export const ghostBtn: CSSProperties = {
  padding: '9px 20px',
  borderRadius: 10,
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.12)',
  color: GLASS.textMuted,
  fontSize: '0.85rem',
  fontWeight: 600,
  fontFamily: 'inherit',
  cursor: 'pointer',
};

export const modalBackdrop: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 500,
  background: 'rgba(0,0,0,0.62)',
  backdropFilter: 'blur(5px)',
  WebkitBackdropFilter: 'blur(5px)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
};

export function modalPanel(width: number): CSSProperties {
  return {
    ...glassSurface({ radius: 18, blur: 22 }),
    width,
    maxWidth: 'calc(100vw - 40px)',
    background: 'linear-gradient(180deg, rgba(28,31,43,0.96) 0%, rgba(18,20,28,0.97) 100%)',
  };
}

/* ── Drop zone / overlay / upload queue ──────────────────────────────────── */

export function dropZone(dragOver: boolean, accent = GLASS.accent): CSSProperties {
  return {
    border: `2px dashed ${dragOver ? hexToRgba(accent, 0.6) : 'rgba(255,255,255,0.12)'}`,
    borderRadius: 14,
    padding: '34px 24px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 12,
    cursor: 'pointer',
    background: dragOver ? hexToRgba(accent, 0.06) : 'rgba(255,255,255,0.02)',
    transition: 'border-color 0.15s, background 0.15s',
    userSelect: 'none',
    margin: '4px 22px 22px',
  };
}

export function dropIcon(dragOver: boolean, accent = GLASS.accent): CSSProperties {
  return {
    width: 52,
    height: 52,
    borderRadius: 14,
    background: dragOver ? hexToRgba(accent, 0.18) : 'rgba(255,255,255,0.04)',
    border: `1px solid ${dragOver ? hexToRgba(accent, 0.4) : 'rgba(255,255,255,0.08)'}`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: dragOver ? accent : GLASS.textMuted,
    transition: 'all 0.15s',
  };
}

export function uploadCard(status: string, accent = GLASS.accent): CSSProperties {
  const border =
    status === 'error' ? hexToRgba(GLASS.danger, 0.35)
    : status === 'done' ? hexToRgba(GLASS.success, 0.3)
    : hexToRgba(accent, 0.22);
  return {
    ...glassSurface({ radius: 12, blur: 16 }),
    border: `1px solid ${border}`,
    padding: '12px 16px',
    animation: 'docFadeIn 0.22s ease',
  };
}

export const dropOverlay: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 600,
  background: hexToRgba(GLASS.accent, 0.08),
  border: `3px dashed ${hexToRgba(GLASS.accent, 0.4)}`,
  backdropFilter: 'blur(3px)',
  WebkitBackdropFilter: 'blur(3px)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  pointerEvents: 'none',
};

/* ── Grid view ───────────────────────────────────────────────────────────── */

export const cardGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(184px, 1fr))',
  gap: 16,
  padding: 22,
};

export function gridPreview(isImage: boolean, iconColor: string): CSSProperties {
  return {
    height: 104,
    background: isImage
      ? 'rgba(255,255,255,0.03)'
      : `linear-gradient(135deg, ${hexToRgba(iconColor, 0.1)} 0%, transparent 100%)`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderBottom: '1px solid rgba(255,255,255,0.07)',
    cursor: 'pointer',
    overflow: 'hidden',
  };
}

/* ── Spinner ─────────────────────────────────────────────────────────────── */

export function spinner(size = 32, accent = GLASS.accent): CSSProperties {
  return {
    width: size,
    height: size,
    borderRadius: '50%',
    border: `3px solid ${hexToRgba(accent, 0.18)}`,
    borderTopColor: accent,
    animation: 'glass-spin 0.8s linear infinite',
  };
}
