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
      {/* Top glass-edge accent line — light hitting the leading edge */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-8 right-8 top-0 h-px"
        style={{
          background:
            'linear-gradient(90deg, transparent, rgba(59,130,246,0.55), transparent)',
        }}
      />
      <div className="relative z-[1] min-w-0">
        <h1 className="text-[1.35rem] font-bold tracking-[-0.02em] text-[#e2e8f0] leading-tight">
          {title}
        </h1>
        {subtitle && (
          <p className="text-sm text-[#718096] mt-1.5 leading-relaxed">{subtitle}</p>
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
