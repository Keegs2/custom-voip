/**
 * BalancedGrid — side-by-side cards whose row is ONE height. Grid cells
 * stretch to the tallest cell in their row; the kit's helper classes then
 * keep any one column from running long:
 *
 *   .lk-col      a cell that stacks several cards (flex column). Put
 *                `.lk-grow` on the card that should absorb spare height.
 *   .lk-follow   a card whose height FOLLOWS the row instead of setting it
 *                (CSS size containment, multi-column only). Its scrolling
 *                part is a `.lk-scroll` / <ScrollArea>; it never pushes the
 *                row taller than its siblings. Floor: `--lk-follow-min`.
 *   .lk-cap      a body capped at `--lk-cap` (default 440px), scrolling past.
 *
 *   <BalancedGrid columns="minmax(0,1.2fr) minmax(0,1fr)" stackBelow="md">
 *     <GreetingCard />                       ← sets the row height
 *     <div className="lk-col">
 *       <DetailsCard />
 *       <TranscriptionCard className="lk-grow" />
 *     </div>
 *   </BalancedGrid>
 *
 * Below the stack width (CONTAINER width, so it follows the space beside
 * the sidebar, not the window) every cell is full width and followers go
 * back to their natural height.
 */
import type { CSSProperties, ReactNode } from 'react';

export type StackWidth = 'sm' | 'md' | 'lg';

export interface BalancedGridProps {
  /** grid-template-columns at full width. Default two equal columns. */
  columns?: string;
  /** Container width below which cells stack: sm 560 · md 760 (default) · lg 960. */
  stackBelow?: StackWidth;
  /** Gap between cells (CSS length). Default 16px. */
  gap?: string;
  /** Floor for `.lk-follow` cards in this grid (CSS length). Default 200px. */
  followMin?: string;
  className?: string;
  /** Accessible name when the grid is a meaningful group (renders role="group"). */
  label?: string;
  children: ReactNode;
}

export function BalancedGrid({
  columns,
  stackBelow = 'md',
  gap,
  followMin,
  className,
  label,
  children,
}: BalancedGridProps) {
  const style = {
    ...(columns ? { '--lk-cols': columns } : {}),
    ...(gap ? { '--lk-gap': gap } : {}),
    ...(followMin ? { '--lk-follow-min': followMin } : {}),
  } as CSSProperties;
  return (
    <div className={`lk-grid-host lk-stack-${stackBelow}${className ? ` ${className}` : ''}`}>
      <div className="lk-grid" style={style} role={label ? 'group' : undefined} aria-label={label}>
        {children}
      </div>
    </div>
  );
}
