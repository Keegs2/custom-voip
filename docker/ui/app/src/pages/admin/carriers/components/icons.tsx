/**
 * Small inline SVG icons for the Carriers admin feature. All are zero-/simple-
 * prop components (this file only exports components, keeping fast-refresh happy).
 * `currentColor` lets the parent tint via surrounding style.
 */

export const IconPlus = () => (
  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" style={{ width: 13, height: 13 }}>
    <path d="M7 2v10M2 7h10" />
  </svg>
);

export const IconPulse = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" style={{ width: 13, height: 13 }}>
    <path d="M1 8h3l2-5 3 10 2-5h3" />
  </svg>
);

export const IconCheck = () => (
  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ width: 11, height: 11 }}>
    <path d="M2 7.5L5.5 11L12 3.5" />
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
    <rect x="3" y="4" width="16" height="6" rx="1.5" />
    <rect x="3" y="12" width="16" height="6" rx="1.5" />
    <path d="M6.5 7h.01M6.5 15h.01" />
  </svg>
);
