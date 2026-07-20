/**
 * Reading-content text primitives shared by both documentation pages.
 *
 * Presentational only — every visual decision comes from `styles.ts`. This file
 * exports only components (keeps `react-refresh/only-export-components` happy).
 */

import type { ReactNode } from 'react';
import { Info } from 'lucide-react';
import { DOCS, paragraph, h3, inlineCode, callout } from '../styles';

/** Body paragraph. */
export function P({ children }: { children: ReactNode }) {
  return <p style={paragraph}>{children}</p>;
}

/** Sub-section heading inside an accordion body. */
export function H3({ children }: { children: ReactNode }) {
  return <h3 style={h3}>{children}</h3>;
}

/** Inline code span. */
export function IC({ children }: { children: ReactNode }) {
  return <code style={inlineCode}>{children}</code>;
}

/** Emphasised inline text — bright over the glass for contrast. */
export function B({ children }: { children: ReactNode }) {
  return <strong style={{ color: DOCS.text }}>{children}</strong>;
}

/** Frosted callout box, tinted by `accent`. */
export function Callout({ accent = DOCS.accent, children }: { accent?: string; children: ReactNode }) {
  return (
    <div style={callout(accent)}>
      <div style={{ color: accent, flexShrink: 0, marginTop: 1 }}>
        <Info size={14} />
      </div>
      <div>{children}</div>
    </div>
  );
}
