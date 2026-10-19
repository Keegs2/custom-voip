/**
 * Card — the dashboard's one surface: white, 14px radius, hairline border,
 * layered cool shadow with a 1px inner top highlight (styles in
 * account-dashboard.css). Each card owns its own loading / error / empty
 * state so one failing feed never takes the rest of the page down.
 */
import type { CSSProperties, ReactNode } from 'react';
import { Spinner } from '../../components/ui/Spinner';

export interface CardProps {
  /** Unique id prefix — the heading is `${id}-title`. */
  id: string;
  title: string;
  /** Small tinted icon chip before the title. */
  icon?: ReactNode;
  /** Count pill after the title. */
  count?: number | null;
  /** Right side of the header (a link or quiet button). */
  action?: ReactNode;
  /** One-line description under the title. */
  sub?: string;
  footer?: ReactNode;
  /** Grid placement + extra modifiers, e.g. "ad-span-8 ad-card-numbers". */
  className?: string;
  /** Load-in stagger slot (0-based); see .ad-rise. */
  order: number;
  children: ReactNode;
}

export function Card({ id, title, icon, count, action, sub, footer, className, order, children }: CardProps) {
  return (
    <section
      className={`ad-card ad-rise${className ? ` ${className}` : ''}`}
      style={{ '--i': order } as CSSProperties}
      aria-labelledby={`${id}-title`}
    >
      <header className="ad-card-head">
        <div className="ad-card-heading">
          {icon && <span className="ad-chip" aria-hidden="true">{icon}</span>}
          <div className="ad-card-titles">
            <h2 id={`${id}-title`} className="ad-card-title">
              {title}
              {count != null && <span className="ad-count">{count.toLocaleString()}</span>}
            </h2>
            {sub && <p className="ad-card-sub">{sub}</p>}
          </div>
        </div>
        {action && <div className="ad-card-action">{action}</div>}
      </header>
      <div className="ad-card-body">{children}</div>
      {footer && <footer className="ad-card-foot">{footer}</footer>}
    </section>
  );
}

export interface CardStateProps {
  kind: 'loading' | 'error';
  children: string;
  onRetry?: () => void;
}

/** Inline loading / error line for a card body. */
export function CardState({ kind, children, onRetry }: CardStateProps) {
  return (
    <div
      className={`ad-state${kind === 'error' ? ' ad-state-error' : ''}`}
      role={kind === 'error' ? 'alert' : 'status'}
    >
      {kind === 'loading' && <Spinner size="sm" />}
      <span>{children}</span>
      {onRetry && (
        <button type="button" className="ad-linkbtn" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}
