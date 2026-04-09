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
        'flex items-start justify-between gap-4 flex-wrap',
        'mb-6 md:mb-8 pb-5 border-b border-[#2a2f45]',
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight text-[#e2e8f0] leading-tight">
          {title}
        </h1>
        {subtitle && (
          <p className="text-sm text-[#718096] mt-1.5">{subtitle}</p>
        )}
      </div>
      {actions && (
        <div className="flex items-center gap-2 flex-wrap shrink-0">
          {actions}
        </div>
      )}
    </div>
  );
}
