/**
 * Palette constants for the RCF console and the dashboard's RCF tools, for
 * places a CSS class can't reach (inline styles, computed tones). Shared by
 * RcfPage and pages/rcf/* so the values never drift.
 *
 * Every colour is a `var()` string, so it follows the light / dark theme
 * with no re-render (docker/ui/CLAUDE.md §18). On light each resolves to
 * exactly the daylight value it replaced (INK = #0e1726 …); on dark to the
 * granite set. SVG: paint through `style` (`style={{ stroke: AZURE_DEEP }}`)
 * or `currentColor`, never the `fill=` / `stroke=` attributes.
 */
import { T } from '../../styles/theme';

export const MONO = '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace';

export const INK = T.text;
export const INK_SOFT = T.textSoft;
export const INK_DIM = T.textDim;
export const INK_FAINT = T.textFaint;
/** Azure fills, rings and ticks (azure in both themes). */
export const AZURE = T.accent;
/** Accent TEXT and glyphs: azure-deep on light, azure-bright on dark. Never a fill under white text. */
export const AZURE_DEEP = T.accentText;
export const GREEN = T.okFg;
export const RED = T.dangerFg;

/**
 * The daylight page palette (index.css, "DAYLIGHT PAGE PALETTE"): the light
 * values the console has always drawn that no theme token carries exactly,
 * each with a dark twin. Typed here so TSX never spells a raw custom
 * property.
 */
export const DL = Object.freeze({
  /** Soft slate: separators, disabled glyphs, empty-state icons. */
  slateSoft: 'var(--dl-slate-soft)',
  /** Muted slate: an absent value ("—"), placeholder figures. */
  slateMute: 'var(--dl-slate-mute)',
  /** Borders of small controls: pager buttons, menus, count pills. */
  ctlBorder: 'var(--dl-ctl-border)',
  /** Cool hairline: table-head rule, dialog and detail-card borders. */
  rule: 'var(--dl-rule)',
  /** Inset well under an expanded row. */
  well: 'var(--dl-well)',
  /** Lift of the detail card inside an expanded row. */
  detailShadow: 'var(--dl-detail-shadow)',
  /** The azure hairline across the top of that card (a gradient stop). */
  detailLine: 'var(--dl-detail-line)',
  /** Azure-tinted icon tile. */
  iconWash: 'var(--dl-icon-wash)',
  /** Icon tile of the selected option in a menu. */
  iconWashStrong: 'var(--dl-icon-wash-strong)',
  /** Icon tile of an unselected option in a menu. */
  iconWashMute: 'var(--dl-icon-wash-mute)',
  /** Azure note box inside a dialog. */
  noteWash: 'var(--dl-note-wash)',
  /** "Release requested" — the sky state (fg / solid). */
  sky: 'var(--dl-sky)',
  skySolid: 'var(--dl-sky-solid)',
} as const);

export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;
