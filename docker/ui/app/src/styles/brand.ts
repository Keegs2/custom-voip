/**
 * The brand blue family — the TS mirror of the `--brand-*` custom properties
 * in the `:root` block of src/index.css (keep the two equal).
 *
 * THEMING: these are fixed HEX identity values. They do NOT follow the
 * light/dark theme, so screen code must not paint with them — use the theme
 * tokens instead (src/styles/theme.ts): `T.accent` / `T.accentText` /
 * `T.accentLine`, `tMix('accent', 10)` for washes, `CHART.*` for series,
 * `TONE.*` for status. The hex exports remain for the places that are
 * deliberately theme-less: the @react-pdf Reporting document (print —
 * always light) and colour maths. See docker/ui/CLAUDE.md "Theming".
 */

/** Primary buttons, primary chart series, links, active states. */
export const BRAND_AZURE = '#2f7df6';
/** Button hover/pressed, link hover, accent text on paper (5.4:1 on white). */
export const BRAND_AZURE_DEEP = '#1d63dd';
/** Highlights and glow on dark, focus rings, series drawn on dark surfaces. */
export const BRAND_AZURE_BRIGHT = '#4f92ff';
/** Deep accent, secondary chart series, gradients (azure → cobalt). */
export const BRAND_COBALT = '#113398';
/** Darkest accent, pressed state on dark. */
export const BRAND_COBALT_DEEP = '#0b246e';
/** Glow shadow colour for buttons and active states. */
export const BRAND_GLOW = 'rgba(47, 125, 246, 0.35)';

/**
 * Translucent azure HEX-family wash, e.g. `brandAzureAlpha(0.07)`. Print /
 * theme-less use only — on screen use `tMix('accent', 7)` (styles/theme.ts).
 */
export function brandAzureAlpha(alpha: number): string {
  return `rgba(47, 125, 246, ${alpha})`;
}

/**
 * Chart series roles — the LIGHT / PRINT values. Primary = azure; a second
 * quantitative series = cobalt; a third (usually dashed) = azure-bright; the
 * neutral/"didn't happen" series (missed calls) = slate.
 *
 * On screen use the theme-aware twin `CHART` from styles/theme.ts (same
 * roles, `var(--t-chart-*)` strings that re-colour on dark: cobalt would
 * vanish on granite). This hex set stays for the Reporting PDF.
 */
export const CHART_SERIES = {
  primary: BRAND_AZURE,
  secondary: BRAND_COBALT,
  tertiary: BRAND_AZURE_BRIGHT,
  neutral: '#c3cede',
} as const;

export type ChartSeriesRole = keyof typeof CHART_SERIES;
