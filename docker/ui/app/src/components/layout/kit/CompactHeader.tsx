/**
 * CompactHeader — the page header as ONE tight row at desktop width:
 *
 *   ▪ CRUMB / TAIL [tag]
 *   Title [badge]                        [tools]  12 UNREAD | 40 MESSAGES  [+ Primary]
 *   One-line subtitle…
 *
 * Left: crumb, title (h1) with optional inline badges, one-line subtitle
 * (ellipsis; the full text stays in the DOM). Right, in this order: tools
 * (scope picker, filters), stats (value over a small label, hairline
 * dividers — a <dl>, read "Unread 12"), then the primary action(s). The
 * right side wraps under the title when the content column is narrow
 * (container query, so the sidebar's width is accounted for), and the
 * subtitle may wrap there.
 *
 * The look is the daylight header's (Archivo title, azure crumb tick,
 * hairline rule underneath) — theme tokens only.
 */
import type { ReactNode } from 'react';

export interface HeaderStat {
  label: string;
  value: ReactNode;
  /** Hover text for the figure (e.g. what it counts). */
  title?: string;
}

export interface CompactHeaderProps {
  /** Breadcrumb line (text, separators, an amber staff tag…). */
  crumb?: ReactNode;
  title: ReactNode;
  /** Inline next to the title: a badge, a status pill. */
  titleAside?: ReactNode;
  /** One line under the title. */
  subtitle?: ReactNode;
  /** Scope picker / filters — first on the right. */
  tools?: ReactNode;
  stats?: readonly HeaderStat[];
  /** Accessible name for the stats group. */
  statsLabel?: string;
  /** Primary action(s) — last on the right. */
  actions?: ReactNode;
  className?: string;
}

export function CompactHeader({
  crumb,
  title,
  titleAside,
  subtitle,
  tools,
  stats,
  statsLabel = 'Totals',
  actions,
  className,
}: CompactHeaderProps) {
  const hasSide = Boolean(tools) || (stats && stats.length > 0) || Boolean(actions);
  return (
    <div className="lk-head-host">
      <header className={`lk-head${className ? ` ${className}` : ''}`}>
        <div className="lk-head-id">
          {crumb && <div className="lk-head-crumb">{crumb}</div>}
          <div className="lk-head-titlerow">
            <h1 className="lk-head-title">{title}</h1>
            {titleAside}
          </div>
          {subtitle && <p className="lk-head-sub">{subtitle}</p>}
        </div>
        {hasSide && (
          <div className="lk-head-side">
            {tools && <div className="lk-head-tools">{tools}</div>}
            {stats && stats.length > 0 && (
              <dl className="lk-stats" aria-label={statsLabel}>
                {stats.map((s) => (
                  <div key={s.label} className="lk-stat" title={s.title}>
                    <dt>{s.label}</dt>
                    <dd>{s.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {actions && <div className="lk-head-actions">{actions}</div>}
          </div>
        )}
      </header>
    </div>
  );
}
