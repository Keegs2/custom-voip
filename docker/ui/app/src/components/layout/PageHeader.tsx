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
  // Spacing standard (see docs/FRONTEND_GLASS_REFACTOR.md §7): the header sits
  // flush with the layout's top offset and pushes the first section down by one
  // section-gap (mb-8 = 32px). The hairline divider uses a translucent-white
  // glass rule (matches glassSurface's 1px border) instead of an opaque line.
  return (
    <div
      className={cn(
        'flex items-start justify-between gap-4 flex-wrap',
        'mb-8 pb-5 border-b border-white/10',
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-[#e2e8f0] leading-tight">
          {title}
        </h1>
        {subtitle && (
          <p className="text-sm text-[#718096] mt-1">{subtitle}</p>
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
