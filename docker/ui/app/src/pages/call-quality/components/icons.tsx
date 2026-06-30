/**
 * Inline SVG icons for the Call Quality feature. Every export is a component
 * (zero/simple props) so this file stays fast-refresh clean. `currentColor`
 * lets parents tint via surrounding style.
 */

export const IconSearch = ({ stroke }: { stroke: string }) => (
  <svg viewBox="0 0 16 16" fill="none" stroke={stroke} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" style={{ width: 15, height: 15, flexShrink: 0, transition: 'stroke 0.18s' }}>
    <circle cx="6.5" cy="6.5" r="4" />
    <path d="M11 11l2.5 2.5" />
  </svg>
);

export const IconSearchSmall = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" style={{ width: 14, height: 14 }}>
    <circle cx="6.5" cy="6.5" r="4" />
    <path d="M11 11l2.5 2.5" />
  </svg>
);

export const IconError = () => (
  <svg viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" style={{ width: 22, height: 22 }}>
    <path d="M11 7v5M11 15.5v.01" />
    <circle cx="11" cy="11" r="9" />
  </svg>
);
