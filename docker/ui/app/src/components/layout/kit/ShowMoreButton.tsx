/**
 * ShowMoreButton — the "Show all N …" / "Show less" control that goes with
 * `useShowMore` (spread `buttonProps`). A real button with `aria-expanded`
 * and `aria-controls` (the list it grows). After "Show less" the button is
 * scrolled back into view, so collapsing a long list never strands the
 * reader far below the content.
 *
 *   variant "link"  inline text button (card footers, beside other links)
 *   variant "bar"   full-width quiet bar under a list/table (hairline above)
 */
import { useRef } from 'react';
import { ChevronDown } from 'lucide-react';

export interface ShowMoreButtonProps {
  expanded: boolean;
  /** Every row, shown + hidden. */
  total: number;
  onToggle: () => void;
  /** Id of the list / table body this button grows. */
  controls?: string;
  /** Plural noun for the label: "Show all 27 numbers". Default none ("Show all 27"). */
  noun?: string;
  /** Override the collapsed label entirely. */
  moreLabel?: string;
  /** Override the expanded label. Default "Show less". */
  lessLabel?: string;
  variant?: 'link' | 'bar';
  className?: string;
}

export function ShowMoreButton({
  expanded,
  total,
  onToggle,
  controls,
  noun,
  moreLabel,
  lessLabel = 'Show less',
  variant = 'link',
  className,
}: ShowMoreButtonProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const more = moreLabel ?? `Show all ${total.toLocaleString()}${noun ? ` ${noun}` : ''}`;

  const onClick = () => {
    const collapsing = expanded;
    onToggle();
    if (collapsing) {
      // After React re-renders the shorter list, bring the control back.
      requestAnimationFrame(() => ref.current?.scrollIntoView({ block: 'nearest' }));
    }
  };

  return (
    <button
      ref={ref}
      type="button"
      className={`lk-more lk-more--${variant}${expanded ? ' is-open' : ''}${className ? ` ${className}` : ''}`}
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onClick}
    >
      {expanded ? lessLabel : more}
      <ChevronDown className="lk-more-chev" size={14} strokeWidth={2.2} aria-hidden="true" />
    </button>
  );
}
