/**
 * Small presentational pieces shared across the Reporting cards.
 * Components only (react-refresh friendly) — formatting lives in reportFormat.ts.
 */
import type { ReactNode } from 'react';
import { Check, ChevronDown, HelpCircle, X } from 'lucide-react';
import { ApiError } from '../../api/client';
import type { CallOutcome, QualityGrade } from '../../types/reports';
import { GRADE_TONE, GRADE_WORD } from './reportFormat';

/** "What does this mean?" — a native <details>, so Enter/Space toggle it for free. */
export function Explainer({ children, label = 'What does this mean?' }: { children: ReactNode; label?: string }) {
  return (
    <details className="rpt-explain">
      <summary>
        <HelpCircle size={13} aria-hidden="true" />
        {label}
        <ChevronDown size={13} className="rpt-explain-chev" aria-hidden="true" />
      </summary>
      <div className="rpt-explain-body">{children}</div>
    </details>
  );
}

export function Skeleton({ width = '100%', height = 14, style }: { width?: number | string; height?: number; style?: React.CSSProperties }) {
  return <span className="rpt-skel" aria-hidden="true" style={{ width, height, ...style }} />;
}

/** Lines of skeleton text inside a card body, announced once as "Loading". */
export function CardSkeleton({ lines = 3, label }: { lines?: number; label: string }) {
  return (
    <div role="status" aria-label={`Loading ${label}`} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Skeleton width="55%" height={22} />
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} width={`${90 - i * 12}%`} />
      ))}
    </div>
  );
}

/** Friendly error line + retry. Never shows raw server internals to customers. */
export function CardError({ error, onRetry, what }: { error: unknown; onRetry: () => void; what: string }) {
  const message =
    error instanceof ApiError && error.status === 422
      ? error.message
      : `We couldn’t load ${what} just now. Please try again in a moment.`;
  return (
    <div className="dl-banner dl-banner-err rpt-cardmsg" role="alert">
      <span>{message}</span>
      <button type="button" className="dl-btn dl-btn-ghost" onClick={onRetry} style={{ padding: '6px 12px' }}>
        Try again
      </button>
    </div>
  );
}

export function GradeBadge({ grade }: { grade: QualityGrade | null }) {
  if (grade == null || grade === 'none') {
    return <span className="rpt-dim" aria-label="Not measured">—</span>;
  }
  return (
    <span className="rpt-grade" style={{ color: GRADE_TONE[grade] }}>
      <span className="rpt-grade-dot" style={{ background: GRADE_TONE[grade] }} aria-hidden="true" />
      {GRADE_WORD[grade]}
    </span>
  );
}

export function OutcomeBadge({ outcome, label }: { outcome: CallOutcome; label: string }) {
  const answered = outcome === 'answered';
  return (
    <span className={answered ? 'rpt-badge rpt-badge-ok' : 'rpt-badge rpt-badge-miss'}>
      {answered ? <Check size={12} strokeWidth={2.6} aria-hidden="true" /> : <X size={12} strokeWidth={2.6} aria-hidden="true" />}
      {!answered && <span className="rpt-sr">Missed: </span>}
      {label}
    </span>
  );
}

/** Standard card chrome: title row + body + optional explainer foot. */
export function ReportCard({
  title,
  icon,
  children,
  explainer,
  headExtra,
  className,
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
  explainer?: ReactNode;
  headExtra?: ReactNode;
  className?: string;
}) {
  const headingId = `rpt-h-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return (
    <section className={`dl-panel rpt-card${className ? ` ${className}` : ''}`} aria-labelledby={headingId}>
      <div className="dl-panel-head">
        {icon && <span aria-hidden="true" style={{ display: 'inline-flex', color: 'var(--rcf-azure-deep)' }}>{icon}</span>}
        <h2 id={headingId} className="dl-panel-title" style={{ margin: 0 }}>{title}</h2>
        {headExtra}
      </div>
      <div className="dl-panel-body">
        {children}
        {explainer && <div className="rpt-card-foot"><Explainer>{explainer}</Explainer></div>}
      </div>
    </section>
  );
}
