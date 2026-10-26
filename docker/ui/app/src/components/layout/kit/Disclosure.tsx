/**
 * Disclosure — an expandable section: one compact summary row (title,
 * optional count / badge / one-line summary, chevron) that opens to the
 * full content. WAI-ARIA disclosure pattern: the row is a real <button>
 * inside a heading, `aria-expanded` + `aria-controls`; Enter / Space toggle
 * it (native button). The content animates its height (CSS grid 0fr → 1fr)
 * and does not animate under `prefers-reduced-motion`. While closed the
 * content is `visibility: hidden`, so nothing inside can take focus or be
 * read out.
 *
 *   <Disclosure title="PIN" summary="Not set · for phone access later" persistKey="vm:pin">
 *     <PinForm … />
 *   </Disclosure>
 *
 * Variants (look only — the behaviour is identical):
 *   card  a raised panel of its own (theme panel recipe)
 *   row   a hairline-divided row inside a panel you already have — stack
 *         several in one `.dl-panel` / dashboard card for a settings list
 *   bare  no chrome: a quiet text toggle ("How is this worked out?")
 *
 * `actions` sit on the header row but OUTSIDE the toggle button (a button
 * may not contain buttons). `persistKey` remembers the state per section in
 * localStorage (convenience only — see openState.ts). `lazy` mounts the
 * content on first open (then keeps it), for content that fetches.
 */
import { useId, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { useOpenState, type OpenStateOptions } from './openState';

export type DisclosureVariant = 'card' | 'row' | 'bare';

export interface DisclosureProps extends OpenStateOptions {
  title: ReactNode;
  /** One line shown on the row, open or closed (counts, current value). */
  summary?: ReactNode;
  /** Small pill after the title (a number or short word). */
  count?: ReactNode;
  /** Tag after the title (e.g. a "Staff" marker). Part of the button's name. */
  badge?: ReactNode;
  /** Icon chip before the title. Decorative. */
  icon?: ReactNode;
  /** Controls on the header row, outside the toggle button. */
  actions?: ReactNode;
  /** Heading level of the row (document outline). Default 3. */
  headingLevel?: 2 | 3 | 4 | 5;
  variant?: DisclosureVariant;
  /** Mount the content on first open instead of up front. */
  lazy?: boolean;
  className?: string;
  /** Extra class on the content box (padding is the kit's by default). */
  contentClassName?: string;
  /** Stable id for the content region (default: generated). */
  id?: string;
  children: ReactNode;
}

export function Disclosure({
  title,
  summary,
  count,
  badge,
  icon,
  actions,
  headingLevel = 3,
  variant = 'card',
  lazy = false,
  className,
  contentClassName,
  id,
  children,
  defaultOpen,
  open: openProp,
  onOpenChange,
  persistKey,
}: DisclosureProps) {
  // ALL hooks unconditionally at the top (React #310).
  const [open, setOpen] = useOpenState({ defaultOpen, open: openProp, onOpenChange, persistKey });
  // Lazy content stays mounted once it has been opened (no flash on re-open,
  // and a smooth close). Seeded from the first render's state.
  const [opened, setOpened] = useState(open);
  const autoId = useId();
  const regionId = id ?? `lk-disc-${autoId}`;
  const buttonId = `${regionId}-btn`;

  const toggle = () => {
    const next = !open;
    if (next) setOpened(true);
    setOpen(next);
  };

  const Heading = `h${headingLevel}` as const;
  const mounted = !lazy || open || opened;

  return (
    <section className={`lk-disc lk-disc--${variant}${open ? ' is-open' : ''}${className ? ` ${className}` : ''}`}>
      <div className="lk-disc-head">
        <Heading className="lk-disc-heading">
          <button
            type="button"
            id={buttonId}
            className="lk-disc-toggle"
            aria-expanded={open}
            aria-controls={regionId}
            onClick={toggle}
          >
            {icon && (
              <span className="lk-disc-icon" aria-hidden="true">
                {icon}
              </span>
            )}
            <span className="lk-disc-titles">
              <span className="lk-disc-title">
                {title}
                {count != null && <span className="lk-disc-count">{count}</span>}
                {badge}
              </span>
              {summary != null && <span className="lk-disc-summary">{summary}</span>}
            </span>
            <ChevronDown className="lk-disc-chev" size={16} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </Heading>
        {actions && <div className="lk-disc-actions">{actions}</div>}
      </div>
      <div className="lk-disc-panel" id={regionId} role="region" aria-labelledby={buttonId} data-open={open}>
        <div className="lk-disc-inner">
          <div className={`lk-disc-content${contentClassName ? ` ${contentClassName}` : ''}`}>{mounted ? children : null}</div>
        </div>
      </div>
    </section>
  );
}
