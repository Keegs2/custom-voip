/**
 * The brand blue family — the TS mirror of the `--brand-*` custom properties
 * in the `:root` block of src/index.css (keep the two equal). CSS should use
 * the custom properties; this module exists for the places CSS variables
 * can't reach: inline SVG fill/stroke attributes, chart series, computed
 * tones and the @react-pdf report document.
 *
 * Taken from the account dashboard's hero header, so buttons, charts and
 * active states across the app read as one family.
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

/** Translucent azure for tints/washes, e.g. `brandAzureAlpha(0.07)`. */
export function brandAzureAlpha(alpha: number): string {
  return `rgba(47, 125, 246, ${alpha})`;
}

/**
 * Chart series roles. Primary = azure; a second quantitative series =
 * cobalt; a third (usually dashed) = azure-bright; the neutral/"didn't
 * happen" series (missed calls) = slate, matching the account dashboard's
 * Call volume card. Semantic status colours (good/warn/bad) are NOT here —
 * they come from pages/calls/quality.ts.
 */
export const CHART_SERIES = {
  primary: BRAND_AZURE,
  secondary: BRAND_COBALT,
  tertiary: BRAND_AZURE_BRIGHT,
  neutral: '#c3cede',
} as const;

export type ChartSeriesRole = keyof typeof CHART_SERIES;
