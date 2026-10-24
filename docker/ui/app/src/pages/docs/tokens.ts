/**
 * Colour roles for the documentation pages' inline styles — theme tokens
 * (`var(--t-…)` strings from styles/theme.ts), so they follow light / dark
 * (docker/ui/CLAUDE.md §18). Light resolves to exactly the old daylight hex:
 * text #0e1726, textMuted #46566f, textFaint #5d6f8c, accent #2f7df6.
 *
 * Kept in a component-free module so shared.tsx satisfies
 * react-refresh/only-export-components.
 */
import { T } from '../../styles/theme';

export const C = {
  bg: T.canvas,
  surface: T.surface,
  surfaceAlt: T.tint,
  border: T.line,
  borderSubtle: T.lineSoft,
  text: T.text,
  textMuted: T.textSoft,
  textFaint: T.textDim,
  /** Azure links + icons: brand azure on light, azure-bright on dark. */
  accent: T.accentLine,
  amber: T.warnFg,
  red: T.dangerFg,
} as const;

export const MONO = '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace';
