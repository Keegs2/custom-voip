/**
 * Design tokens for the documentation pages — mirror the .dl-scope CSS vars
 * declared in index.css (DAYLIGHT CONSOLE system).
 *
 * Kept in a component-free module so shared.tsx satisfies
 * react-refresh/only-export-components.
 */

export const C = {
  bg: '#f4f6f9',
  surface: '#ffffff',
  surfaceAlt: '#f7f9fc',
  border: '#e2e8f2',
  borderSubtle: '#edf1f7',
  text: '#0e1726',
  textMuted: '#46566f',
  textFaint: '#5d6f8c',
  accent: '#2f7df6',
  amber: '#b45309',
  red: '#b91c1c',
} as const;

export const MONO = '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace';
