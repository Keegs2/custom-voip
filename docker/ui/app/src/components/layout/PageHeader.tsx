import { type ReactNode } from 'react';
import { cn } from '../../utils/cn';

interface PageHeaderProps {
  title: string;
  /** Optional accent-coloured word appended to title */
  titleAccent?: string;
  subtitle?: string;
  /** Action buttons rendered in the top-right */
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({ title, titleAccent, subtitle, actions, className }: PageHeaderProps) {
  return (
    <div
      className={cn(
        'flex items-start justify-between gap-3 flex-wrap',
        'mb-7 pb-5 border-b border-[#2a2f45]',
        className,
      )}
    >
      <div>
        <h1 className="text-[1.45rem] font-bold tracking-[-0.3px] text-[#e2e8f0] leading-tight">
          {title}
          {titleAccent && (
            <span className="text-[#3b82f6] ml-1">{titleAccent}</span>
          )}
        </h1>
        {subtitle && (
          <p className="text-[0.82rem] text-[#718096] mt-1">{subtitle}</p>
        )}
      </div>
      {actions && (
        <div className="flex items-center gap-2 flex-wrap">
          {actions}
        </div>
      )}
    </div>
  );
}
