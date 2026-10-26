/**
 * Shared pieces of My Account: the titled daylight panel (`Section`), status
 * chips and the small loading / empty states every tab uses (formatting
 * helpers: ./format.ts). Surfaces are the daylight `dl-*` primitives (index.css); layout
 * classes are `ma-*` (styles/my-account.css). Theme tokens only (§18).
 */
import type { ReactNode } from 'react';
import { Spinner } from '../../components/ui/Spinner';

/* ─── Chips ──────────────────────────────────────────────────────────────── */

/** Green/red status pill (active vs suspended/disabled); slate tag for closed. */
export function StatusChip({ status }: { status: string }) {
  if (status === 'closed') return <span className="dl-tag dl-tag-slate">{status}</span>;
  return <span className={status === 'active' ? 'dl-pill dl-pill-on' : 'dl-pill dl-pill-off'}>{status}</span>;
}

/** On/off pill for product rows. */
export function EnabledPill({ enabled, on = 'Active', off = 'Disabled' }: { enabled: boolean; on?: string; off?: string }) {
  return <span className={enabled ? 'dl-pill dl-pill-on' : 'dl-pill dl-pill-off'}>{enabled ? on : off}</span>;
}

/* ─── Section — a titled daylight panel ──────────────────────────────────── */

export interface SectionProps {
  /** Heading id prefix (the h2 is `${id}-title`). */
  id: string;
  title: string;
  subtitle?: string;
  icon: ReactNode;
  /** Right side of the head (a count, a link). */
  actions?: ReactNode;
  /** Children sit flush against the panel edges (tables, row lists). */
  flush?: boolean;
  /** Under the body, separated by a hairline (links, notes). */
  footer?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function Section({ id, title, subtitle, icon, actions, flush, footer, className, children }: SectionProps) {
  return (
    <section className={`dl-panel ma-section${className ? ` ${className}` : ''}`} aria-labelledby={`${id}-title`}>
      <div className="dl-panel-head ma-section-head">
        <span className="ma-section-icon" aria-hidden="true">
          {icon}
        </span>
        <div className="ma-section-titles">
          <h2 id={`${id}-title`} className="dl-panel-title ma-section-title">
            {title}
          </h2>
          {subtitle && <p className="ma-section-sub">{subtitle}</p>}
        </div>
        {actions && <div className="ma-section-actions">{actions}</div>}
      </div>
      <div className={flush ? 'ma-section-flush' : 'dl-panel-body ma-section-body'}>{children}</div>
      {footer && <div className="ma-section-foot">{footer}</div>}
    </section>
  );
}

/* ─── States ─────────────────────────────────────────────────────────────── */

export function InlineEmpty({ message }: { message: string }) {
  return <div className="ma-empty">{message}</div>;
}

export function InlineLoading({ label }: { label: string }) {
  return (
    <div className="ma-loading">
      <Spinner size="sm" />
      <span>{label}</span>
    </div>
  );
}
