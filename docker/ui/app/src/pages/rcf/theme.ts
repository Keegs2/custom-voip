/**
 * Daylight palette constants for the RCF console — mirror the `.rcf-scope`
 * CSS custom properties in index.css for places CSS vars can't reach
 * (inline SVG attributes, computed tones). Shared by RcfPage and the
 * extracted Call Activity tab (pages/rcf/*) so the values never drift.
 */

export const MONO = '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace';

export const INK = '#0e1726';
export const INK_SOFT = '#46566f';
export const INK_DIM = '#5d6f8c';
export const INK_FAINT = '#8b99b0';
export const AZURE = '#2f7df6';
export const AZURE_DEEP = '#1d63dd';
export const GREEN = '#15803d';
export const RED = '#b91c1c';

export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;
