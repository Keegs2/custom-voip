import { type ReactNode } from 'react';
import { cn } from '../../utils/cn';

interface PageHeaderProps {
  title: ReactNode;
  subtitle?: string;
  /** Action buttons rendered in the top-right */
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({ title, subtitle, actions, className }: PageHeaderProps) {
  return (
    <div
      className={cn(
        'glass-header',
        'flex items-start justify-between gap-4 flex-wrap',
        'mb-8 px-7 py-6',
        className,
      )}
    >
      {/* The top keyline comes from .glass-header::before (--t-keyline). */}
      <div className="relative z-[1] min-w-0">
        <h1 className="text-[1.35rem] font-bold tracking-[-0.02em] text-[color:var(--t-text-strong)] leading-tight">
          {title}
        </h1>
        {subtitle && (
          <p className="text-sm text-[color:var(--t-text-dim)] mt-1.5 leading-relaxed">{subtitle}</p>
        )}
      </div>
      {actions && (
        <div className="relative z-[1] flex items-center gap-2 flex-wrap shrink-0">
          {actions}
        </div>
      )}
    </div>
  );
}
