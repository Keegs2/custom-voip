import { cn } from '../../utils/cn';

interface SpinnerProps {
  size?: 'xs' | 'sm' | 'md' | 'lg';
  className?: string;
}

const sizeClasses: Record<NonNullable<SpinnerProps['size']>, string> = {
  xs: 'w-3 h-3 border',
  sm: 'w-4 h-4 border',
  md: 'w-5 h-5 border-2',
  lg: 'w-7 h-7 border-2',
};

export function Spinner({ size = 'md', className }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn(
        'inline-block rounded-full border-[#3b82f6]/30 border-t-[#3b82f6] animate-spin flex-shrink-0',
        sizeClasses[size],
        className,
      )}
    />
  );
}

/** Centered full-page spinner for loading states */
export function CenteredSpinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-[#718096]">
      <Spinner size="lg" />
      <span className="text-sm">{label}</span>
    </div>
  );
}
