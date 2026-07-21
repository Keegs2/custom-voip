/**
 * Centralised style tokens + builders for the documentation pages.
 *
 * The docs pages lead with the app BLUE liquid-glass aesthetic: frosted panels
 * float over the app-wide ambient backdrop (mounted in AppLayout). Reading
 * content sits on a darker translucent scrim so text contrast stays strong even
 * where the backdrop blur lightens the surface.
 *
 * Everything visual lives here so the section components stay declarative.
 * Themed off `GLASS.accent` (blue); pass a different `accent` to the builders to
 * re-tint locally (e.g. the amber "coming soon" callouts).
 *
 * This is a non-`.tsx` module on purpose — it exports only style objects + the
 * token map, never JSX, so `react-refresh/only-export-components` stays happy.
 */

import type { CSSProperties } from 'react';
import { GLASS, hexToRgba } from '../../components/glass/glass';

/** Monospace stack used for code, endpoints, and inline code spans. */
export const MONO = "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, monospace";

/* ─── Token map (leads with the glass palette) ───────────────────────────── */

export const DOCS = {
  accent: GLASS.accent, // app blue #3b82f6
  amber: GLASS.warning, // #f59e0b — "coming soon" / planned features
  red: GLASS.danger, // #ef4444
  green: '#4ade80', // success accents in code/copy affordances
  text: GLASS.text, // #e2e8f0
  textMuted: GLASS.textMuted, // #94a3b8
  textFaint: GLASS.textFaint, // #475569
  // Reading scrim: a dark translucent backing so prose/tables/code stay legible
  // over the frosted surface. Kept darker than the glass fill for contrast.
  scrim: 'rgba(10,13,22,0.55)',
  scrimDeep: 'rgba(8,11,18,0.85)',
  // Syntax-highlight palette (blue family)
  code: {
    keyName: '#60a5fa',
    string: '#93c5fd',
    literal: '#818cf8',
    number: '#38bdf8',
    plain: '#94a3b8',
    comment: '#475569',
    path: '#93c5fd',
    inline: '#79c0ff',
  },
} as const;

/* ─── Reading layout ──────────────────────────────────────────────────────── */

/** Centered readable measure inside the AppLayout content column. */
export const readingColumn: CSSProperties = {
  maxWidth: 1040,
  margin: '0 auto',
};

/** Vertical list of accordion sections — uniform card-gap rhythm (16px). */
export const sectionList: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
};

/**
 * Vertical rhythm between a product guide's titled frosted panels. Slightly
 * more generous than the accordion `sectionList` (16px) because these are
 * full-weight sections, not compact accordion rows — 20px keeps them distinct
 * without sprawling, staying within the app spacing standard.
 */
export const guideSectionList: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 20,
};

/* ─── Typography ─────────────────────────────────────────────────────────── */

export const paragraph: CSSProperties = {
  margin: '0 0 14px',
  fontSize: '0.9rem',
  color: DOCS.textMuted,
  lineHeight: 1.78,
};

export const h3: CSSProperties = {
  margin: '28px 0 10px',
  fontSize: '0.72rem',
  fontWeight: 700,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: DOCS.textFaint,
};

export const inlineCode: CSSProperties = {
  background: DOCS.scrimDeep,
  border: '1px solid rgba(255,255,255,0.10)',
  borderRadius: 5,
  padding: '1px 6px',
  fontFamily: MONO,
  fontSize: '0.78rem',
  color: DOCS.code.inline,
};

/* ─── Callout ─────────────────────────────────────────────────────────────── */

export function callout(accent = DOCS.accent): CSSProperties {
  return {
    display: 'flex',
    gap: 12,
    padding: '14px 18px',
    borderRadius: 12,
    background: hexToRgba(accent, 0.06),
    border: `1px solid ${hexToRgba(accent, 0.22)}`,
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
    marginBottom: 16,
    fontSize: '0.85rem',
    color: DOCS.textMuted,
    lineHeight: 1.7,
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
  };
}

/* ─── Accordion ───────────────────────────────────────────────────────────── */

export function accordionHeader(open: boolean, accent = DOCS.accent): CSSProperties {
  return {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    padding: '20px 26px',
    background: open ? `linear-gradient(90deg, ${hexToRgba(accent, 0.08)} 0%, transparent 60%)` : 'transparent',
    border: 'none',
    borderBottom: open ? `1px solid ${hexToRgba(accent, 0.18)}` : '1px solid transparent',
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'background 0.22s ease',
    fontFamily: 'inherit',
  };
}

export function accordionIconBadge(accent = DOCS.accent): CSSProperties {
  return {
    width: 40,
    height: 40,
    borderRadius: 11,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: `linear-gradient(135deg, ${hexToRgba(accent, 0.2)} 0%, ${hexToRgba(accent, 0.04)} 100%)`,
    border: `1px solid ${hexToRgba(accent, 0.32)}`,
    color: accent,
    flexShrink: 0,
    boxShadow: `0 0 18px -6px ${hexToRgba(accent, 0.5)}`,
  };
}

export const accordionTitle: CSSProperties = {
  fontSize: '1.05rem',
  fontWeight: 700,
  color: DOCS.text,
  letterSpacing: '-0.01em',
  marginBottom: 2,
};

export const accordionSubtitle: CSSProperties = {
  fontSize: '0.82rem',
  color: DOCS.textMuted,
  lineHeight: 1.4,
};

export function accordionChevron(open: boolean, accent = DOCS.accent): CSSProperties {
  return {
    color: accent,
    flexShrink: 0,
    transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
    transition: 'transform 0.22s ease',
    display: 'flex',
  };
}

export const accordionBody: CSSProperties = {
  padding: '26px 30px 28px',
};

/* ─── Code block ──────────────────────────────────────────────────────────── */

export const codeFrame: CSSProperties = {
  borderRadius: 12,
  overflow: 'hidden',
  border: `1px solid ${hexToRgba(DOCS.accent, 0.22)}`,
  marginBottom: 16,
  boxShadow: '0 10px 30px -16px rgba(0,0,0,0.6)',
};

export const codeBar: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '8px 16px',
  background: hexToRgba(DOCS.accent, 0.07),
  borderBottom: `1px solid ${hexToRgba(DOCS.accent, 0.16)}`,
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
};

export const codeBarLabel: CSSProperties = {
  fontSize: '0.7rem',
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: DOCS.code.keyName,
  fontFamily: MONO,
};

export function codeCopyBtn(copied: boolean): CSSProperties {
  return {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontSize: '0.7rem',
    color: copied ? DOCS.green : DOCS.textFaint,
    fontFamily: MONO,
    padding: '2px 6px',
    borderRadius: 4,
    transition: 'color 0.2s',
  };
}

export const codeBody: CSSProperties = {
  background: DOCS.scrimDeep,
  padding: '16px 20px',
  overflowX: 'auto',
  fontFamily: MONO,
  fontSize: '0.78rem',
  lineHeight: 1.75,
};

export const reqResGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 12,
  marginBottom: 20,
};

/* ─── Endpoint row ───────────────────────────────────────────────────────── */

export const METHOD_COLORS: Record<HttpMethodKey, { bg: string; text: string }> = {
  GET: { bg: hexToRgba('#3b82f6', 0.15), text: '#60a5fa' },
  POST: { bg: 'rgba(34,197,94,0.12)', text: '#4ade80' },
  PUT: { bg: 'rgba(245,158,11,0.12)', text: '#fbbf24' },
  DELETE: { bg: 'rgba(239,68,68,0.12)', text: '#f87171' },
  PATCH: { bg: 'rgba(168,85,247,0.12)', text: '#c084fc' },
};
type HttpMethodKey = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export const endpointRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '12px 16px',
  borderRadius: 10,
  background: DOCS.scrim,
  border: `1px solid ${hexToRgba(DOCS.accent, 0.18)}`,
  marginBottom: 12,
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
};

export function methodPill(method: HttpMethodKey): CSSProperties {
  const mc = METHOD_COLORS[method] ?? METHOD_COLORS.GET;
  return {
    display: 'inline-block',
    padding: '3px 9px',
    borderRadius: 6,
    background: mc.bg,
    color: mc.text,
    fontSize: '0.68rem',
    fontWeight: 800,
    letterSpacing: '0.08em',
    fontFamily: MONO,
    flexShrink: 0,
  };
}

export const endpointPath: CSSProperties = {
  color: DOCS.code.path,
  fontFamily: MONO,
  fontSize: '0.82rem',
  flexShrink: 0,
};

export const endpointDesc: CSSProperties = {
  color: DOCS.textMuted,
  fontSize: '0.81rem',
  lineHeight: 1.4,
};

/* ─── Tables ─────────────────────────────────────────────────────────────── */

export const tableFrame: CSSProperties = {
  borderRadius: 12,
  overflow: 'hidden',
  border: `1px solid ${hexToRgba(DOCS.accent, 0.18)}`,
  marginBottom: 20,
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
};

export const table: CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: '0.82rem',
};

export const theadRow: CSSProperties = {
  background: DOCS.scrimDeep,
};

export const th: CSSProperties = {
  padding: '9px 14px',
  textAlign: 'left',
  color: DOCS.textFaint,
  fontWeight: 700,
  letterSpacing: '0.06em',
  fontSize: '0.67rem',
  textTransform: 'uppercase',
  borderBottom: `1px solid ${hexToRgba(DOCS.accent, 0.15)}`,
};

export function zebra(i: number): CSSProperties {
  return { background: i % 2 === 0 ? 'transparent' : 'rgba(10,13,22,0.3)' };
}

export const td: CSSProperties = {
  padding: '9px 14px',
  borderBottom: '1px solid rgba(255,255,255,0.05)',
  color: DOCS.textMuted,
  lineHeight: 1.55,
};

export const tdNoWrap: CSSProperties = {
  ...td,
  whiteSpace: 'nowrap',
};

export const codeCell: CSSProperties = {
  color: DOCS.code.keyName,
  fontFamily: MONO,
  fontSize: '0.8rem',
  fontWeight: 700,
};

export const codeCellType: CSSProperties = {
  color: DOCS.code.literal,
  fontFamily: MONO,
  fontSize: '0.78rem',
};

export function requiredPill(required: boolean): CSSProperties {
  return {
    display: 'inline-block',
    padding: '2px 7px',
    borderRadius: 5,
    fontSize: '0.67rem',
    fontWeight: 700,
    letterSpacing: '0.05em',
    background: required ? hexToRgba(DOCS.accent, 0.12) : 'rgba(71,85,105,0.2)',
    color: required ? DOCS.code.keyName : DOCS.textFaint,
  };
}

/* ─── Note cards ─────────────────────────────────────────────────────────── */

export const noteGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
  gap: 12,
  marginBottom: 4,
};

export function noteCard(accent = DOCS.accent): CSSProperties {
  return {
    padding: '14px 16px',
    borderRadius: 12,
    background: hexToRgba(accent, 0.06),
    border: `1px solid ${hexToRgba(accent, 0.2)}`,
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
  };
}

export function noteCardTitle(accent = DOCS.accent): CSSProperties {
  return { fontSize: '0.8rem', fontWeight: 700, color: accent, marginBottom: 6 };
}

export const noteCardBody: CSSProperties = {
  fontSize: '0.81rem',
  color: DOCS.textMuted,
  lineHeight: 1.6,
};

/* ─── Page header ────────────────────────────────────────────────────────── */

/** Section-gap (32px) below the header per the app spacing standard. */
export const pageHeaderWrap: CSSProperties = {
  marginBottom: 32,
};

export function headerLogoBadge(accent = DOCS.accent): CSSProperties {
  return {
    width: 56,
    height: 56,
    borderRadius: 16,
    background: `linear-gradient(135deg, ${hexToRgba(accent, 0.22)} 0%, ${hexToRgba(accent, 0.05)} 100%)`,
    border: `1px solid ${hexToRgba(accent, 0.4)}`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: `0 0 28px -6px ${hexToRgba(accent, 0.5)}`,
    flexShrink: 0,
  };
}

export function headerEyebrow(accent = DOCS.accent): CSSProperties {
  return {
    fontSize: '0.6rem',
    fontWeight: 700,
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    color: accent,
    opacity: 0.9,
    marginBottom: 6,
  };
}

export const headerTitle: CSSProperties = {
  fontSize: 'clamp(1.3rem, 2.6vw, 1.7rem)',
  fontWeight: 800,
  color: '#ffffff',
  letterSpacing: '-0.025em',
  lineHeight: 1.15,
  margin: '0 0 8px',
  textShadow: '0 1px 18px rgba(0,0,0,0.5)',
};

export const headerSubtitle: CSSProperties = {
  fontSize: '0.88rem',
  color: DOCS.textMuted,
  lineHeight: 1.65,
  margin: 0,
  maxWidth: 540,
};

/* ─── Misc ───────────────────────────────────────────────────────────────── */

export function comingSoonBadge(accent = DOCS.amber): CSSProperties {
  return {
    display: 'inline-block',
    marginLeft: 10,
    padding: '2px 8px',
    borderRadius: 999,
    fontSize: '0.58rem',
    fontWeight: 700,
    letterSpacing: '0.07em',
    textTransform: 'uppercase',
    color: accent,
    background: hexToRgba(accent, 0.12),
    border: `1px solid ${hexToRgba(accent, 0.32)}`,
    verticalAlign: 'middle',
    lineHeight: 1.8,
  };
}

/** Step card used in the API "quick start" walkthrough. */
export const stepCard: CSSProperties = {
  display: 'flex',
  gap: 16,
  padding: '16px 18px',
  borderRadius: 12,
  background: DOCS.scrim,
  border: '1px solid rgba(255,255,255,0.08)',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
};

export function stepBadge(accent = DOCS.accent): CSSProperties {
  return {
    width: 28,
    height: 28,
    borderRadius: '50%',
    background: hexToRgba(accent, 0.14),
    border: `1px solid ${hexToRgba(accent, 0.32)}`,
    color: accent,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '0.78rem',
    fontWeight: 800,
    flexShrink: 0,
    fontFamily: MONO,
  };
}

export function stepTag(accent = DOCS.accent): CSSProperties {
  return {
    fontSize: '0.6rem',
    fontWeight: 700,
    letterSpacing: '0.07em',
    textTransform: 'uppercase',
    color: accent,
    background: hexToRgba(accent, 0.12),
    border: `1px solid ${hexToRgba(accent, 0.26)}`,
    borderRadius: 5,
    padding: '1px 6px',
  };
}

/** Small Q/A help card used in the RCF "need help" section. */
export const helpCard: CSSProperties = {
  padding: '12px 16px',
  borderRadius: 10,
  background: DOCS.scrim,
  border: '1px solid rgba(255,255,255,0.08)',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
};

/* ─── Product-guide layout ───────────────────────────────────────────────── */

/**
 * A titled reading section inside a product guide (e.g. "In plain English",
 * "How it works"). Rendered on a frosted panel so the prose keeps strong
 * contrast over the ambient backdrop.
 */
export const guideSectionTitle: CSSProperties = {
  fontSize: '0.68rem',
  fontWeight: 700,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: DOCS.accent,
  margin: '0 0 14px',
  display: 'flex',
  alignItems: 'center',
  gap: 9,
};

/** Lead paragraph — slightly larger + brighter than body copy for the opener. */
export const guideLead: CSSProperties = {
  margin: 0,
  fontSize: '1.02rem',
  color: DOCS.text,
  lineHeight: 1.72,
  fontWeight: 400,
};

/* ─── "Who it's for" checklist ───────────────────────────────────────────── */

export const whoList: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  margin: 0,
  padding: 0,
  listStyle: 'none',
};

export const whoItem: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 12,
  fontSize: '0.9rem',
  color: DOCS.textMuted,
  lineHeight: 1.6,
};

export function whoTick(accent = DOCS.accent): CSSProperties {
  return {
    width: 22,
    height: 22,
    borderRadius: 7,
    flexShrink: 0,
    marginTop: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: hexToRgba(accent, 0.12),
    border: `1px solid ${hexToRgba(accent, 0.3)}`,
    color: accent,
  };
}

/* ─── "What you get" feature list ────────────────────────────────────────── */

export const featureGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
  gap: 14,
};

export function featureCard(accent = DOCS.accent): CSSProperties {
  return {
    padding: '16px 18px',
    borderRadius: 14,
    background: DOCS.scrim,
    border: `1px solid ${hexToRgba(accent, 0.16)}`,
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    display: 'flex',
    gap: 13,
    alignItems: 'flex-start',
  };
}

export function featureDot(accent = DOCS.accent): CSSProperties {
  return {
    width: 30,
    height: 30,
    borderRadius: 9,
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: `linear-gradient(135deg, ${hexToRgba(accent, 0.2)} 0%, ${hexToRgba(accent, 0.05)} 100%)`,
    border: `1px solid ${hexToRgba(accent, 0.3)}`,
    color: accent,
    marginTop: 1,
  };
}

export const featureTitle: CSSProperties = {
  fontSize: '0.9rem',
  fontWeight: 700,
  color: DOCS.text,
  marginBottom: 4,
  letterSpacing: '-0.01em',
};

export const featureBody: CSSProperties = {
  fontSize: '0.83rem',
  color: DOCS.textMuted,
  lineHeight: 1.6,
};

/* ─── "Getting started" steps ────────────────────────────────────────────── */

export const stepsWrap: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  marginBottom: 22,
};

/* ─── Sign-up / next-step call-to-action ─────────────────────────────────── */

export function ctaCard(accent = DOCS.accent): CSSProperties {
  return {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 18,
    padding: '22px 26px',
    borderRadius: 16,
    background: `linear-gradient(135deg, ${hexToRgba(accent, 0.14)} 0%, ${hexToRgba(accent, 0.04)} 100%)`,
    border: `1px solid ${hexToRgba(accent, 0.32)}`,
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    boxShadow: `inset 0 1px 0 rgba(255,255,255,0.1), 0 0 34px -14px ${hexToRgba(accent, 0.5)}`,
  };
}

export const ctaTitle: CSSProperties = {
  fontSize: '1.05rem',
  fontWeight: 800,
  color: '#ffffff',
  letterSpacing: '-0.02em',
  marginBottom: 4,
};

export const ctaBody: CSSProperties = {
  fontSize: '0.85rem',
  color: DOCS.textMuted,
  lineHeight: 1.6,
  maxWidth: 460,
};

export function ctaButton(accent = DOCS.accent): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    padding: '11px 22px',
    borderRadius: 10,
    background: `linear-gradient(135deg, ${accent} 0%, ${hexToRgba(accent, 0.82)} 100%)`,
    border: 'none',
    color: '#ffffff',
    fontSize: '0.86rem',
    fontWeight: 700,
    letterSpacing: '-0.01em',
    cursor: 'pointer',
    textDecoration: 'none',
    whiteSpace: 'nowrap',
    boxShadow: `0 4px 18px -6px ${hexToRgba(accent, 0.7)}`,
    transition: 'transform 0.15s ease, box-shadow 0.15s ease',
  };
}

export function ctaButtonGhost(accent = DOCS.accent): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    padding: '11px 18px',
    borderRadius: 10,
    background: 'transparent',
    border: `1px solid ${hexToRgba(accent, 0.4)}`,
    color: DOCS.text,
    fontSize: '0.84rem',
    fontWeight: 600,
    letterSpacing: '-0.01em',
    cursor: 'pointer',
    textDecoration: 'none',
    whiteSpace: 'nowrap',
    transition: 'background 0.15s ease, border-color 0.15s ease',
  };
}

/* ─── Docs hub (landing) ─────────────────────────────────────────────────── */

/** Wider reading measure for the hub grid than the single-guide column. */
export const hubColumn: CSSProperties = {
  maxWidth: 1180,
  margin: '0 auto',
};

/** Intro prose block above the product-card grid. */
export const hubIntro: CSSProperties = {
  maxWidth: 720,
  margin: '0 0 32px',
};

export const hubIntroLead: CSSProperties = {
  fontSize: '1.05rem',
  color: DOCS.text,
  lineHeight: 1.75,
  margin: '0 0 14px',
};

export const hubGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
  gap: 16,
};

export const hubCardBody: CSSProperties = {
  padding: '20px 22px 22px',
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
};

export function hubIconBox(accent = DOCS.accent): CSSProperties {
  return {
    width: 44,
    height: 44,
    borderRadius: 12,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: `linear-gradient(135deg, ${hexToRgba(accent, 0.22)} 0%, ${hexToRgba(accent, 0.05)} 100%)`,
    border: `1px solid ${hexToRgba(accent, 0.34)}`,
    color: accent,
    flexShrink: 0,
    marginBottom: 15,
    boxShadow: `0 0 20px -6px ${hexToRgba(accent, 0.5)}`,
  };
}

export const hubCardTitle: CSSProperties = {
  fontSize: '1.02rem',
  fontWeight: 700,
  color: DOCS.text,
  letterSpacing: '-0.01em',
  marginBottom: 7,
};

export const hubCardPitch: CSSProperties = {
  fontSize: '0.87rem',
  color: DOCS.textMuted,
  lineHeight: 1.62,
  marginBottom: 14,
  flex: 1,
};

export const hubCardMeta: CSSProperties = {
  fontSize: '0.72rem',
  color: DOCS.textFaint,
  lineHeight: 1.5,
  paddingTop: 12,
  borderTop: '1px solid rgba(255,255,255,0.07)',
};

export function hubCardLink(accent = DOCS.accent): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: '0.78rem',
    fontWeight: 700,
    color: accent,
    marginTop: 12,
    letterSpacing: '-0.01em',
  };
}

/* ─── Back-to-hub breadcrumb (top of each guide) ─────────────────────────── */

export function backLink(hovered: boolean, accent = DOCS.accent): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: '0.76rem',
    fontWeight: 600,
    color: hovered ? accent : DOCS.textMuted,
    textDecoration: 'none',
    marginBottom: 16,
    letterSpacing: '0.01em',
    transition: 'color 0.15s ease',
  };
}
