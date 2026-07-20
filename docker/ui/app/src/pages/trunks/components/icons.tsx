/**
 * Inline SVG icons shared across the Trunks glass components. All are
 * zero-/simple-prop components (so this file only exports components, keeping
 * react-refresh happy). `currentColor` lets the parent tint via surrounding
 * style.
 */

export const IconSearch = ({ stroke }: { stroke: string }) => (
  <svg viewBox="0 0 16 16" fill="none" stroke={stroke} strokeWidth={1.7} strokeLinecap="round" style={{ width: 15, height: 15, flexShrink: 0, transition: 'stroke 0.18s' }}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5L14 14" />
  </svg>
);

export const IconRefresh = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ width: 12, height: 12 }}>
    <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
  </svg>
);

export const IconChevron = ({ up }: { up: boolean }) => (
  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" style={{ width: 12, height: 12, transform: up ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
    <path d="M3 5l4 4 4-4" />
  </svg>
);

export const IconError = () => (
  <svg viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" style={{ width: 28, height: 28 }}>
    <path d="M11 7v5M11 15.5v.01" />
    <circle cx="11" cy="11" r="9" />
  </svg>
);
