/**
 * ScrollArea — the scrolling part of a bounded pane or card (`.lk-scroll`):
 * fills the space its flex-column parent leaves (`flex: 1; min-height: 0`)
 * and scrolls vertically inside it. The pane's head and foot stay put.
 *
 * Give it `label` when it is a meaningful region; `focusable` when it may
 * hold nothing focusable (plain text), so keyboard users can still scroll
 * it (WCAG 2.1.1 — axe "scrollable-region-focusable").
 */
import type { CSSProperties, ReactNode } from 'react';

export interface ScrollAreaProps {
  className?: string;
  /** Accessible name — renders role="region". */
  label?: string;
  /** Tab stop for keyboard scrolling (content with no focusable children). */
  focusable?: boolean;
  /** Cap the height in a stacked / natural-height layout (CSS length). */
  maxHeight?: string;
  id?: string;
  children: ReactNode;
}

export function ScrollArea({ className, label, focusable = false, maxHeight, id, children }: ScrollAreaProps) {
  const style = maxHeight ? ({ '--lk-scroll-max': maxHeight } as CSSProperties) : undefined;
  return (
    <div
      id={id}
      className={`lk-scroll${className ? ` ${className}` : ''}`}
      role={label ? 'region' : undefined}
      aria-label={label}
      tabIndex={focusable ? 0 : undefined}
      style={style}
    >
      {children}
    </div>
  );
}
