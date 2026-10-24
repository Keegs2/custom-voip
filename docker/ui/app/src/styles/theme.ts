/**
 * Theme tokens for TSX — the typed mirror of the NAMES in src/styles/theme.css
 * (the values live only in CSS; both themes define every token). Contract:
 * docker/ui/CLAUDE.md § "Theming (light / dark)".
 *
 * THE pattern for colour in TSX: inline styles and SVG paint use the
 * `var(--t-…)` strings from `T` — never hex. They flip with the theme for
 * free, with no re-render:
 *
 *   <span style={{ color: T.textDim, borderColor: T.line }} />
 *   <rect style={{ fill: T.chart1 }} />          // SVG: paint via `style`
 *   <div style={{ background: tMix('accent', 12) }} />  // = azure @ 12%
 *
 * Only code that must hand a RESOLVED colour to something CSS can't reach
 * (a <canvas>, a library that parses colours) reads it, via
 * `useResolvedToken()` (contexts/ThemeContext) or `readToken()`. The
 * Reporting PDF (@react-pdf) is print: it keeps its own hex and stays light.
 */

/* ─── Token names ──────────────────────────────────────────────────────── */

export const THEME_TOKENS = [
  // canvas + surfaces
  'canvas', 'canvas-bg', 'surface', 'panel-bg', 'surface-raised', 'surface-sunken',
  'tint', 'tint-hover', 'hover', 'pressed', 'scrim',
  // lines
  'line', 'line-soft', 'line-strong',
  // text
  'text', 'text-strong', 'text-soft', 'text-dim', 'text-faint', 'text-on-accent',
  // accent
  'accent', 'accent-hover', 'accent-line', 'accent-text', 'accent-text-hover',
  'accent-wash', 'accent-tint', 'accent-border', 'cobalt',
  // focus
  'focus', 'focus-halo',
  // fields
  'field-bg', 'field-border', 'field-border-hover', 'field-placeholder', 'field-disabled-bg',
  // status
  'ok-fg', 'ok-bg', 'ok-border', 'ok-solid',
  'warn-fg', 'warn-bg', 'warn-border', 'warn-solid',
  'danger-fg', 'danger-bg', 'danger-border', 'danger-solid',
  'info-fg', 'info-bg', 'info-border', 'info-solid',
  'neutral-fg', 'neutral-bg', 'neutral-border', 'neutral-solid',
  // categorical hues
  'violet', 'teal',
  // elevation + glow
  'highlight', 'shadow-xs', 'shadow-card', 'shadow-card-hover', 'shadow-pop', 'shadow-modal',
  'glow', 'glow-text', 'keyline',
  // inverse band (granite header strip)
  'band-bg', 'band-edge', 'band-shadow', 'band-text', 'band-text-strong', 'band-text-soft',
  'band-text-dim', 'band-line', 'band-tint', 'band-accent',
  // charts
  'chart-1', 'chart-2', 'chart-3', 'chart-neutral', 'chart-grid', 'chart-axis',
  'chart-label', 'chart-label-strong', 'chart-hover-band',
  'chart-tooltip-bg', 'chart-tooltip-border', 'chart-tooltip-text',
  // document chrome
  'selection-bg', 'selection-fg', 'scrollbar', 'scrollbar-hover', 'chevron',
  // sidebar
  'sb-bg', 'sb-bg-solid', 'sb-border', 'sb-divider', 'sb-glow', 'sb-wordmark', 'sb-wordmark-dim',
  'sb-mark-glow', 'sb-text', 'sb-text-hover', 'sb-text-active', 'sb-hover',
  'sb-icon', 'sb-icon-bg', 'sb-icon-border', 'sb-icon-hover', 'sb-icon-bg-hover', 'sb-icon-border-hover',
  'sb-head', 'sb-head-hover', 'sb-subhead',
  'sb-muted', 'sb-muted-hover', 'sb-muted-icon', 'sb-muted-icon-bg', 'sb-muted-icon-border',
  'sb-muted-hover-bg', 'sb-muted-active-bg', 'sb-muted-active-border', 'sb-muted-active-text',
  'sb-pill-text', 'sb-pill-bg', 'sb-pill-border',
  'sb-accent-azure', 'sb-accent-green', 'sb-accent-amber',
  'sb-card-bg', 'sb-card-border', 'sb-name', 'sb-meta',
  'sb-avatar-bg', 'sb-avatar-border', 'sb-avatar-text', 'sb-btn-border', 'sb-btn-icon',
  'sb-scrollbar', 'sb-field-bg', 'sb-field-border', 'sb-field-text',
  'sb-banner-bg', 'sb-banner-border', 'sb-banner-text', 'sb-banner-icon', 'sb-banner-label',
  'sb-banner-pill-bg', 'sb-banner-pill-border',
  'sb-banner-field-bg', 'sb-banner-field-text', 'sb-banner-field-border',
  'sb-banner-field-border-hover', 'sb-banner-field-focus', 'sb-banner-field-halo',
  'sb-banner-chevron',
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number];

/** `'text-dim'` → `'var(--t-text-dim)'`. */
export function tv<K extends ThemeToken>(token: K): `var(--t-${K})` {
  return `var(--t-${token})`;
}

/**
 * A translucent variant of a COLOUR token: `tMix('accent', 10)` →
 * `color-mix(in srgb, var(--t-accent) 10%, transparent)`. In light this is
 * exactly `rgba(47, 125, 246, 0.1)`; in dark it follows the dark token.
 * Use it instead of `${hex}22`-style alpha suffixes.
 */
export function tMix(token: ThemeToken, percent: number): string {
  return `color-mix(in srgb, var(--t-${token}) ${percent}%, transparent)`;
}

/* ─── `T` — every token as a ready `var()` string, camelCased ──────────── */

type CamelCase<S extends string> = S extends `${infer Head}-${infer Tail}`
  ? `${Head}${Capitalize<CamelCase<Tail>>}`
  : S;

export type ThemeTokenVars = { readonly [K in ThemeToken as CamelCase<K>]: `var(--t-${K})` };

function camel(token: string): string {
  return token.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

/**
 * `T.textDim === 'var(--t-text-dim)'`, `T.chart1 === 'var(--t-chart-1)'`,
 * `T.sbAccentGreen === 'var(--t-sb-accent-green)'`.
 */
export const T: ThemeTokenVars = Object.freeze(
  Object.fromEntries(THEME_TOKENS.map((k) => [camel(k), `var(--t-${k})`])),
) as ThemeTokenVars;

/* ─── Status tones — one shape for pills, badges, banners ──────────────── */

export type StatusTone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral';

export interface ToneVars {
  /** Text / icon on a surface. */
  fg: string;
  /** Pill / banner fill. */
  bg: string;
  /** Pill / banner border. */
  border: string;
  /** Dots, bars, accent edges. */
  solid: string;
}

/** `TONE.ok.fg === 'var(--t-ok-fg)'` … — replaces hex tone triples. */
export const TONE: Readonly<Record<StatusTone, ToneVars>> = Object.freeze({
  ok: { fg: T.okFg, bg: T.okBg, border: T.okBorder, solid: T.okSolid },
  warn: { fg: T.warnFg, bg: T.warnBg, border: T.warnBorder, solid: T.warnSolid },
  danger: { fg: T.dangerFg, bg: T.dangerBg, border: T.dangerBorder, solid: T.dangerSolid },
  info: { fg: T.infoFg, bg: T.infoBg, border: T.infoBorder, solid: T.infoSolid },
  neutral: { fg: T.neutralFg, bg: T.neutralBg, border: T.neutralBorder, solid: T.neutralSolid },
});

/* ─── Chart series (screen) — the theme-safe twin of brand.ts CHART_SERIES ─ */

export const CHART = Object.freeze({
  primary: T.chart1,
  secondary: T.chart2,
  tertiary: T.chart3,
  neutral: T.chartNeutral,
  grid: T.chartGrid,
  axis: T.chartAxis,
  label: T.chartLabel,
  labelStrong: T.chartLabelStrong,
  hoverBand: T.chartHoverBand,
});

/* ─── Resolved values (rare — see the header) ──────────────────────────── */

/**
 * The computed value of a token right now (e.g. `"#0e1726"`), read from
 * <html>. Not reactive: inside a component use `useResolvedToken()` from
 * contexts/ThemeContext, which re-reads when the theme changes. Returns ''
 * outside a browser.
 */
export function readToken(token: ThemeToken, el?: Element): string {
  if (typeof document === 'undefined') return '';
  const target = el ?? document.documentElement;
  return getComputedStyle(target).getPropertyValue(`--t-${token}`).trim();
}

/* ─── The theme itself — storage + <html> sync (used by ThemeProvider) ─── */

export type Theme = 'light' | 'dark';

/**
 * localStorage key for the user's explicit choice ('light' | 'dark'); absent
 * = follow the OS. The inline script in index.html reads the same key —
 * keep the two in step.
 */
export const THEME_STORAGE_KEY = 'crag_theme';

export function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark';
}

export function readStoredTheme(): Theme | null {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function writeStoredTheme(theme: Theme | null): void {
  try {
    if (theme) window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    else window.localStorage.removeItem(THEME_STORAGE_KEY);
  } catch {
    // Storage blocked (private mode, quota) — the choice lasts this session.
  }
}

const DARK_QUERY = '(prefers-color-scheme: dark)';

export function systemTheme(): Theme {
  try {
    return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** Subscribe to OS light/dark changes; returns the unsubscribe. */
export function watchSystemTheme(onChange: (theme: Theme) => void): () => void {
  let mql: MediaQueryList;
  try {
    mql = window.matchMedia(DARK_QUERY);
  } catch {
    return () => {};
  }
  const handler = (e: MediaQueryListEvent) => onChange(e.matches ? 'dark' : 'light');
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }
  // Safari < 14
  mql.addListener(handler);
  return () => mql.removeListener(handler);
}

/**
 * The public landing page keeps its own dark design whatever the theme:
 * while it is on screen <html data-landing> forces the dark token set and a
 * dark color-scheme. AppLayout flips this on route; index.html sets it
 * before first paint for '/'.
 */
export function setLandingSurface(on: boolean): void {
  const root = document.documentElement;
  if (on) root.setAttribute('data-landing', '');
  else root.removeAttribute('data-landing');
  syncColorScheme();
}

function syncColorScheme(): void {
  const root = document.documentElement;
  const theme = isTheme(root.dataset.theme) ? root.dataset.theme : 'light';
  root.style.colorScheme = root.hasAttribute('data-landing') ? 'dark' : theme;
}

/** Writes the theme onto <html>: `data-theme` + `style.colorScheme`. */
export function applyThemeToDocument(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  syncColorScheme();
}
