/**
 * Small inline SVG icons shared across the RCF glass components. All are
 * zero-/simple-prop components (so this file only exports components, keeping
 * fast-refresh happy). `currentColor` lets the parent tint via surrounding style.
 */

export const IconClock = () => (
  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" style={{ width: 12, height: 12 }}>
    <circle cx="7" cy="7" r="5.5" />
    <path d="M7 4v3l1.8 1.8" />
  </svg>
);

export const IconId = () => (
  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" style={{ width: 12, height: 12 }}>
    <rect x="1.5" y="3" width="11" height="8" rx="1.5" />
    <circle cx="5" cy="7" r="1.4" />
    <path d="M8.5 6h2.5M8.5 8.4h2" />
  </svg>
);

export const IconSearch = ({ stroke }: { stroke: string }) => (
  <svg viewBox="0 0 16 16" fill="none" stroke={stroke} strokeWidth={1.7} strokeLinecap="round" style={{ width: 15, height: 15, flexShrink: 0, transition: 'stroke 0.18s' }}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5L14 14" />
  </svg>
);

export const IconCards = () => (
  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.6} style={{ width: 13, height: 13 }}>
    <rect x="1" y="1" width="5" height="5" rx="1" />
    <rect x="8" y="1" width="5" height="5" rx="1" />
    <rect x="1" y="8" width="5" height="5" rx="1" />
    <rect x="8" y="8" width="5" height="5" rx="1" />
  </svg>
);

export const IconTable = () => (
  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" style={{ width: 13, height: 13 }}>
    <path d="M1 3.5h12M1 7h12M1 10.5h12" />
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

/** The "forwards to" arrow used in the card divider. */
export const IconArrow = ({ color }: { color: string }) => (
  <svg viewBox="0 0 18 10" fill="none" style={{ width: 17, height: 9 }}>
    <line x1="1" y1="5" x2="14" y2="5" stroke={color} strokeWidth={1.5} strokeLinecap="round" />
    <path d="M11 2l3 3-3 3" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** The pencil glyph inside the inline-edit affordance. */
export const IconPencil = ({ color, big }: { color: string; big: boolean }) => (
  <svg viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" style={{ width: big ? 12 : 11, height: big ? 12 : 11 }}>
    <path d="M11.5 2.5a1.414 1.414 0 0 1 2 2L5 13H2v-3L11.5 2.5z" />
  </svg>
);
