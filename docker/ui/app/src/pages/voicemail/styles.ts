/**
 * Centralised style objects for the Visual Voicemail inbox.
 *
 * The inbox is a full-screen, three-column master-detail surface (it renders its
 * own Sidebar, outside AppLayout), so instead of the standard padded page column
 * it uses frosted-glass *columns* floating over the app-wide GlassBackground.
 * Every accent is the app blue (`GLASS.accent`); legibility scrims keep text
 * crisp where the blur thins out.
 *
 * Static styles are constants; anything stateful (active / focus / hover) is a
 * small builder fn so the visual language lives in exactly one place.
 */

import type { CSSProperties } from 'react';
import { GLASS, hexToRgba } from '../../components/glass/glass';

export const ACCENT = GLASS.accent;
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

// Shared frosted column fill — translucent so the ambient blobs read through,
// with a subtle vertical sheen + a darkening scrim at the base for contrast.
const COLUMN_FILL =
  'linear-gradient(180deg, rgba(255,255,255,0.045) 0%, rgba(255,255,255,0.012) 45%, rgba(8,10,16,0.32) 100%)';
const COLUMN_BLUR = 'blur(22px) saturate(155%)';
const HAIRLINE = '1px solid rgba(255,255,255,0.08)';

// ── Layout shell ─────────────────────────────────────────────────────────────

/** Full-viewport root — sits above the fixed GlassBackground (zIndex 0). */
export const pageRoot: CSSProperties = {
  minHeight: '100vh',
  position: 'relative',
  zIndex: 1,
  background: 'transparent',
};

/** Content lane to the right of the fixed 240px sidebar.
 *  The sidebar offset is NOT set here: inline styles cannot be responsive, so
 *  the consuming element pairs this with `className="sidebar-offset"` (240px at md+
 *  only — below md the Sidebar is off-canvas and a margin would leave a dead
 *  gutter). */
export const contentShell: CSSProperties = {
  height: '100vh',
  display: 'flex',
  overflow: 'hidden',
};

// ── Rail (folders + mailbox switcher) ───────────────────────────────────────

export const railColumn: CSSProperties = {
  width: 256,
  flexShrink: 0,
  borderRight: HAIRLINE,
  display: 'flex',
  flexDirection: 'column',
  background: COLUMN_FILL,
  backdropFilter: COLUMN_BLUR,
  WebkitBackdropFilter: COLUMN_BLUR,
  minHeight: 0,
};

export const railHeader: CSSProperties = {
  padding: '20px 18px 14px',
  borderBottom: '1px solid rgba(255,255,255,0.06)',
};

export const railTitle: CSSProperties = {
  fontSize: '0.7rem',
  fontWeight: 700,
  color: GLASS.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.14em',
};

export const newMailboxBtn: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '5px 10px',
  borderRadius: 9,
  border: `1px solid ${hexToRgba(ACCENT, 0.4)}`,
  background: hexToRgba(ACCENT, 0.14),
  color: ACCENT,
  fontSize: '0.68rem',
  fontWeight: 700,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

export const railFolders: CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '10px',
};

export const railAdmin: CSSProperties = {
  padding: '12px',
  borderTop: '1px solid rgba(255,255,255,0.06)',
};

// ── Mailbox switcher ────────────────────────────────────────────────────────

export const switcherEmpty: CSSProperties = {
  fontSize: '0.74rem',
  color: GLASS.textFaint,
  padding: '8px 4px',
};

export const switcherBtn: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  width: '100%',
  padding: '10px 12px',
  borderRadius: 11,
  border: `1px solid ${hexToRgba(ACCENT, 0.28)}`,
  background: hexToRgba(ACCENT, 0.1),
  color: GLASS.text,
  cursor: 'pointer',
  fontFamily: 'inherit',
  backdropFilter: 'blur(10px)',
  WebkitBackdropFilter: 'blur(10px)',
};

export const switcherMenu: CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 6px)',
  left: 0,
  right: 0,
  zIndex: 30,
  background: 'rgba(18,21,30,0.92)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 12,
  boxShadow: '0 18px 48px -12px rgba(0,0,0,0.7)',
  overflow: 'hidden',
  maxHeight: 280,
  overflowY: 'auto',
  backdropFilter: 'blur(18px) saturate(160%)',
  WebkitBackdropFilter: 'blur(18px) saturate(160%)',
};

export function switcherItem(active: boolean): CSSProperties {
  return {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    padding: '10px 13px',
    background: active ? hexToRgba(ACCENT, 0.16) : 'transparent',
    border: 'none',
    color: GLASS.text,
    cursor: 'pointer',
    fontSize: '0.8rem',
    fontFamily: 'inherit',
  };
}

// ── Folder item ─────────────────────────────────────────────────────────────

export function folderBtn(active: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    padding: '9px 12px',
    marginBottom: 3,
    borderRadius: 10,
    border: `1px solid ${active ? hexToRgba(ACCENT, 0.32) : 'transparent'}`,
    background: active
      ? `linear-gradient(135deg, ${hexToRgba(ACCENT, 0.2)} 0%, ${hexToRgba(ACCENT, 0.06)} 100%)`
      : 'transparent',
    color: active ? GLASS.text : GLASS.textMuted,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'background 0.14s, border-color 0.14s, color 0.14s',
  };
}

export function folderCount(active: boolean): CSSProperties {
  return {
    fontSize: '0.64rem',
    fontWeight: 700,
    padding: '1px 7px',
    borderRadius: 6,
    background: active ? hexToRgba(ACCENT, 0.26) : 'rgba(255,255,255,0.06)',
    color: active ? ACCENT : GLASS.textFaint,
  };
}

// ── Message list column ─────────────────────────────────────────────────────

export const listColumn: CSSProperties = {
  width: 364,
  flexShrink: 0,
  borderRight: HAIRLINE,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  background: COLUMN_FILL,
  backdropFilter: COLUMN_BLUR,
  WebkitBackdropFilter: COLUMN_BLUR,
};

export const listSearchWrap: CSSProperties = {
  padding: '16px 16px',
  borderBottom: '1px solid rgba(255,255,255,0.06)',
};

export function searchField(focused: boolean): CSSProperties {
  return {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '9px 12px',
    borderRadius: 11,
    background: 'rgba(255,255,255,0.04)',
    border: `1px solid ${focused ? hexToRgba(ACCENT, 0.45) : 'rgba(255,255,255,0.1)'}`,
    boxShadow: focused
      ? `0 0 0 3px ${hexToRgba(ACCENT, 0.12)}, inset 0 1px 0 rgba(255,255,255,0.06)`
      : 'inset 0 1px 0 rgba(255,255,255,0.05)',
    transition: 'border-color 0.16s, box-shadow 0.16s',
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

export const listScroll: CSSProperties = {
  flex: 1,
  overflowY: 'auto',
};

// ── Message row ─────────────────────────────────────────────────────────────

export function messageRow(selected: boolean, read: boolean): CSSProperties {
  return {
    display: 'flex',
    gap: 12,
    width: '100%',
    textAlign: 'left',
    padding: '13px 16px',
    borderBottom: '1px solid rgba(255,255,255,0.045)',
    borderLeft: `2px solid ${selected ? ACCENT : 'transparent'}`,
    background: selected
      ? hexToRgba(ACCENT, 0.14)
      : read
        ? 'transparent'
        : hexToRgba(ACCENT, 0.05),
    cursor: 'pointer',
    fontFamily: 'inherit',
    animation: 'glass-rise 0.28s ease-out both',
    transition: 'background 0.14s',
  };
}

export function avatar(big: boolean): CSSProperties {
  const d = big ? 46 : 38;
  return {
    width: d,
    height: d,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    background: `linear-gradient(135deg, ${hexToRgba(ACCENT, 0.34)} 0%, ${hexToRgba(ACCENT, 0.14)} 100%)`,
    border: `1px solid ${hexToRgba(ACCENT, 0.34)}`,
    color: ACCENT,
    fontWeight: 700,
    fontSize: big ? '1.1rem' : '0.85rem',
  };
}

export const unreadDot: CSSProperties = {
  position: 'absolute',
  top: -1,
  right: -1,
  width: 9,
  height: 9,
  borderRadius: '50%',
  background: ACCENT,
  border: '2px solid #0b0d14',
  boxShadow: `0 0 6px ${ACCENT}`,
};

export function rowName(read: boolean): CSSProperties {
  return {
    fontSize: '0.84rem',
    fontWeight: read ? 600 : 700,
    color: GLASS.text,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };
}

export const rowDate: CSSProperties = {
  fontSize: '0.66rem',
  color: GLASS.textFaint,
  flexShrink: 0,
};

export const rowMeta: CSSProperties = {
  fontSize: '0.7rem',
  color: GLASS.textMuted,
  fontFamily: MONO,
  marginTop: 1,
};

export const rowPreview: CSSProperties = {
  fontSize: '0.7rem',
  color: GLASS.textFaint,
  marginTop: 3,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

// ── Reading pane column ─────────────────────────────────────────────────────

export const readingColumn: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  background:
    'linear-gradient(180deg, rgba(255,255,255,0.03) 0%, rgba(8,10,16,0.18) 60%, rgba(8,10,16,0.36) 100%)',
  backdropFilter: 'blur(14px) saturate(140%)',
  WebkitBackdropFilter: 'blur(14px) saturate(140%)',
};

export const readingHeader: CSSProperties = {
  padding: '22px 28px',
  borderBottom: '1px solid rgba(255,255,255,0.07)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 16,
  flexShrink: 0,
};

export const readingTitle: CSSProperties = {
  fontSize: '1.05rem',
  fontWeight: 700,
  color: '#f1f5f9',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  textShadow: '0 1px 10px rgba(0,0,0,0.5)',
};

export const readingSub: CSSProperties = {
  fontSize: '0.76rem',
  color: GLASS.textMuted,
  display: 'flex',
  gap: 8,
  marginTop: 3,
};

export const readingMono: CSSProperties = { fontFamily: MONO };

export const readingBody: CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '24px 28px',
  display: 'flex',
  flexDirection: 'column',
  gap: 22,
};

export const readingActions: CSSProperties = {
  padding: '16px 28px',
  borderTop: '1px solid rgba(255,255,255,0.07)',
  display: 'flex',
  gap: 10,
  flexShrink: 0,
};

// ── Action button ───────────────────────────────────────────────────────────

export function actionBtn(opts: { active?: boolean; danger?: boolean; disabled?: boolean }): CSSProperties {
  const { active, danger, disabled } = opts;
  const color = danger ? GLASS.danger : active ? ACCENT : GLASS.textMuted;
  const border = danger
    ? hexToRgba(GLASS.danger, 0.28)
    : active
      ? hexToRgba(ACCENT, 0.42)
      : 'rgba(255,255,255,0.1)';
  const bg = danger
    ? hexToRgba(GLASS.danger, 0.1)
    : active
      ? hexToRgba(ACCENT, 0.16)
      : 'rgba(255,255,255,0.04)';
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    padding: '8px 14px',
    borderRadius: 10,
    border: `1px solid ${border}`,
    background: bg,
    color,
    fontSize: '0.78rem',
    fontWeight: 600,
    fontFamily: 'inherit',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.45 : 1,
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    transition: 'all 0.14s',
  };
}

// ── Transcript panel ────────────────────────────────────────────────────────

export const transcriptLabel: CSSProperties = {
  fontSize: '0.68rem',
  fontWeight: 700,
  color: GLASS.textMuted,
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
};

export const transcriptText: CSSProperties = {
  color: '#cbd5e0',
  fontSize: '0.88rem',
  lineHeight: 1.7,
  margin: 0,
};

export const transcriptMuted: CSSProperties = {
  color: GLASS.textFaint,
  fontSize: '0.83rem',
  fontStyle: 'italic',
};

// ── State surfaces ──────────────────────────────────────────────────────────

export function spinnerRing(size = 26): CSSProperties {
  return {
    width: size,
    height: size,
    border: `2px solid ${hexToRgba(ACCENT, 0.18)}`,
    borderTopColor: ACCENT,
    borderRadius: '50%',
    animation: 'glass-spin 0.8s linear infinite',
  };
}

export const stateWrap: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  height: '100%',
  gap: 12,
  padding: 40,
  textAlign: 'center',
};

export function stateIcon(big = false): CSSProperties {
  const d = big ? 76 : 64;
  return {
    width: d,
    height: d,
    borderRadius: 20,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: `linear-gradient(135deg, ${hexToRgba(ACCENT, 0.18)} 0%, ${hexToRgba(ACCENT, 0.06)} 100%)`,
    border: `1px solid ${hexToRgba(ACCENT, 0.32)}`,
    color: ACCENT,
  };
}

export const stateTitle: CSSProperties = {
  fontSize: '1rem',
  fontWeight: 700,
  color: GLASS.textMuted,
};

export const stateBody: CSSProperties = {
  fontSize: '0.84rem',
  color: GLASS.textFaint,
  lineHeight: 1.6,
  maxWidth: 280,
};

export const newMailboxCta: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  padding: '10px 18px',
  borderRadius: 11,
  border: 'none',
  background: `linear-gradient(135deg, ${ACCENT} 0%, ${hexToRgba(ACCENT, 0.78)} 100%)`,
  color: '#fff',
  fontSize: '0.82rem',
  fontWeight: 700,
  cursor: 'pointer',
  fontFamily: 'inherit',
  boxShadow: `0 8px 22px -8px ${hexToRgba(ACCENT, 0.7)}`,
};
