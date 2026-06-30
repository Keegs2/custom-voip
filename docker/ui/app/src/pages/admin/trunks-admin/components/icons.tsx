/**
 * Small inline SVG icons for the Trunks admin feature. All are zero-/simple-prop
 * components (this file only exports components, keeping fast-refresh happy).
 * `currentColor` lets the parent tint via surrounding style.
 */

export const IconSearch = ({ stroke }: { stroke: string }) => (
  <svg viewBox="0 0 16 16" fill="none" stroke={stroke} strokeWidth={1.7} strokeLinecap="round" style={{ width: 15, height: 15, flexShrink: 0, transition: 'stroke 0.18s' }}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5L14 14" />
  </svg>
);

export const IconPlus = () => (
  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" style={{ width: 13, height: 13 }}>
    <path d="M7 2v10M2 7h10" />
  </svg>
);

export const IconPencil = ({ color }: { color: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" style={{ width: 12, height: 12, opacity: 0.55, flexShrink: 0 }}>
    <path d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10" />
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
    <path d="M3 6h16M3 11h16M3 16h9" />
  </svg>
);
