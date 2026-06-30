/**
 * Inline SVG icons for the Account page card headers. Zero-prop components only
 * (keeps react-refresh/only-export-components happy). `currentColor` lets the
 * parent badge tint them via its surrounding colour.
 */

export const IconUser = () => (
  <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" style={{ width: 18, height: 18 }}>
    <circle cx="9" cy="6" r="3.2" />
    <path d="M3.5 15.2c0-2.9 2.5-4.6 5.5-4.6s5.5 1.7 5.5 4.6" />
  </svg>
);

export const IconLock = () => (
  <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" style={{ width: 18, height: 18 }}>
    <rect x="3.5" y="8" width="11" height="7.5" rx="1.6" />
    <path d="M6 8V5.8a3 3 0 0 1 6 0V8" />
    <path d="M9 11v2" />
  </svg>
);
