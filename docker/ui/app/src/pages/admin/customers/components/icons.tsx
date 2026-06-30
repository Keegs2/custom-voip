/**
 * Small inline SVG icons for the Customers admin glass page. Zero-/simple-prop
 * components only (keeps react-refresh happy). `currentColor` lets the parent
 * tint via surrounding style.
 */

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
    <circle cx="8" cy="7" r="3" />
    <path d="M2.5 18a5.5 5.5 0 0 1 11 0" />
    <path d="M15 5.5a3 3 0 0 1 0 5.8M19.5 18a5.5 5.5 0 0 0-4-5.3" />
  </svg>
);
