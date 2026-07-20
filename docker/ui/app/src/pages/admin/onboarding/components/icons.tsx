/**
 * Inline SVG icons for the Onboarding admin components. Every export is a
 * component (no constants/functions) so `react-refresh/only-export-components`
 * stays happy. `currentColor` lets a parent tint via surrounding style.
 */

export const IconChevron = () => (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ width: 11, height: 11 }}>
    <path d="M4.5 2.5L8 6L4.5 9.5" />
  </svg>
);

export const IconSearch = ({ stroke }: { stroke: string }) => (
  <svg viewBox="0 0 16 16" fill="none" stroke={stroke} strokeWidth={1.7} strokeLinecap="round" style={{ width: 15, height: 15, flexShrink: 0, transition: 'stroke 0.18s' }}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5L14 14" />
  </svg>
);

export const IconError = () => (
  <svg viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" style={{ width: 26, height: 26 }}>
    <path d="M11 7v5M11 15.5v.01" />
    <circle cx="11" cy="11" r="9" />
  </svg>
);

export const IconEmpty = () => (
  <svg viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" style={{ width: 26, height: 26 }}>
    <path d="M4 6.5h14M4 11h14M4 15.5h8" />
  </svg>
);

export const IconCheck = () => (
  <svg viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" style={{ width: 26, height: 26 }}>
    <path d="M4 11.5l4.5 4.5L18 6" />
  </svg>
);

/** The forwards-to arrow. */
export const IconArrow = ({ color }: { color: string }) => (
  <svg viewBox="0 0 18 10" fill="none" style={{ width: 16, height: 9, flexShrink: 0 }}>
    <line x1="1" y1="5" x2="14" y2="5" stroke={color} strokeWidth={1.5} strokeLinecap="round" />
    <path d="M11 2l3 3-3 3" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
