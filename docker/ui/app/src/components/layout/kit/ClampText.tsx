/**
 * ClampText — the first few lines of a long text, with a "Show more" /
 * "Show less" button that appears ONLY when the text is actually cut
 * (measured; re-measured when the box changes width). The full text is in
 * the DOM either way — find-in-page, copy and screen readers get all of it.
 *
 *   <ClampText lines={4} moreLabel="Show full transcript" className="vm-tx-text">
 *     {transcript}
 *   </ClampText>
 *
 * `className` styles the text box (padding, tint, font); the toggle sits
 * under it. `white-space: pre-wrap` text clamps fine.
 */
import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

export interface ClampTextProps {
  /** Lines shown while collapsed. Default 4. */
  lines?: number;
  moreLabel?: string;
  lessLabel?: string;
  className?: string;
  /** Class for the wrapper (text box + toggle). */
  wrapperClassName?: string;
  children: ReactNode;
}

export function ClampText({
  lines = 4,
  moreLabel = 'Show more',
  lessLabel = 'Show less',
  className,
  wrapperClassName,
  children,
}: ClampTextProps) {
  // ALL hooks unconditionally at the top (React #310).
  const textRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const id = useId();

  // Measure while clamped: is anything hidden? (A subscription callback,
  // not a synchronous setState in the effect body.)
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el || expanded) return undefined;
    const check = () => setOverflowing(el.scrollHeight > el.clientHeight + 1);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(check);
    observer?.observe(el);
    return () => observer?.disconnect();
  }, [expanded, children, lines]);

  const clamped = !expanded;
  const style = { '--lk-lines': lines } as CSSProperties;

  return (
    <div className={`lk-clamp${wrapperClassName ? ` ${wrapperClassName}` : ''}`}>
      <div
        id={id}
        ref={textRef}
        className={`lk-clamp-text${className ? ` ${className}` : ''}`}
        data-clamped={clamped}
        style={style}
      >
        {children}
      </div>
      {(overflowing || expanded) && (
        <button
          type="button"
          className={`lk-more lk-more--link lk-clamp-toggle${expanded ? ' is-open' : ''}`}
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? lessLabel : moreLabel}
          <ChevronDown className="lk-more-chev" size={14} strokeWidth={2.2} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
